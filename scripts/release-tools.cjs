const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PUBLIC_SCOPE = '@cloud-idaas';
const PACKAGES = [
  ['idaas-typescript-core-sdk', 'core-sdk'],
  ['idaas-typescript-pam-client-sdk', 'pam-client-sdk'],
  [
    'idaas-typescript-core-alibabacloud-authentication-plugin',
    'core-alibabacloud-authentication-plugin',
  ],
  ['idaas-typescript-akless-alibabacloud-adapter', 'akless-alibabacloud-adapter'],
  ['idaas-typescript-akless-aws-adapter', 'akless-aws-adapter'],
  ['idaas-typescript-akless-tencent-adapter', 'akless-tencent-adapter'],
];
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function integrity(file) {
  return 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}
function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: process.env,
    shell: false,
  });
  assert(
    result.status === 0,
    `${command} ${args[0]} failed (${result.status})${options.capture ? ': ' + (result.stdout + result.stderr).slice(-6000) : ''}`,
  );
  return options.capture ? result.stdout : '';
}
function npm(args, cwd, options) {
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, options);
}
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(
      /^--[a-z-]+$/.test(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'),
      'Arguments must use --name value pairs',
    );
    assert(!(args[i].slice(2) in result), 'Duplicate argument');
    result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}
function registry(value) {
  const url = new URL(value);
  assert(
    url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)),
    'Registry must use HTTPS except for localhost tests',
  );
  assert(
    !url.username && !url.password && !url.search && !url.hash,
    'Registry must not contain credentials, a query, or a fragment',
  );
  return url.href.replace(/\/?$/, '/');
}
// Read regular npm pack entries only; validate paths and types before inspection or extraction.
function readArchive(file) {
  const tar = zlib.gunzipSync(fs.readFileSync(file));
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const field = (start, size) =>
      header
        .subarray(start, start + size)
        .toString()
        .replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = (prefix ? prefix + '/' : '') + field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    assert(
      Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length,
      'Invalid archive length',
    );
    assert(
      name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('\\'),
      'Invalid archive path',
    );
    assert(
      ['', '0', '5'].includes(type),
      'Candidate archives must not contain links or extended entry types',
    );
    if (type !== '5') {
      assert(!files.has(name), 'Archive contains duplicate paths');
      files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(files.has('package/package.json'), 'Archive is missing package.json');
  return { files, pkg: JSON.parse(files.get('package/package.json').toString()) };
}
function checkMetadata(pkg) {
  assert(
    PACKAGES.some(([, name]) => pkg.name === `${PUBLIC_SCOPE}/${name}`),
    'Release package name is not one of the six public SDK packages',
  );
  assert(
    pkg.private !== true && pkg.license === 'Apache-2.0',
    'An Apache-2.0 package eligible for publishing is required',
  );
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), 'Invalid version');
  const repo = PACKAGES.find(([, name]) => pkg.name === `${PUBLIC_SCOPE}/${name}`)[0];
  assert(
    pkg.repository?.url === `https://github.com/cloud-idaas/${repo}.git`,
    'repository.url does not match the GitHub repository',
  );
  assert(
    pkg.publishConfig?.access === 'public' &&
      pkg.publishConfig.registry === 'https://registry.npmjs.org/',
    'Invalid public publish target',
  );
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    assert(
      !/^(file:|link:|workspace:)/.test(version),
      'Runtime dependencies must not contain local paths',
    );
    if (name.startsWith(PUBLIC_SCOPE + '/'))
      assert(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
        'Upstream SDK dependencies must pin exact versions',
      );
  }
}
function checkArchive(file, scope = PUBLIC_SCOPE, { developerText = true } = {}) {
  const data = readArchive(file);
  for (const name of [
    'package.json',
    'LICENSE',
    'README.md',
    ...(developerText ? ['README_zh.md'] : []),
    'CHANGELOG.md',
    'dist/index.js',
    'dist/index.mjs',
    'dist/index.d.ts',
    'dist/index.d.mts',
  ]) {
    assert(data.files.has('package/' + name), 'Candidate is missing ' + name);
  }
  assert(
    data.pkg.name.startsWith(scope + '/') &&
      data.pkg.license === 'Apache-2.0' &&
      data.pkg.private !== true,
    'Invalid candidate name or license',
  );
  assert(
    data.files.get('package/LICENSE').toString().includes('Version 2.0, January 2004'),
    'Invalid LICENSE',
  );
  for (const [name, body] of data.files) {
    assert(
      !/(?:^|\/)(?:node_modules|test|\.git|\.env)(?:\/|$)/.test(name),
      'Archive contains development or local files',
    );
    assert(!name.endsWith('.pem'), 'Archive must not contain test private keys');
    if (/\.(?:js|cjs|mjs|ts|mts|map|json|md)$/.test(name)) {
      assert(
        !body.toString().includes('@idaas-sdk-dev/'),
        'Candidate contains the development scope',
      );
      if (developerText && name !== 'package/README_zh.md')
        assert(
          !/\p{Script=Han}/u.test(body.toString()),
          'Candidate contains non-English developer text: ' + name,
        );
      if (scope !== PUBLIC_SCOPE && /\.(?:js|cjs|mjs|ts|mts|map)$/.test(name))
        assert(
          !body.toString().includes(PUBLIC_SCOPE + '/'),
          'Internal candidate contains public module references',
        );
    }
  }
  if (scope === PUBLIC_SCOPE) checkMetadata(data.pkg);
  for (const [name, version] of Object.entries(data.pkg.dependencies || {})) {
    assert(
      !/^(file:|link:|workspace:)/.test(version),
      'Candidate runtime dependencies still contain local paths',
    );
    if (name.startsWith(scope + '/'))
      assert(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
        'Internal SDK dependencies must pin exact versions',
      );
  }
  return data;
}
function stage(root, source) {
  const pkg = json(path.join(root, 'package.json'));
  const lockFile = path.join(root, 'package-lock.json');
  const lock = json(lockFile);
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    if (!name.startsWith(PUBLIC_SCOPE + '/')) continue;
    assert(source, 'Provide the controlled candidate directory');
    const file = path.join(source, name.slice(1).replace('/', '-') + '-' + version + '.tgz');
    // Historical upstream candidates may predate the English documentation policy.
    // Keep metadata, dependency, and integrity validation strict.
    const { pkg: upstream } = checkArchive(file, PUBLIC_SCOPE, { developerText: false });
    assert(
      upstream.name === name && upstream.version === version,
      'Candidate name or version does not match',
    );
    const local = '.sdk-artifacts/' + name.split('/')[1] + '.tgz';
    fs.mkdirSync(path.join(root, '.sdk-artifacts'), { recursive: true });
    fs.copyFileSync(file, path.join(root, local));
    const entry = lock.packages['node_modules/' + name];
    assert(entry && entry.version === version, 'Lockfile is missing an upstream candidate entry');
    assert(
      JSON.stringify(Object.entries(entry.dependencies || {}).sort()) ===
        JSON.stringify(Object.entries(upstream.dependencies || {}).sort()),
      'Candidate upstream dependencies changed; explicitly rebuild and review the lockfile',
    );
    Object.assign(entry, {
      resolved: 'file:' + local,
      integrity: integrity(file),
      license: upstream.license,
    });
  }
  save(lockFile, lock);
}
function internal(file, scope, endpoint, destination) {
  assert(
    /^@[a-z0-9][a-z0-9._-]*$/.test(scope) && scope !== PUBLIC_SCOPE,
    'Internal scope must be a valid @scope distinct from the public scope',
  );
  endpoint = registry(endpoint);
  assert(
    endpoint !== 'https://registry.npmjs.org/',
    'Internal artifacts must not target the public npm registry',
  );
  const data = checkArchive(file);
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'idaas-internal-'));
  try {
    for (const [name, body] of data.files) {
      const relative = name.slice('package/'.length);
      const target = path.join(temp, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        /\.(?:js|cjs|mjs|ts|mts|map|json|md)$/.test(name)
          ? body.toString().replaceAll(PUBLIC_SCOPE + '/', scope + '/')
          : body,
      );
    }
    const pkgFile = path.join(temp, 'package.json');
    const pkg = json(pkgFile);
    pkg.publishConfig = { registry: endpoint };
    // The temporary directory contains built artifacts; do not rebuild absent sources or run install scripts.
    delete pkg.scripts;
    delete pkg.devDependencies;
    save(pkgFile, pkg);
    fs.mkdirSync(destination, { recursive: true });
    const result = JSON.parse(
      npm(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], temp, {
        capture: true,
      }),
    )[0];
    const output = path.join(destination, result.filename);
    checkArchive(output, scope);
    return output;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = {
  PUBLIC_SCOPE,
  PACKAGES,
  assert,
  json,
  save,
  integrity,
  run,
  npm,
  options,
  registry,
  readArchive,
  checkMetadata,
  checkArchive,
  stage,
  internal,
};
if (require.main === module) {
  try {
    const command = process.argv[2];
    const args = options(process.argv.slice(3));
    if (command === 'check') {
      const root = path.resolve(__dirname, '..');
      checkMetadata(json(path.join(root, 'package.json')));
      assert(fs.existsSync(path.join(root, 'LICENSE')), 'Missing LICENSE');
      console.log('Release metadata validation passed (nothing published)');
    } else throw new Error('Unknown command');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
