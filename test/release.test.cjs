const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const release = require('../scripts/release.cjs');
const { integrity } = require('../scripts/release-tools.cjs');

const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
let directory;
function fixture(dependencies = {}, version = '0.1.0-beta.1') {
  const root = path.join(directory, 'source');
  const candidate = path.join(directory, 'candidate');
  fs.mkdirSync(root);
  fs.mkdirSync(candidate);
  const pkg = {
    name: '@cloud-idaas/core-sdk',
    version,
    license: 'Apache-2.0',
    dependencies,
    repository: { url: 'https://github.com/cloud-idaas/idaas-typescript-core-sdk.git' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v' + version,
    GITHUB_REF: 'refs/tags/v' + version,
    GITHUB_REPOSITORY: 'cloud-idaas/idaas-typescript-core-sdk',
    GITHUB_SHA: COMMIT,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'test',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test',
  };
  const file = 'cloud-idaas-core-sdk-' + version + '.tgz';
  fs.writeFileSync(path.join(candidate, file), 'controlled-candidate');
  const manifest = {
    format: 1,
    repo: 'idaas-typescript-core-sdk',
    name: pkg.name,
    version: pkg.version,
    tag: env.GITHUB_REF_NAME,
    commit: COMMIT,
    file,
    integrity: integrity(path.join(candidate, file)),
    dependencies: Object.entries(dependencies).map(([name, version]) => ({
      name,
      version,
      integrity: 'sha512-dXBzdHJlYW0=',
    })),
  };
  const save = () =>
    fs.writeFileSync(path.join(candidate, 'manifest.json'), JSON.stringify(manifest));
  save();
  const calls = [];
  const hooks = {
    run(_command, args) {
      return args[0] === 'status' ? '' : COMMIT;
    },
    checkArchive() {
      return { pkg };
    },
    npm(args) {
      calls.push(args);
      if (args[0] === 'view') throw new Error('npm error code E404');
      return '';
    },
  };
  return { root, candidate, pkg, env, file, manifest, save, calls, hooks };
}

describe('Automatic npm tag releases', () => {
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idaas-release-test-'));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('accepts canonical stable/prerelease versions and rejects ambiguous version tags', () => {
    for (const version of ['0.1.0', '1.2.3', '0.1.0-beta.1', '1.0.0-rc.0'])
      assert(release.VERSION.test(version));
    for (const version of ['01.0.0', '1.0.0-01', '1.0.0-', 'v1.0.0', '1.0.0+build'])
      assert(!release.VERSION.test(version));
  });
  it('rejects branch pushes and manual workflow dispatches before publishing', () => {
    const f = fixture();
    for (const change of [
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
      { GITHUB_REF_TYPE: 'branch' },
      { GITHUB_ACTIONS: 'false' },
    ]) {
      assert.throws(
        () => release.publish(f.root, f.candidate, { ...f.env, ...change }, f.hooks),
        /GitHub tag push/,
      );
    }
    assert.equal(f.calls.length, 0);
  });
  it('rejects a version/tag mismatch and a different GitHub repository', () => {
    const f = fixture();
    assert.throws(
      () =>
        release.tagContext(
          f.root,
          { ...f.env, GITHUB_REF_NAME: 'v0.2.0', GITHUB_REF: 'refs/tags/v0.2.0' },
          f.hooks.run,
        ),
      /canonical package.json/,
    );
    assert.throws(
      () =>
        release.tagContext(f.root, { ...f.env, GITHUB_REPOSITORY: 'untrusted/fork' }, f.hooks.run),
      /repository does not match/,
    );
  });
  it('peels annotated tags and binds the checked-out commit to the event', () => {
    const f = fixture();
    assert.equal(
      release.tagContext(f.root, { ...f.env, GITHUB_SHA: OTHER }, f.hooks.run).commit,
      COMMIT,
    );
    const wrong = (_command, args) =>
      args.includes(OTHER + '^{commit}') ? OTHER : f.hooks.run(_command, args);
    assert.throws(
      () => release.tagContext(f.root, { ...f.env, GITHUB_SHA: OTHER }, wrong),
      /same commit/,
    );
  });
  it('rejects a tag pointing at different source and rejects a dirty checkout', () => {
    const f = fixture();
    assert.throws(
      () =>
        release.tagContext(f.root, f.env, (_command, args) =>
          args.some((v) => v.startsWith('refs/tags/')) ? OTHER : f.hooks.run(_command, args),
        ),
      /same commit/,
    );
    assert.throws(
      () =>
        release.tagContext(f.root, f.env, (_command, args) =>
          args[0] === 'status' ? ' M package.json' : COMMIT,
        ),
      /clean checkout/,
    );
  });
  it('distinguishes an unpublished version from registry/network failure', () => {
    assert.equal(
      release.published('example', '1.0.0', directory, () => {
        throw new Error('E404');
      }),
      null,
    );
    assert.throws(
      () =>
        release.published('example', '1.0.0', directory, () => {
          throw new Error('ECONNRESET');
        }),
      /Unable to read npm metadata/,
    );
  });
  it('requires OIDC and verifies the candidate source before any npm operation', () => {
    const f = fixture();
    assert.throws(
      () =>
        release.publish(
          f.root,
          f.candidate,
          { ...f.env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
          f.hooks,
        ),
      /OIDC/,
    );
    f.manifest.commit = OTHER;
    f.save();
    assert.throws(
      () => release.publish(f.root, f.candidate, f.env, f.hooks),
      /verified tag and source/,
    );
    assert.equal(f.calls.length, 0);
  });
  it('rejects modified archives and path traversal in artifact metadata', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.candidate, f.file), 'tampered');
    assert.throws(() => release.publish(f.root, f.candidate, f.env, f.hooks), /integrity mismatch/);
    f.manifest.file = '../package.tgz';
    f.save();
    assert.throws(() => release.publish(f.root, f.candidate, f.env, f.hooks), /filename/);
    assert.equal(f.calls.length, 0);
  });
  it('publishes exactly the verified prerelease archive to the beta dist-tag', () => {
    const f = fixture();
    release.publish(f.root, f.candidate, f.env, f.hooks);
    const commands = f.calls.filter((args) => args[0] === 'publish');
    assert.equal(commands.length, 1);
    assert.equal(commands[0][1], path.join(f.candidate, f.file));
    assert(
      commands[0].includes('--tag=beta') &&
        commands[0].includes('--access=public') &&
        commands[0].includes('--ignore-scripts'),
    );
    assert(!f.calls.some((args) => args[0] === 'pack' || args[0] === 'run'));
  });
  it('publishes stable versions to latest without a manual approval flag', () => {
    const f = fixture({}, '1.0.0');
    release.publish(f.root, f.candidate, f.env, f.hooks);
    assert(f.calls.some((args) => args[0] === 'publish' && args.includes('--tag=latest')));
  });
  it('compares canonical SemVer precedence without lexical or integer precision errors', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.10',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
    ];
    for (let i = 1; i < ordered.length; i++) {
      assert.equal(release.compareVersions(ordered[i - 1], ordered[i]), -1);
      assert.equal(release.compareVersions(ordered[i], ordered[i - 1]), 1);
    }
    assert.equal(release.compareVersions('1.2.3', '1.2.3'), 0);
    assert.equal(release.compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  });
  it('automatically publishes backfills without moving latest or beta backwards', () => {
    for (const [version, channel, current] of [
      ['1.0.0', 'latest', '1.1.0'],
      ['0.1.0-beta.2', 'beta', '0.1.0-beta.10'],
    ]) {
      const f = fixture({}, version);
      f.hooks.npm = (args) => {
        f.calls.push(args);
        if (args[2] === 'dist-tags') return JSON.stringify({ [channel]: current });
        if (args[0] === 'view') throw new Error('E404');
        return '';
      };
      release.publish(f.root, f.candidate, f.env, f.hooks);
      assert(
        f.calls.some((args) => args[0] === 'publish' && args.includes('--tag=release-' + version)),
      );
      fs.rmSync(f.root, { recursive: true });
      fs.rmSync(f.candidate, { recursive: true });
    }
  });
  it('fails closed when channel metadata cannot be read', () => {
    assert.throws(
      () =>
        release.publishChannel({ name: 'example', version: '1.0.0' }, directory, () => {
          throw new Error('ECONNRESET');
        }),
      /distribution tags/,
    );
    for (const latest of ['not-a-version', 0, false, null]) {
      assert.throws(
        () =>
          release.publishChannel({ name: 'example', version: '1.0.0' }, directory, () =>
            JSON.stringify({ latest }),
          ),
        /channel version/,
      );
    }
  });
  it('is idempotent for identical published content and rejects version reuse with other content', () => {
    const f = fixture();
    f.hooks.npm = (args) => {
      f.calls.push(args);
      return JSON.stringify({ integrity: f.manifest.integrity });
    };
    release.publish(f.root, f.candidate, f.env, f.hooks);
    assert(!f.calls.some((args) => args[0] === 'publish'));
    f.hooks.npm = () => JSON.stringify({ integrity: 'sha512-ZGlmZmVyZW50' });
    assert.throws(() => release.publish(f.root, f.candidate, f.env, f.hooks), /different contents/);
  });
  it('rejects upstream packages changed after candidate validation', () => {
    const f = fixture({ '@cloud-idaas/pam-client-sdk': '0.1.0-beta.1' });
    f.hooks.npm = () => JSON.stringify({ integrity: 'sha512-Y2hhbmdlZA==' });
    assert.throws(() => release.publish(f.root, f.candidate, f.env, f.hooks), /upstream changed/);
  });
  it('automatically waits for upstream publication and validates the downloaded archive', async () => {
    const pkg = { dependencies: { '@cloud-idaas/core-sdk': '0.1.0-beta.1' } };
    const file = path.join(directory, 'upstream.tgz');
    fs.writeFileSync(file, 'upstream');
    const expected = integrity(file);
    let views = 0;
    let sleeps = 0;
    const hooks = {
      npm(args) {
        if (args[0] === 'view') {
          if (++views === 1) throw new Error('E404');
          return JSON.stringify({ integrity: expected });
        }
        return JSON.stringify([{ filename: 'upstream.tgz' }]);
      },
      sleep(ms) {
        assert.equal(ms, 30000);
        sleeps++;
      },
      log() {},
      checkArchive() {
        return { pkg: { name: '@cloud-idaas/core-sdk', version: '0.1.0-beta.1' } };
      },
    };
    const result = await release.fetchUpstreams(pkg, directory, directory, hooks);
    assert.equal(sleeps, 1);
    assert.equal(result[0].integrity, expected);
    fs.appendFileSync(file, 'tampered');
    await assert.rejects(
      release.fetchUpstreams(pkg, directory, directory, hooks),
      /integrity does not match/,
    );
  });
  it('fails after a bounded wait rather than requiring manual release switches', async () => {
    let sleeps = 0;
    await assert.rejects(
      release.fetchUpstreams(
        { dependencies: { '@cloud-idaas/core-sdk': '0.1.0-beta.1' } },
        directory,
        directory,
        {
          npm() {
            throw new Error('E404');
          },
          sleep() {
            sleeps++;
          },
          log() {},
        },
      ),
      /Timed out waiting/,
    );
    assert.equal(sleeps, 20);
  });
});
