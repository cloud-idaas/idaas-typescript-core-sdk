const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const sdk = require('../dist/index.js');

async function capture(client, headers = {}) {
  let received;
  const server = createServer((request, response) => {
    received = { value: request.headers['user-agent'], raw: request.rawHeaders };
    response.setHeader('connection', 'close');
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await client.send({ url: 'http://127.0.0.1:' + server.address().port, method: 'GET', headers });
    return received;
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('User-Agent on actual HTTP requests', () => {
  it('uses the package version after rebuilding an isolated changed-version package', async function () {
    this.timeout(30000);
    const root = path.resolve(__dirname, '..');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'idaas-ua-version-'));
    try {
      for (const name of ['src', 'scripts', 'tsconfig.json', 'package.json', '.prettierrc.json'])
        fs.cpSync(path.join(root, name), path.join(fixture, name), { recursive: true });
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
      const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json')));
      pkg.version = '9.8.7-beta.2';
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
        cwd: fixture,
        stdio: 'pipe',
      });
      const built = require(path.join(fixture, 'dist/index.js'));
      const wire = await capture(new built.DefaultHttpClient());
      assert(wire.value.startsWith('cloud-idaas-typescript/9.8.7-beta.2 '), wire.value);
      assert(wire.value.includes('Node.js/' + process.versions.node));
      assert(wire.value.includes('OS(' + process.platform + '; ' + process.arch + ')'));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
  it('supports configured values and a case-insensitive per-request override without duplicates', async () => {
    const configured = await capture(new sdk.DefaultHttpClient({ userAgent: 'ExampleApp/1.0' }));
    assert.equal(configured.value, 'ExampleApp/1.0');
    const headers = Object.freeze({ 'user-agent': 'First/1', 'UsEr-AgEnT': 'Override/2' });
    const overridden = await capture(
      new sdk.DefaultHttpClient({ userAgent: 'Configured/1' }),
      headers,
    );
    assert.equal(overridden.value, 'Override/2');
    assert.equal(
      overridden.raw.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === 'user-agent',
      ).length,
      1,
    );
  });
  it('rejects invalid configuration and injected header controls before transport', () => {
    for (const value of [
      '',
      '   ',
      null,
      0,
      'app\r\nx-header: value',
      'app\u0000',
      '\u4e2d\u6587',
      'x'.repeat(513),
    ])
      assert.throws(() => new sdk.DefaultHttpClient({ userAgent: value }), {
        name: 'ConfigException',
        errorCode: 'InvalidUserAgent',
      });
    assert.throws(
      () =>
        sdk.validateConfig({
          idaasInstanceId: 'example',
          clientId: 'example',
          scope: 'api.example|read',
          issuer: 'https://issuer.example',
          tokenEndpoint: 'https://issuer.example/token',
          authnConfiguration: {
            authnMethod: 'CLIENT_SECRET_POST',
            clientSecretEnvVarName: 'EXAMPLE_SECRET',
          },
          httpConfiguration: { userAgent: 1 },
        }),
      { errorCode: 'InvalidUserAgent' },
    );
  });
  it('rejects a per-request header injection before opening the transport', async () => {
    const client = new sdk.DefaultHttpClient();
    try {
      await assert.rejects(
        client.send({
          url: 'http://127.0.0.1:1',
          method: 'GET',
          headers: { 'User-Agent': 'app\r\nx-extra: value' },
        }),
        { name: 'ConfigException', errorCode: 'InvalidUserAgent' },
      );
    } finally {
      client.close();
    }
  });
});
