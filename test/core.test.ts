import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CachedResultSupplier,
  ClientException,
  DefaultHttpClient,
  FileOidcTokenProvider,
  type HttpClient,
  type HttpRequest,
  type IDaaSClientConfig,
  IDaaSCredentialProviderFactory,
  IDaaSMachineCredentialProvider,
  StaticClientSecretAssertionProvider,
  StaticPrivateKeyAssertionProvider,
  checkResponse,
  validateConfig,
  loadConfig,
} from '../src';

const secret = '0123456789abcdef0123456789abcdef';
function config(
  method: IDaaSClientConfig['authnConfiguration']['authnMethod'] = 'CLIENT_SECRET_POST',
): IDaaSClientConfig {
  return {
    idaasInstanceId: 'instance',
    clientId: 'client',
    issuer: 'https://issuer.example',
    tokenEndpoint: 'https://issuer.example/token',
    scope: 'resource|read',
    authnConfiguration: { authnMethod: method, clientSecretEnvVarName: 'IDAAS_TEST_SECRET' },
  };
}
function transport(handler?: (request: HttpRequest) => void): HttpClient {
  return {
    async send(request) {
      handler?.(request);
      return {
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          access_token: 'access',
          token_type: 'Bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      };
    },
  };
}
const quiet = { info() {}, warn() {}, error() {} };

describe('OAuth and configuration contracts', () => {
  let previous: string | undefined;
  before(() => {
    previous = process.env.IDAAS_TEST_SECRET;
    process.env.IDAAS_TEST_SECRET = secret;
  });
  after(() => {
    if (previous === undefined) delete process.env.IDAAS_TEST_SECRET;
    else process.env.IDAAS_TEST_SECRET = previous;
  });
  it('encodes raw UTF-8 Basic credentials in the header without a secret or client_id in the body', async () => {
    let calls = 0;
    const provider = new IDaaSMachineCredentialProvider(config('CLIENT_SECRET_BASIC'), {
      clientSecretSupplier: () => 'a:b +/',
      cache: { logger: quiet },
      httpClient: transport((request) => {
        calls++;
        assert.equal(
          request.headers?.authorization,
          `Basic ${Buffer.from('client:a:b +/').toString('base64')}`,
        );
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('grant_type'), 'client_credentials');
        assert.equal(form.get('scope'), 'resource|read');
        assert.equal(form.has('client_secret'), false);
        assert.equal(form.has('client_id'), false);
      }),
    });
    const credentials = await Promise.all(
      Array.from({ length: 40 }, () => provider.getCredential()),
    );
    credentials[0]!.accessToken = 'mutated';
    assert.equal(await provider.getAccessToken(), 'access');
    assert.equal(calls, 1);
    provider.close();
  });
  it('preserves authentication and actor parameters for POST and token exchange', async () => {
    const requests: HttpRequest[] = [];
    const provider = new IDaaSMachineCredentialProvider(config(), {
      httpClient: transport((r) => requests.push(r)),
      cache: { logger: quiet },
    });
    await provider.getCredential();
    await provider.tokenExchange({
      subjectToken: 'subject',
      actorToken: 'actor',
      actorTokenType: 'type',
      audience: 'aud',
    });
    const first = new URLSearchParams(requests[0]!.body);
    assert.equal(first.get('client_secret'), secret);
    const exchange = new URLSearchParams(requests[1]!.body);
    assert.equal(exchange.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(exchange.get('client_id'), 'client');
    assert.equal(exchange.get('actor_token'), 'actor');
    provider.close();
  });
  it('rejects invalid scope, HTTP timeouts, and malformed responses without exposing response bodies', async () => {
    assert.throws(() => validateConfig({ ...config(), scope: 'invalid' }));
    assert.throws(() => validateConfig({ ...config(), httpConfiguration: { readTimeout: 0 } }));
    assert.throws(() =>
      validateConfig(JSON.parse(JSON.stringify({ ...config(), httpConfiguration: 'invalid' }))),
    );
    assert.throws(() =>
      validateConfig(
        JSON.parse(
          JSON.stringify({
            ...config('OIDC'),
            authnConfiguration: {
              authnMethod: 'OIDC',
              applicationFederatedCredentialName: 'fed',
              clientDeployEnvironment: 'UNKNOWN',
            },
          }),
        ),
      ),
    );
    const failure = {
      statusCode: 401,
      headers: {},
      body: JSON.stringify({ error: 'invalid_client', error_description: 'secret-value' }),
    };
    assert.throws(
      () => checkResponse(failure),
      (error: unknown) => {
        assert(error instanceof ClientException);
        assert.equal(error.errorCode, 'invalid_client');
        assert(!error.message.includes('secret-value'));
        return true;
      },
    );
  });
  it('coalesces factory initialization, warmup, and scope creation and allows retries after failure', async () => {
    let calls = 0;
    let fail = true;
    const http = transport(() => {
      calls++;
      if (fail) throw new Error('network');
    });
    const factory = new IDaaSCredentialProviderFactory({
      httpClient: http,
      cache: { logger: quiet },
    });
    await assert.rejects(factory.init(config()));
    fail = false;
    await Promise.all([factory.init(config()), factory.init(config())]);
    assert.equal(calls, 2);
    const providers = await Promise.all([
      factory.getIDaaSCredentialProvider('other|read'),
      factory.getIDaaSCredentialProvider('other|read'),
    ]);
    assert.equal(providers[0], providers[1]);
    assert.equal(calls, 3);
    await factory.close();
    await assert.rejects(factory.getIDaaSCredentialProvider());
  });
  it('prefers explicit configuration paths over environment paths and warms up file-based configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idaas-config-'));
    const previousPath = process.env.CLOUD_IDAAS_CONFIG_PATH;
    const factory = new IDaaSCredentialProviderFactory({
      httpClient: transport(),
      cache: { logger: quiet },
    });
    try {
      const explicit = join(directory, 'explicit.json');
      const fallback = join(directory, 'environment.json');
      await writeFile(explicit, JSON.stringify({ ...config(), clientId: 'explicit' }));
      await writeFile(fallback, JSON.stringify({ ...config(), clientId: 'environment' }));
      process.env.CLOUD_IDAAS_CONFIG_PATH = fallback;
      assert.equal((await loadConfig()).clientId, 'environment');
      assert.equal((await loadConfig(explicit)).clientId, 'explicit');
      await factory.init(explicit);
      assert.equal(factory.getConfig().clientId, 'explicit');
      assert.equal(await (await factory.getIDaaSCredentialProvider()).getAccessToken(), 'access');
    } finally {
      await factory.close();
      if (previousPath === undefined) delete process.env.CLOUD_IDAAS_CONFIG_PATH;
      else process.env.CLOUD_IDAAS_CONFIG_PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('rereads OIDC files on each request to support rotation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idaas-oidc-'));
    try {
      const file = join(dir, 'token');
      const provider = new FileOidcTokenProvider(file);
      await writeFile(file, 'first\n');
      assert.equal(await provider.getOidcToken(), 'first');
      await writeFile(file, 'second\n');
      assert.equal(await provider.getOidcToken(), 'second');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Cache boundaries and concurrency', () => {
  it('prefetches without blocking and awaits the same refresh after the stale threshold', async () => {
    let now = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const cache = new CachedResultSupplier(
      async () => {
        calls++;
        if (calls === 2)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { value: calls, expiresAt: now + 1000, ttlMs: 1000 };
      },
      { clock: () => now, random: () => 0, logger: quiet },
    );
    assert.equal(await cache.get(), 1);
    now = 700;
    assert.equal(await cache.get(), 1);
    await Promise.resolve();
    assert.equal(calls, 2);
    now = 850;
    const pending = cache.get();
    release!();
    assert.equal(await pending, 2);
    cache.close();
  });
  it('allows lenient fallback only before actual expiration and propagates strict refresh failures', async () => {
    for (const mode of ['STRICT', 'LENIENT'] as const) {
      let now = 0;
      let fail = false;
      const cache = new CachedResultSupplier(
        async () => {
          if (fail) throw new Error('down');
          return { value: 'ok', expiresAt: 1000 };
        },
        { clock: () => now, random: () => 0, failureMode: mode, logger: quiet },
      );
      await cache.get();
      fail = true;
      now = 850;
      if (mode === 'STRICT') await assert.rejects(cache.get());
      else assert.equal(await cache.get(), 'ok');
      now = 1000;
      await assert.rejects(cache.get());
      cache.close();
    }
  });
  it('rejects cached values when actual expiration is reached while awaiting refresh', async () => {
    let now = 0;
    let first = true;
    const cache = new CachedResultSupplier(
      async () => {
        if (first) {
          first = false;
          return { value: 'old', expiresAt: 1000 };
        }
        now = 1000;
        throw new Error('down');
      },
      { clock: () => now, random: () => 0, logger: quiet },
    );
    await cache.get();
    now = 850;
    await assert.rejects(cache.get());
    cache.close();
  });
});

describe('jose and package modules', () => {
  it('generates correct HS256 claims with a ten-minute lifetime and unique jti', async () => {
    const { jwtVerify } = await import('jose');
    const provider = new StaticClientSecretAssertionProvider(secret);
    const context = { clientId: 'client', tokenEndpoint: 'https://issuer.example/token' };
    const a = await provider.getClientAssertion(context);
    const b = await provider.getClientAssertion(context);
    const { payload, protectedHeader } = await jwtVerify(a, new TextEncoder().encode(secret), {
      issuer: 'client',
      audience: context.tokenEndpoint,
    });
    assert.equal(protectedHeader.alg, 'HS256');
    assert.equal(payload.sub, 'client');
    assert.equal(payload.exp! - payload.iat!, 600);
    assert.notEqual(
      payload.jti,
      (await jwtVerify(b, new TextEncoder().encode(secret))).payload.jti,
    );
  });
  for (const type of ['rsa', 'ec'] as const) {
    it(`${type} private keys produce verifiable signatures after normalization`, async () => {
      const pair =
        type === 'rsa'
          ? generateKeyPairSync('rsa', { modulusLength: 2048 })
          : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const provider = new StaticPrivateKeyAssertionProvider(
        pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      );
      const context = { clientId: 'client', tokenEndpoint: 'https://issuer.example/token' };
      const token = await provider.getClientAssertion(context);
      const { jwtVerify, importSPKI } = await import('jose');
      const alg = type === 'rsa' ? 'RS256' : 'ES256';
      const key = await importSPKI(
        pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        alg,
      );
      assert.equal(
        (await jwtVerify(token, key, { audience: context.tokenEndpoint })).protectedHeader.alg,
        alg,
      );
    });
  }
  it('shares CJS/ESM identity, preserves native import in builds, and hides jose declarations', async () => {
    const cjs = require('../dist/index.js') as Record<string, unknown>;
    const esm = await import(pathToFileURL(join(__dirname, '../dist/index.mjs')).href);
    assert.equal(cjs.IDaaSCredentialProviderFactory, esm.IDaaSCredentialProviderFactory);
    const code = await readFile(join(__dirname, '../dist/authentication.js'), 'utf8');
    assert(code.includes("import('jose')"));
    assert(!code.includes("require('jose')"));
    const declarations = await readFile(join(__dirname, '../dist/authentication.d.ts'), 'utf8');
    assert(!declarations.includes("'jose'"));
  });
});

describe('Default httpx wrapper', () => {
  it('sends real local form requests and reads responses without following redirects', async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      }
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const client = new DefaultHttpClient();
    try {
      const base = `http://127.0.0.1:${address.port}`;
      assert.equal(
        (await client.send({ url: base + '/ok', method: 'POST', body: 'a=b' })).body,
        '{"ok":true}',
      );
      assert.equal((await client.send({ url: base + '/redirect', method: 'GET' })).statusCode, 302);
      assert.equal(requests, 2);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
