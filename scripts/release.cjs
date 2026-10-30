// A version-tag push is the release authorization; publishing never accepts manual switches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PUBLIC_SCOPE,
  PACKAGES,
  assert,
  json,
  save,
  integrity,
  run,
  npm,
  options,
  checkMetadata,
  checkArchive,
  stage,
} = require('./release-tools.cjs');

const REGISTRY = 'https://registry.npmjs.org/';
const NUMBER = '(0|[1-9][0-9]*)';
const IDENTIFIER = '(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`,
);
const CAPTURE = { capture: true };

function tagContext(root, env = process.env, execute = run) {
  assert(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_EVENT_NAME === 'push' &&
      env.GITHUB_REF_TYPE === 'tag' &&
      env.GITHUB_REF === 'refs/tags/' + env.GITHUB_REF_NAME,
    'Publishing requires a GitHub tag push',
  );
  const pkg = json(path.join(root, 'package.json'));
  checkMetadata(pkg);
  assert(
    VERSION.test(pkg.version) && env.GITHUB_REF_NAME === 'v' + pkg.version,
    'Version tag must match the canonical package.json version',
  );
  const repo = PACKAGES.find(([, name]) => pkg.name === PUBLIC_SCOPE + '/' + name)[0];
  assert(
    env.GITHUB_REPOSITORY === 'cloud-idaas/' + repo,
    'Release repository does not match package metadata',
  );
  const git = (args) => execute('git', args, root, CAPTURE).trim();
  const commit = git(['rev-parse', 'HEAD']);
  assert(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ''), 'Missing GitHub source commit');
  assert(
    git(['rev-parse', '--verify', env.GITHUB_REF + '^{commit}']) === commit &&
      git(['rev-parse', '--verify', env.GITHUB_SHA + '^{commit}']) === commit,
    'Tag, checked-out source, and GitHub event must identify the same commit',
  );
  assert(!git(['status', '--porcelain']), 'Release source must be a clean checkout');
  return { pkg, repo, commit, tag: env.GITHUB_REF_NAME };
}

function sdkDependencies(pkg) {
  return Object.entries(pkg.dependencies || {}).filter(([name]) =>
    name.startsWith(PUBLIC_SCOPE + '/'),
  );
}

function published(name, version, cwd, execute = npm) {
  let output;
  try {
    output = execute(
      ['view', name + '@' + version, 'dist', '--json', '--registry=' + REGISTRY],
      cwd,
      CAPTURE,
    );
  } catch (error) {
    if (/\bE404\b/.test(error.message)) return null;
    throw new Error('Unable to read npm metadata for ' + name + '@' + version);
  }
  const value = JSON.parse(output);
  assert(
    value &&
      typeof value.integrity === 'string' &&
      /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity),
    'Published package has no valid SHA-512 integrity',
  );
  return value;
}

async function fetchUpstreams(pkg, directory, cwd, hooks = {}) {
  const execute = hooks.npm || npm;
  const sleep = hooks.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const inspect = hooks.checkArchive || checkArchive;
  const result = [];
  for (const [name, version] of sdkDependencies(pkg)) {
    let metadata;
    for (let attempt = 0; attempt < 21; attempt++) {
      metadata = published(name, version, cwd, execute);
      if (metadata) break;
      assert(attempt < 20, 'Timed out waiting for upstream ' + name + '@' + version);
      (hooks.log || console.log)('Waiting for published upstream ' + name + '@' + version);
      await sleep(30000);
    }
    const packed = JSON.parse(
      execute(
        [
          'pack',
          name + '@' + version,
          '--ignore-scripts',
          '--json',
          '--registry=' + REGISTRY,
          '--pack-destination',
          directory,
        ],
        cwd,
        CAPTURE,
      ),
    )[0];
    assert(
      packed && packed.filename === path.basename(packed.filename),
      'Invalid upstream archive filename',
    );
    const file = path.join(directory, packed.filename);
    assert(
      integrity(file) === metadata.integrity,
      'Downloaded upstream integrity does not match npm',
    );
    const { pkg: upstream } = inspect(file, PUBLIC_SCOPE, { developerText: false });
    assert(
      upstream.name === name && upstream.version === version,
      'Downloaded upstream name or version mismatch',
    );
    result.push({ name, version, integrity: metadata.integrity });
  }
  return result;
}

