const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('mocha');

describe('Package import', () => {
  for (const mode of ['require', 'import']) {
    it(`does not access the synthetic identity value during ${mode}`, () => {
      const script = `
        const key = 'AWS_SECRET_ACCESS_KEY';
        const original = process.env;
        let reads = 0;
        const observed = new Proxy(original, {
          get(target, name, receiver) {
            if (name === key) reads++;
            return Reflect.get(target, name, receiver);
          },
          getOwnPropertyDescriptor(target, name) {
            if (name === key) reads++;
            return Reflect.getOwnPropertyDescriptor(target, name);
          },
        });
        process.env = observed;
        (async () => {
          const entry = ${mode === 'require' ? "require('./dist/index.js')" : "await import('./dist/index.mjs')"};
          if (typeof entry.IDaaSCredentialProviderFactory !== 'function' || process.env !== observed)
            throw new Error('Package or environment observer is unavailable');
          process.stdout.write(JSON.stringify({ reads }));
        })().catch(() => { process.exitCode = 1; });
      `;
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: require('node:path').join(__dirname, '..'),
        env: { PATH: process.env.PATH, HOME: process.env.HOME, AWS_SECRET_ACCESS_KEY: 'synthetic' },
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).reads, 0);
    });
  }

  it('cancels a pending request when the client closes', () => {
    const script = `
      const { createServer } = require('node:http');
      const { DefaultHttpClient } = require('./dist/index.js');
      (async () => {
        let requests = 0;
        const server = createServer((request, response) => { requests++; response.end('ok'); });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const client = new DefaultHttpClient();
        const pending = client.send({ url: 'http://127.0.0.1:' + server.address().port, method: 'GET' });
        client.close();
        let errorCode = null;
        try { await pending; } catch (error) { errorCode = error.errorCode; }
        await new Promise((resolve) => server.close(resolve));
        process.stdout.write(JSON.stringify({ requests, errorCode }));
      })().catch(() => { process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: require('node:path').join(__dirname, '..'),
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { requests: 0, errorCode: 'Closed' });
  });
});
