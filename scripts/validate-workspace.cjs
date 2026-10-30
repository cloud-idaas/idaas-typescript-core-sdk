const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  PACKAGES,
  PUBLIC_SCOPE,
  assert,
  json,
  save,
  integrity,
  npm,
  run,
  options,
  registry,
  stage,
  checkMetadata,
  checkArchive,
  internal,
} = require('./release-tools.cjs');

async function main() {
  const args = options(process.argv.slice(2));
  const allowed = [
    'workspace',
    'out',
    'registry',
    'internal-scope',
    'internal-registry',
    'node-versions',
    'target',
  ];
  assert(
    Object.keys(args).every((key) => allowed.includes(key)),
    'Unknown validation argument',
  );
  assert(
    process.versions.node.split('.')[0] === '24',
    'Use Node.js 24 for build validation; consumer validation separately checks 20/22/24',
  );
  assert(
    Boolean(args['internal-scope']) === Boolean(args['internal-registry']),
    'Provide internal scope and registry together',
  );
  const source = path.resolve(args.workspace || path.join(__dirname, '../..'));
  assert(
    npm(['--version'], source, { capture: true }).trim() === '11.21.1',
    'Use the pinned npm 11.21.1 for workspace validation',
  );
  const selectedNames = new Set();
  const visiting = new Set();
  function visit(repo) {
    assert(
      PACKAGES.some(([name]) => name === repo),
      'Unknown target repository',
    );
    assert(!visiting.has(repo), 'Circular SDK dependency');
    if (selectedNames.has(repo)) return;
    visiting.add(repo);
    const pkg = json(path.join(source, repo, 'package.json'));
    for (const name of Object.keys(pkg.dependencies || {})) {
      if (!name.startsWith(PUBLIC_SCOPE + '/')) continue;
      const entry = PACKAGES.find(([, suffix]) => name === PUBLIC_SCOPE + '/' + suffix);
      assert(entry, 'Unknown upstream SDK dependency');
      visit(entry[0]);
    }
    visiting.delete(repo);
    selectedNames.add(repo);
  }
  if (args.target) visit(args.target);
  else for (const [repo] of PACKAGES) selectedNames.add(repo);
  const selected = PACKAGES.filter(([repo]) => selectedNames.has(repo));
  const output = path.resolve(args.out || path.join(os.tmpdir(), 'idaas-sdk-validation'));
  const endpoint = registry(
    args.registry || process.env.npm_config_registry || 'https://registry.npmjs.org/',
  );
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'run-'));
  const artifactDir = path.join(root, 'public');
  fs.mkdirSync(artifactDir);
  const manifest = {
    format: 1,
    mode: args.target ? 'repository' : 'workspace',
    target: args.target || null,
    node: process.version,
    registry: endpoint,
    sources: {},
    packages: [],
    verification: {},
  };
  for (const [repo] of selected) {
    const from = path.join(source, repo);
    assert(fs.existsSync(path.join(from, 'package.json')), `Missing repository ${repo}`);
    assert(
      !output.startsWith(from + path.sep),
      'Output directory must be outside SDK source repositories',
    );
    manifest.sources[repo] = {
      commit: run('git', ['rev-parse', 'HEAD'], from, { capture: true }).trim(),
      dirty: Boolean(run('git', ['status', '--porcelain'], from, { capture: true }).trim()),
    };
    const dest = path.join(root, 'workspace', repo);
    fs.cpSync(from, dest, {
      recursive: true,
      filter(file) {
        const relative = path.relative(from, file);
        const segments = relative.split(path.sep);
        return !segments.some(
          (part) =>
            [
              '.git',
              'node_modules',
              'dist',
              'build',
              'coverage',
              '.nyc_output',
              '.sdk-artifacts',
              '.cache',
              '.codegraph',
              '.DS_Store',
              '.npmrc',
            ].includes(part) ||
            /^\.env(?:\.|$)/.test(part) ||
            part.endsWith('.tgz'),
        );
      },
    });
  }
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs);
  for (const [repo] of selected) {
    const cwd = path.join(root, 'workspace', repo);
    checkMetadata(json(path.join(cwd, 'package.json')));
    stage(cwd, artifactDir);
    npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=' + endpoint], cwd, {
      capture: true,
    });
    const tested = !args.target || repo === args.target;
    const verified = npm(['run', tested ? 'verify' : 'build'], cwd, { capture: true });
    fs.writeFileSync(path.join(logs, repo + '.log'), verified);
    const count = /([0-9]+) passing/.exec(verified);
    assert(!tested || count, repo + ': No passing test count was found');
    const result = JSON.parse(
      npm(['pack', '--json', '--pack-destination', artifactDir], cwd, { capture: true }),
    )[0];
    const archive = path.join(artifactDir, result.filename);
    const { pkg } = checkArchive(archive, PUBLIC_SCOPE, { developerText: tested });
    manifest.packages.push({
      repo,
      name: pkg.name,
      version: pkg.version,
      file: archive,
      integrity: integrity(archive),
    });
    manifest.verification[repo] = {
      tests: tested ? Number(count[1]) : null,
      tested,
      strictTypes: tested,
      lint: tested,
      format: tested,
      build: true,
    };
    console.log(
      `${repo}: ${tested ? 'verify ' + count[1] + ' tests passed' : 'upstream build only'}, public candidate ${result.filename}`,
    );
  }
  if (args.target) {
    save(path.join(root, 'manifest.json'), manifest);
    save(path.join(output, 'latest.json'), { manifest: path.join(root, 'manifest.json') });
    console.log(
      'Repository validation complete (upstreams built only; no workspace integration or publishing): ' +
        path.join(root, 'manifest.json'),
    );
    return;
  }
  const profiles = [{ name: 'public', scope: PUBLIC_SCOPE, packages: manifest.packages }];
  if (args['internal-scope']) {
    const packages = manifest.packages.map((item) => {
      const file = internal(
        item.file,
        args['internal-scope'],
        args['internal-registry'],
        path.join(root, 'internal'),
      );
      const { pkg } = checkArchive(file, args['internal-scope']);
      return { ...item, name: pkg.name, file, integrity: integrity(file) };
    });
    profiles.push({
      name: 'internal',
      scope: args['internal-scope'],
      registry: registry(args['internal-registry']),
      packages,
    });
  }
  const versions = (args['node-versions'] || '20.0.0,22.0.0,24.3.0').split(',');
  assert(
    versions.every((value) => /^(20|22|24)\.[0-9]+\.[0-9]+$/.test(value)),
    'Consumer Node versions must specify exact 20/22/24 patch versions',
  );
  for (const profile of profiles) {
    const consumer = path.join(root, 'consumer-' + profile.name);
    fs.mkdirSync(consumer);
    save(path.join(consumer, 'package.json'), {
      name: 'idaas-sdk-validation-consumer',
      private: true,
      version: '0.0.0',
      devDependencies: { typescript: '4.7.4', '@types/node': '20.14.8' },
    });
    for (const fixture of ['consumer.cts', 'consumer.mts', 'runtime-smoke.cjs']) {
      fs.writeFileSync(
        path.join(consumer, fixture),
        fs
          .readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8')
          .replaceAll(PUBLIC_SCOPE + '/', profile.scope + '/')
          .replace("|| '@cloud-idaas'", "|| '" + profile.scope + "'"),
      );
    }
    save(path.join(consumer, 'tsconfig.json'), {
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        target: 'ES2019',
        module: 'Node16',
        moduleResolution: 'Node16',
        noEmit: true,
      },
      include: ['*.cts', '*.mts'],
    });
    npm(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry=' + endpoint,
        ...profile.packages.map((item) => item.file),
      ],
      consumer,
      { capture: true },
    );
    run(
      process.execPath,
      [path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
      consumer,
      { capture: true },
    );
    for (const version of versions) {
      const log = npm(
        [
          'exec',
          '--yes',
          '--registry=' + endpoint,
          '--package=node@' + version,
          '--',
          'node',
          'runtime-smoke.cjs',
        ],
        consumer,
        { capture: true },
      );
      assert(
        log.includes('Runtime compatibility passed: v' + version + ','),
        'Actual consumer Node version does not match the requested version',
      );
      fs.writeFileSync(path.join(logs, profile.name + '-node-' + version + '.log'), log);
      console.log(`${profile.name}: Node ${version} package consumer validation passed`);
    }
    profile.typescript = '4.7.4';
    profile.nodeVersions = versions;
    for (const item of profile.packages)
      assert(
        integrity(item.file) === item.integrity,
        'Candidate changed during consumer validation',
      );
  }
  const blocked = require('node:child_process').spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'release.cjs'),
      'publish',
      '--directory',
      path.join(root, 'not-a-release'),
    ],
    { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request' } },
  );
  assert(
    blocked.status !== 0 && blocked.stderr.includes('Publishing requires a GitHub tag push'),
    'The non-tag publishing guard failed',
  );
  for (const profile of profiles.filter((value) => value.name !== 'public')) {
    for (const item of profile.packages) {
      let rejected = false;
      try {
        checkArchive(item.file);
      } catch {
        rejected = true;
      }
      assert(rejected, 'Public release validation must reject internal candidates');
    }
  }
  manifest.releaseGuards = {
    nonTagPublishBlocked: true,
    internalArtifactsRejectedByPublicCheck: profiles.some((value) => value.name === 'internal'),
  };
  manifest.profiles = profiles;
  save(path.join(root, 'manifest.json'), manifest);
  save(path.join(output, 'latest.json'), { manifest: path.join(root, 'manifest.json') });
  console.log(
    'All validation complete; nothing published. Manifest: ' + path.join(root, 'manifest.json'),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