function verifyConsumer(file, pkg, directory, upstreamDirectory) {
  const consumer = path.join(directory, 'consumer');
  fs.mkdirSync(consumer);
  save(path.join(consumer, 'package.json'), {
    name: 'idaas-release-consumer',
    private: true,
    version: '0.0.0',
    devDependencies: { typescript: '4.7.4', '@types/node': '20.14.8' },
  });
  for (const ext of ['cts', 'mts']) {
    fs.writeFileSync(
      path.join(consumer, 'consumer.' + ext),
      `import * as sdk from ${JSON.stringify(pkg.name)};\nexport const publicApi: typeof sdk = sdk;\n`,
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
  fs.writeFileSync(
    path.join(consumer, 'runtime.cjs'),
    `
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
async function main() {
  const sdk = require(${JSON.stringify(pkg.name)});
  const esm = await import(${JSON.stringify(pkg.name)});
  assert(Object.keys(sdk).length > 0);
  for (const key of Object.keys(sdk)) assert.equal(sdk[key], esm[key], key);
  if (sdk.StaticClientSecretAssertionProvider) {
    const secret = '0123456789abcdef0123456789abcdef';
    const jwt = await new sdk.StaticClientSecretAssertionProvider(secret).getClientAssertion({clientId: 'example', tokenEndpoint: 'https://issuer.example/token'});
    const [header, payload, signature] = jwt.split('.');
    assert.equal(crypto.createHmac('sha256', secret).update(header + '.' + payload).digest('base64url'), signature);
  }
  console.log('Packed package compatibility passed: ' + process.version);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
`,
  );
  const upstreamFiles = fs
    .readdirSync(upstreamDirectory)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(upstreamDirectory, name));
  npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=' + REGISTRY,
      file,
      ...upstreamFiles,
    ],
    consumer,
    CAPTURE,
  );
  run(
    process.execPath,
    [path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    consumer,
    CAPTURE,
  );
  const versions = ['20.0.0', '22.0.0', '24.3.0'];
  for (const version of versions) {
    const output = npm(
      [
        'exec',
        '--yes',
        '--registry=' + REGISTRY,
        '--package=node@' + version,
        '--',
        'node',
        'runtime.cjs',
      ],
      consumer,
      CAPTURE,
    );
    assert(
      output.includes('Packed package compatibility passed: v' + version),
      'Consumer runtime version mismatch',
    );
    console.log('Packed package passed TypeScript 4.7.4 and Node ' + version + ': ' + pkg.name);
  }
  return { typescript: '4.7.4', nodeVersions: versions, commonjs: true, esm: true };
}

async function prepare(root, directory, env = process.env, hooks = {}) {
  const context = tagContext(root, env, hooks.run || run);
  directory = path.resolve(directory);
  assert(
    directory !== root && !directory.startsWith(root + path.sep),
    'Release output must be outside the source checkout',
  );
  fs.mkdirSync(directory, { recursive: true });
  assert(fs.readdirSync(directory).length === 0, 'Release output directory must be empty');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'idaas-tag-release-'));
  try {
    const work = path.join(temp, 'source');
    const upstreams = path.join(temp, 'upstreams');
    fs.mkdirSync(work);
    fs.mkdirSync(upstreams);
    // Copy only tracked source; ignored local files and authentication configuration stay outside the candidate.
    const names = (hooks.run || run)('git', ['ls-files', '-z'], root, CAPTURE)
      .split('\0')
      .filter(Boolean);
    for (const name of names) {
      const source = path.join(root, name);
      assert(!fs.lstatSync(source).isSymbolicLink(), 'Release source must not contain symlinks');
      fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
      fs.copyFileSync(source, path.join(work, name));
    }
    const dependencies = await fetchUpstreams(context.pkg, upstreams, work, hooks);
    stage(work, upstreams);
    npm(
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=' + REGISTRY],
      work,
      CAPTURE,
    );
    const verified = npm(['run', 'verify'], work, CAPTURE);
    fs.writeFileSync(path.join(directory, 'verify.log'), verified);
    const packed = JSON.parse(
      npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], work, CAPTURE),
    )[0];
    const file = path.join(directory, packed.filename);
    checkArchive(file);
    const compatibility = verifyConsumer(file, context.pkg, temp, upstreams);
    assert(
      tagContext(root, env).commit === context.commit,
      'Release source changed during verification',
    );
    save(path.join(directory, 'manifest.json'), {
      format: 1,
      repo: context.repo,
      name: context.pkg.name,
      version: context.pkg.version,
      tag: context.tag,
      commit: context.commit,
      file: packed.filename,
      integrity: integrity(file),
      dependencies,
      compatibility,
    });
    console.log('Verified release candidate: ' + packed.filename);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function compareVersions(first, second) {
  assert(VERSION.test(first) && VERSION.test(second), 'Invalid npm channel version');
  const parse = (value) => {
    const index = value.indexOf('-');
    return {
      numbers: (index < 0 ? value : value.slice(0, index)).split('.').map(BigInt),
      pre: index < 0 ? [] : value.slice(index + 1).split('.'),
    };
  };
  const a = parse(first);
  const b = parse(second);
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === b.pre[i]) continue;
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === undefined ? -1 : 1;
    const numericA = /^\d+$/.test(a.pre[i]);
    const numericB = /^\d+$/.test(b.pre[i]);
    if (numericA && numericB) return BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a.pre[i] > b.pre[i] ? 1 : -1;
  }
  return 0;
}

function publishChannel(pkg, root, execute = npm) {
  const channel = pkg.version.includes('-') ? 'beta' : 'latest';
  let tags;
  try {
    tags = JSON.parse(
      execute(['view', pkg.name, 'dist-tags', '--json', '--registry=' + REGISTRY], root, CAPTURE),
    );
  } catch (error) {
    if (/\bE404\b/.test(error.message)) return channel;
    throw new Error('Unable to read npm distribution tags');
  }
  assert(tags && typeof tags === 'object' && !Array.isArray(tags), 'Invalid npm distribution tags');
  if (tags[channel] !== undefined) {
    assert(
      typeof tags[channel] === 'string' && VERSION.test(tags[channel]),
      'Invalid npm channel version',
    );
  }
  // Backfills remain installable by exact version without moving the default channel backwards.
  return tags[channel] && compareVersions(pkg.version, tags[channel]) < 0
    ? 'release-' + pkg.version
    : channel;
}

function publish(root, directory, env = process.env, hooks = {}) {
  const context = tagContext(root, env, hooks.run || run);
  assert(
    env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'Missing GitHub OIDC publishing identity',
  );
  const manifest = json(path.join(directory, 'manifest.json'));
  assert(
    manifest.format === 1 &&
      manifest.repo === context.repo &&
      manifest.commit === context.commit &&
      manifest.tag === context.tag &&
      manifest.name === context.pkg.name &&
      manifest.version === context.pkg.version,
    'Release candidate does not match the verified tag and source',
  );
  const expectedFile =
    context.pkg.name.slice(1).replace('/', '-') + '-' + context.pkg.version + '.tgz';
  assert(manifest.file === expectedFile, 'Invalid release candidate filename');
  const file = path.join(directory, expectedFile);
  assert(integrity(file) === manifest.integrity, 'Release candidate integrity mismatch');
  const { pkg } = (hooks.checkArchive || checkArchive)(file);
  assert(
    pkg.name === context.pkg.name &&
      pkg.version === context.pkg.version &&
      JSON.stringify(Object.entries(pkg.dependencies || {}).sort()) ===
        JSON.stringify(Object.entries(context.pkg.dependencies || {}).sort()),
    'Candidate package metadata differs from the source',
  );
  const execute = hooks.npm || npm;
  const expectedDependencies = sdkDependencies(context.pkg);
  assert(
    Array.isArray(manifest.dependencies) &&
      manifest.dependencies.length === expectedDependencies.length,
    'Release upstream evidence is incomplete',
  );
  for (const [name, version] of expectedDependencies) {
    const evidence = manifest.dependencies.find(
      (item) => item.name === name && item.version === version,
    );
    const actual = published(name, version, root, execute);
    assert(
      evidence && actual && actual.integrity === evidence.integrity,
      'Published upstream changed after verification',
    );
  }
  const existing = published(pkg.name, pkg.version, root, execute);
  if (existing) {
    assert(
      existing.integrity === manifest.integrity,
      'This package version already exists with different contents',
    );
    console.log('Identical package version is already published: ' + pkg.name + '@' + pkg.version);
    return;
  }
  execute(
    [
      'publish',
      file,
      '--ignore-scripts',
      '--access=public',
      '--tag=' + publishChannel(pkg, root, execute),
      '--registry=' + REGISTRY,
    ],
    root,
  );
}

module.exports = {
  VERSION,
  tagContext,
  sdkDependencies,
  published,
  fetchUpstreams,
  verifyConsumer,
  prepare,
  compareVersions,
  publishChannel,
  publish,
};
if (require.main === module) {
  (async () => {
    const command = process.argv[2];
    const args = options(process.argv.slice(3));
    assert(
      Object.keys(args).every((key) => key === 'directory') && args.directory,
      'Provide only --directory for the release candidate',
    );
    const root = path.resolve(__dirname, '..');
    if (command === 'prepare') await prepare(root, args.directory);
    else if (command === 'publish') publish(root, path.resolve(args.directory));
    else throw new Error('Unknown release command');
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
