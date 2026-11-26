import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClientDeployEnvironment,
  ClientException,
  type CredentialProviderOptions,
  type HttpRequest,
  type IDaaSClientConfig,
  IDaaSCredentialProviderFactory,
  IDaaSMachineCredentialProvider,
  type PluginTokenResult,
  type TokenAuthnMethod,
  type TokenExchangeOptions,
  loadConfig,
  validateConfig,
  validatePemCertificates,
} from '../src';

const quiet = { info() {}, warn() {}, error() {} };
const accessType = 'urn:ietf:params:oauth:token-type:access_token';
const assertion = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.e30.c2ln`;
function config(method: TokenAuthnMethod): IDaaSClientConfig {
  return {
    clientId: 'client',
    idaasInstanceId: 'instance',
    issuer: 'https://issuer.example',
    tokenEndpoint: 'https://issuer.example/token',
    scope: 'resource|read',
    authnConfiguration: { authnMethod: method, applicationFederatedCredentialName: 'fed' },
  };
}
function options(observe: (request: HttpRequest) => void = () => {}): CredentialProviderOptions {
  return {
    cache: { logger: quiet },
    httpClient: {
      async send(request) {
        observe(request);
        const exchange = new URLSearchParams(request.body)
          .get('grant_type')
          ?.includes('token-exchange');
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({
            access_token: 'test-access',
            expires_in: 3600,
            token_type: 'bearer',
            ...(exchange ? { scope: 'granted|read', issued_token_type: accessType } : {}),
          }),
        };
      },
    },
  };
}
const sources: [TokenAuthnMethod, CredentialProviderOptions][] = [
  ['CLIENT_SECRET_BASIC', { clientSecretSupplier: () => 'test-secret' }],
  ['CLIENT_SECRET_POST', { clientSecretSupplier: () => 'test-secret' }],
  ['CLIENT_SECRET_JWT', { clientSecretSupplier: () => 'test-secret' }],
  [
    'CLIENT_SECRET_JWT',
    {
      clientAssertionProvider: {
        async getClientAssertion() {
          return assertion;
        },
      },
    },
  ],
  [
    'PRIVATE_KEY_JWT',
    {
      clientAssertionProvider: {
        async getClientAssertion() {
          return assertion;
        },
      },
    },
  ],
  [
    'OIDC',
    {
      oidcTokenProvider: {
        async getOidcToken() {
          return 'test-oidc';
        },
      },
    },
  ],
  [
    'PKCS7',
    {
      attestedDocumentProvider: {
        async getAttestedDocument() {
          return 'test-pkcs7';
        },
      },
    },
  ],
];

describe('Selected authentication sources', () => {
  for (const entry of ['direct', 'object', 'file'] as const) {
    for (const [method, source] of sources) {
      it(`${entry} accepts ${method} with an injected source and no default source configuration (${Object.keys(source)[0]})`, async () => {
        const cfg = config(method);
        cfg.authnConfiguration.oidcTokenFilePathEnvVarName = 'IDAAS_TEST_UNUSED_OIDC_PATH';
        let requests = 0;
        const selected = {
          ...options((request) => {
            requests++;
            const form = new URLSearchParams(request.body);
            if (method === 'CLIENT_SECRET_BASIC')
              assert(request.headers?.authorization?.startsWith('Basic '));
            else if (method === 'CLIENT_SECRET_POST')
              assert.equal(form.get('client_secret'), 'test-secret');
            else assert(form.get('client_assertion'));
          }),
          ...source,
        };
        const directory = await mkdtemp(join(tmpdir(), 'idaas-source-'));
        const factory = new IDaaSCredentialProviderFactory(selected);
        let provider: IDaaSMachineCredentialProvider | undefined;
        try {
          if (entry === 'direct') provider = new IDaaSMachineCredentialProvider(cfg, selected);
          else {
            const path = join(directory, 'config.json');
            await writeFile(path, JSON.stringify(cfg));
            await factory.init(entry === 'object' ? cfg : path);
            provider = await factory.getIDaaSCredentialProvider();
          }
          assert.equal((await provider.getCredential()).tokenType, 'Bearer');
          assert.equal(requests, 1);
          assert.equal(cfg.authnConfiguration.clientSecretEnvVarName, undefined);
        } finally {
          provider?.close();
          await factory.close();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
  it('rejects invalid injected authentication material before sending HTTP', async () => {
    for (const material of ['', '  ', undefined, 42]) {
      const read = async () => material as string;
      const cases: Array<[TokenAuthnMethod, CredentialProviderOptions]> = [
        ['CLIENT_SECRET_JWT', { clientAssertionProvider: { getClientAssertion: read } }],
        ['OIDC', { oidcTokenProvider: { getOidcToken: read } }],
        ['PKCS7', { attestedDocumentProvider: { getAttestedDocument: read } }],
      ];
      for (const [method, injected] of cases) {
        let sends = 0;
        const provider = new IDaaSMachineCredentialProvider(config(method), {
          ...options(() => sends++),
          ...injected,
        });
        try {
          await assert.rejects(provider.getAccessToken(), { errorCode: 'InvalidConfiguration' });
          assert.equal(sends, 0);
        } finally {
          provider.close();
        }
      }
    }
  });

  it('keeps unknown upstream error values out of exceptions and background refresh logging', async () => {
    const marker = 'sample-value-6a29';
    const input = config('CLIENT_SECRET_POST');
    const logs: unknown[] = [];
    let now = Date.now();
    let fail = true;
    let reportRefresh: () => void = () => undefined;
    const provider = new IDaaSMachineCredentialProvider(input, {
      clientSecretSupplier: () => 'fixture',
      httpClient: {
        async send() {
          return {
            statusCode: fail ? 401 : 200,
            headers: {},
            body: JSON.stringify(
              fail
                ? { error: marker, error_description: marker }
                : { access_token: 'access', expires_in: 60, token_type: 'Bearer' },
            ),
          };
        },
      },
      cache: {
        clock: () => now,
        random: () => 0,
        logger: {
          ...quiet,
          warn(event, fields) {
            logs.push([event, fields]);
            reportRefresh();
          },
        },
      },
    });
    try {
      await assert.rejects(provider.getAccessToken(), (error: unknown) => {
        assert(error instanceof ClientException);
        assert.equal(error.errorCode, 'HTTP_401');
        assert(!error.message.includes(marker));
        return true;
      });
      fail = false;
      assert.equal(await provider.getAccessToken(), 'access');
      logs.length = 0;
      fail = true;
      now += 43_000;
      const background = new Promise<void>((resolve) => {
        reportRefresh = resolve;
      });
      assert.equal(await provider.getAccessToken(), 'access');
      await background;
      assert.deepEqual(logs, [
        ['credential_refresh', { status: 'failure', errorCode: 'HTTP_401' }],
      ]);
    } finally {
      provider.close();
    }
  });

  it('continues rejecting missing dependencies when no custom source is selected', () => {
    for (const [method, errorCode] of [
      ['CLIENT_SECRET_POST', 'ClientSecretEnvVarNameNotFound'],
      ['PRIVATE_KEY_JWT', 'PrivateKeyEnvVarNameNotFound'],
      ['OIDC', 'ClientDeployEnvironmentNotFound'],
      ['PKCS7', 'ClientDeployEnvironmentNotFound'],
    ] as const)
      assert.throws(() => validateConfig(config(method)), { errorCode });
    for (const method of ['OIDC', 'PKCS7'] as const) {
      const cfg = config(method);
      cfg.authnConfiguration.clientDeployEnvironment = 'UNSUPPORTED' as ClientDeployEnvironment;
      assert.throws(() => validateConfig(cfg), {
        errorCode: 'UnsupportedClientDeployEnvironment',
      });
    }
  });
  for (const [method, source] of sources.filter(([method]) => ['OIDC', 'PKCS7'].includes(method))) {
    it(`ignores an unsupported deployment environment when ${method} uses an injected source`, async () => {
      const cfg = config(method);
      cfg.authnConfiguration.clientDeployEnvironment = 'UNSUPPORTED' as ClientDeployEnvironment;
      let requests = 0;
      const provider = new IDaaSMachineCredentialProvider(cfg, {
        ...options((request) => {
          requests++;
          assert.equal(
            new URLSearchParams(request.body).get('client_assertion'),
            method === 'OIDC' ? 'test-oidc' : 'test-pkcs7',
          );
        }),
        ...source,
      });
      try {
        assert.equal((await provider.getCredential()).accessToken, 'test-access');
        assert.equal(requests, 1);
      } finally {
        provider.close();
      }
    });
  }
  it('rejects invalid source shapes and explicitly invalid optional endpoints', () => {
    for (const source of [
      { clientSecretSupplier: 'invalid' },
      { clientAssertionProvider: null },
      { oidcTokenProvider: {} },
      { attestedDocumentProvider: { getAttestedDocument: 'invalid' } },
    ])
      assert.throws(
        () => validateConfig(config('OIDC'), source as unknown as CredentialProviderOptions),
        { errorCode: 'InvalidConfiguration' },
      );
    for (const field of ['openApiEndpoint', 'developerApiEndpoint'] as const)
      for (const value of ['', 'ftp://invalid.example'])
        assert.throws(() =>
          validateConfig(
            { ...config('CLIENT_SECRET_POST'), [field]: value },
            { clientSecretSupplier: () => 'test-secret' },
          ),
        );
  });
  it('selects OIDC file paths lazily and never falls back from a selected invalid source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idaas-selected-file-'));
    const name = 'IDAAS_TEST_SELECTED_OIDC_PATH';
    const previous = process.env[name];
    let requests = 0;
    const selected = options((request) => {
      requests++;
      assert.equal(new URLSearchParams(request.body).get('client_assertion'), 'current-file-token');
    });
    try {
      delete process.env[name];
      const path = join(directory, 'token');
      await writeFile(path, 'current-file-token\n');
      const cfg = config('OIDC');
      cfg.authnConfiguration.clientDeployEnvironment = 'UNSUPPORTED' as ClientDeployEnvironment;
      cfg.authnConfiguration.oidcTokenFilePath = path;
      cfg.authnConfiguration.oidcTokenFilePathEnvVarName = name;
      const direct = new IDaaSMachineCredentialProvider(cfg, selected);
      try {
        await direct.getCredential();
      } finally {
        direct.close();
      }
      delete cfg.authnConfiguration.oidcTokenFilePath;
      assert.throws(() => new IDaaSMachineCredentialProvider(cfg, selected), {
        errorCode: 'InvalidConfiguration',
      });
      process.env[name] = '';
      assert.throws(() => new IDaaSMachineCredentialProvider(cfg, selected), {
        errorCode: 'InvalidConfiguration',
      });
      process.env[name] = path;
      const fromEnvironment = new IDaaSMachineCredentialProvider(cfg, selected);
      try {
        await fromEnvironment.getCredential();
      } finally {
        fromEnvironment.close();
      }
      for (const content of ['', '   ']) {
        await writeFile(path, content);
        const empty = new IDaaSMachineCredentialProvider(cfg, selected);
        try {
          await assert.rejects(empty.getCredential(), { errorCode: 'InvalidConfiguration' });
        } finally {
          empty.close();
        }
      }
      process.env[name] = join(directory, 'missing');
      const missing = new IDaaSMachineCredentialProvider(cfg, selected);
      try {
        await assert.rejects(missing.getCredential(), { errorCode: 'OidcTokenReadError' });
      } finally {
        missing.close();
      }
      cfg.authnConfiguration.oidcTokenFilePath = '';
      assert.throws(() => new IDaaSMachineCredentialProvider(cfg, selected), {
        errorCode: 'InvalidConfiguration',
      });
      assert.equal(requests, 2);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('PCA material boundaries', () => {
  let directory: string;
  let certificate: string;
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'idaas-external-pca-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=idaas-test-leaf',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
      ],
      { stdio: 'ignore' },
    );
    certificate = await readFile(join(directory, 'cert.pem'), 'utf8');
  });
  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it('sends external assertions and the complete chain without requiring a local private key', async () => {
    const cfg = config('PCA');
    const chain = certificate.repeat(7);
    Object.assign(cfg.authnConfiguration, {
      clientX509Certificate: certificate,
      x509CertChains: chain,
    });
    let calls = 0;
    const provider = new IDaaSMachineCredentialProvider(cfg, {
      ...options((request) => {
        calls++;
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('client_assertion'), assertion);
        assert.equal(form.get('client_x509'), certificate);
        assert.equal(form.get('client_x509_chain'), chain);
      }),
      clientAssertionProvider: {
        async getClientAssertion() {
          return assertion;
        },
      },
    });
    try {
      await provider.getCredential();
      assert.equal(calls, 1);
    } finally {
      provider.close();
    }
  });
  it('still rejects malformed PEM, multiple leaves, empty chains, and mismatched local keys', async () => {
    for (const [pem, chain] of [
      [certificate.repeat(2), false],
      ['', true],
      ['invalid', true],
      [certificate + ',', true],
    ] as const)
      assert.throws(() => validatePemCertificates(pem, chain), {
        errorCode: 'InvalidCertificateChain',
      });
    const name = 'IDAAS_TEST_LOCAL_PCA_KEY';
    const previous = process.env[name];
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env[name] = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const cfg = config('PCA');
    Object.assign(cfg.authnConfiguration, {
      privateKeyEnvVarName: name,
      clientX509Certificate: certificate,
      x509CertChains: certificate,
    });
    let requests = 0;
    const provider = new IDaaSMachineCredentialProvider(
      cfg,
      options(() => {
        requests++;
      }),
    );
    try {
      await assert.rejects(provider.getCredential(), { errorCode: 'InvalidCertificate' });
      assert.equal(requests, 0);
    } finally {
      provider.close();
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});

describe('Plugin dependency and expiration contracts', () => {
  function pluginConfig(): IDaaSClientConfig {
    return {
      ...config('PLUGIN'),
      authnConfiguration: { authnMethod: 'PLUGIN', pluginName: 'custom' },
    };
  }
  it('initializes a generic plugin without an OpenAPI endpoint from objects and files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idaas-plugin-config-'));
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(pluginConfig()));
    try {
      assert.equal((await loadConfig(path)).openApiEndpoint, undefined);
      for (const input of [pluginConfig(), path]) {
        const factory = new IDaaSCredentialProviderFactory({
          ...options(() => assert.fail('Plugin must not use Core HTTP')),
          plugins: [
            {
              getName: () => 'custom',
              async getToken() {
                return { accessToken: 'test-plugin', expiresIn: 60, tokenType: 'bEaReR' };
              },
            },
          ],
        });
        try {
          await factory.init(input);
          assert.equal(
            (await (await factory.getIDaaSCredentialProvider()).getCredential()).tokenType,
            'Bearer',
          );
        } finally {
          await factory.close();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const scenario of ['relative', 'absolute', 'expired'] as const) {
    it(`uses the plugin call start for ${scenario} expiration`, async () => {
      const original = Date.now;
      let now = 1_800_000_000_000;
      const started = now;
      Date.now = () => now;
      const provider = new IDaaSMachineCredentialProvider(pluginConfig(), {
        ...options(),
        plugins: [
          {
            getName: () => 'custom',
            async getToken() {
              now += 2000;
              return {
                accessToken: 'test-plugin',
                tokenType: 'Bearer',
                expiresIn: scenario === 'expired' ? 1 : 10,
                ...(scenario === 'absolute' ? { expiresAt: started / 1000 + 5 } : {}),
              };
            },
          },
        ],
      });
      try {
        if (scenario === 'expired')
          await assert.rejects(provider.getCredential(), { errorCode: 'InvalidTokenResponse' });
        else {
          const credential = await provider.getCredential();
          assert.equal(credential.expiresAt, started / 1000 + (scenario === 'absolute' ? 5 : 10));
        }
      } finally {
        provider.close();
        Date.now = original;
      }
    });
  }
  it('validates plugin results before delivering credentials', async () => {
    const valid = { accessToken: 'test-plugin', expiresIn: 60, tokenType: 'Bearer' };
    for (const value of [
      null,
      { ...valid, accessToken: '' },
      { ...valid, expiresIn: undefined },
      { ...valid, expiresIn: Infinity },
      { ...valid, expiresIn: 0 },
      { ...valid, tokenType: undefined },
      { ...valid, tokenType: 'MAC' },
      { ...valid, expiresAt: NaN },
      { ...valid, expiresAt: 0 },
    ]) {
      const provider = new IDaaSMachineCredentialProvider(pluginConfig(), {
        ...options(),
        plugins: [
          {
            getName: () => 'custom',
            async getToken() {
              return value as unknown as PluginTokenResult;
            },
          },
        ],
      });
      try {
        await assert.rejects(provider.getCredential(), (error: unknown) => {
          assert(error instanceof Error);
          assert.equal(error.name, 'CredentialException');
          return true;
        });
      } finally {
        provider.close();
      }
    }
  });
});

describe('Explicit exchange materials and extensions', () => {
  it('preserves encoded materials, server-governed parameters, complete results, and the ordinary cache', async () => {
    let secretCalls = 0;
    const requests: HttpRequest[] = [];
    const provider = new IDaaSMachineCredentialProvider(config('CLIENT_SECRET_BASIC'), {
      ...options((request) => {
        requests.push(request);
      }),
      clientSecretSupplier: () => {
        secretCalls++;
        return 'configured-secret';
      },
    });
    const materials = Object.freeze({
      clientId: 'request-client',
      clientAssertion: 'assertion +&=\u4e2d',
      clientAssertionType: 'external-type',
      clientX509Certificate: 'leaf\nPEM',
      x509CertChains: 'chain\nPEM',
      applicationFederatedCredentialName: 'request-fed',
    });
    const additionalParameters = Object.freeze({
      resource: 'https://resource.example/a?x=1&y=2',
      extension: ' +&=\u4e2d\u6587\n',
    });
    const exchange: TokenExchangeOptions = {
      subjectToken: 'subject',
      subjectTokenType: 'external-subject-type',
      requestedTokenType: 'external-request-type',
      actorToken: 'actor',
      actorTokenType: 'urn:cloud:idaas:params:oauth:token-type:agi:actor-token',
      audience: 'explicit-audience',
      authentication: materials,
      additionalParameters,
    };
    try {
      await provider.getCredential();
      const result = await provider.tokenExchange(exchange);
      await provider.tokenExchange(exchange);
      await provider.getCredential();
      assert.equal(secretCalls, 1);
      assert.equal(requests.length, 3);
      assert(requests[0]!.headers?.authorization);
      for (const request of requests.slice(1)) {
        assert.equal(request.headers?.authorization, undefined);
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
        assert.equal(form.get('client_id'), materials.clientId);
        assert.equal(form.get('client_assertion'), materials.clientAssertion);
        assert.equal(form.get('client_assertion_type'), materials.clientAssertionType);
        assert.equal(form.get('client_x509'), materials.clientX509Certificate);
        assert.equal(form.get('client_x509_chain'), materials.x509CertChains);
        assert.equal(
          form.get('application_federated_credential_name'),
          materials.applicationFederatedCredentialName,
        );
        assert.equal(form.get('client_secret'), null);
        assert.equal(form.get('actor_token_type'), exchange.actorTokenType);
        assert.equal(form.get('subject_token_type'), exchange.subjectTokenType);
        assert.equal(form.get('requested_token_type'), exchange.requestedTokenType);
        assert.equal(form.get('audience'), exchange.audience);
        assert.equal(form.get('scope'), 'resource|read');
        assert.equal(form.get('resource'), additionalParameters.resource);
        assert.equal(form.get('extension'), additionalParameters.extension);
      }
      assert.equal(result.scope, 'granted|read');
      assert.equal(result.issuedTokenType, accessType);
      assert.equal(result.tokenType, 'Bearer');
      assert(result.expiresAt > Date.now() / 1000);
    } finally {
      provider.close();
    }
  });
  it('does not call configured credentials when explicit secret authentication is selected', async () => {
    const cfg = config('PRIVATE_KEY_JWT');
    const provider = new IDaaSMachineCredentialProvider(cfg, {
      ...options((request) => {
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('client_id'), 'client');
        assert.equal(form.get('client_secret'), 'request-secret');
        assert.equal(form.get('client_assertion'), null);
        assert.equal(form.get('subject_token_type'), accessType);
      }),
      clientAssertionProvider: {
        async getClientAssertion() {
          assert.fail('Unused assertion source');
        },
      },
    });
    try {
      await provider.tokenExchange({
        subjectToken: 'subject',
        authentication: {
          clientId: undefined,
          clientSecret: 'request-secret',
          clientAssertion: undefined,
        },
      });
    } finally {
      provider.close();
    }
  });
  it('retains configured authentication when only additional parameters are provided', async () => {
    let calls = 0;
    const provider = new IDaaSMachineCredentialProvider(config('CLIENT_SECRET_POST'), {
      ...options((request) => {
        const form = new URLSearchParams(request.body);
        assert.equal(form.get('client_secret'), 'default-secret');
        assert.equal(form.get('extension'), 'value');
      }),
      clientSecretSupplier: () => {
        calls++;
        return 'default-secret';
      },
    });
    try {
      await provider.tokenExchange({
        subjectToken: 'subject',
        additionalParameters: { extension: 'value' },
      });
      assert.equal(calls, 1);
    } finally {
      provider.close();
    }
  });
  it('rejects malformed or colliding fields without invoking credentials or HTTP', async () => {
    const provider = new IDaaSMachineCredentialProvider(config('CLIENT_SECRET_POST'), {
      ...options(() => assert.fail('Invalid exchange must not reach HTTP')),
      clientSecretSupplier: () => {
        assert.fail('Invalid exchange must not read credentials');
      },
    });
    try {
      for (const bad of [
        { authentication: {} },
        { authentication: { clientId: undefined } },
        { authentication: null },
        { authentication: [] },
        { authentication: { unknown: 'value' } },
        { authentication: { clientSecret: '' } },
        { authentication: { clientAssertion: 123 } },
        { additionalParameters: null },
        { additionalParameters: { extension: '' } },
        { additionalParameters: { extension: 123 } },
        { additionalParameters: { ' ': 'value' } },
        ...['grant_type', 'scope', 'subject_token', 'client_secret', 'client_assertion'].map(
          (key) => ({ additionalParameters: { [key]: 'override' } }),
        ),
      ])
        await assert.rejects(
          provider.tokenExchange({
            subjectToken: 'subject',
            ...bad,
          } as unknown as TokenExchangeOptions),
        );
    } finally {
      provider.close();
    }
  });
  it('lets plugin instances exchange with explicit authentication and preserves service rejection', async () => {
    let pluginCalls = 0;
    const cfg = config('PLUGIN');
    cfg.authnConfiguration.pluginName = 'custom';
    const provider = new IDaaSMachineCredentialProvider(cfg, {
      cache: { logger: quiet },
      plugins: [
        {
          getName: () => 'custom',
          async getToken() {
            pluginCalls++;
            return { accessToken: 'test-plugin', tokenType: 'Bearer', expiresIn: 60 };
          },
        },
      ],
      httpClient: {
        async send() {
          return { statusCode: 400, headers: {}, body: '{"error":"invalid_request"}' };
        },
      },
    });
    try {
      await provider.getCredential();
      await assert.rejects(provider.tokenExchange({ subjectToken: 'subject' }), {
        errorCode: 'UnsupportedAuthenticationMethod',
      });
      await assert.rejects(
        provider.tokenExchange({
          subjectToken: 'subject',
          authentication: { clientSecret: 'request-secret' },
        }),
        (error: unknown) => {
          assert(error instanceof ClientException);
          assert.equal(error.errorCode, 'invalid_request');
          assert.equal(error.statusCode, 400);
          return true;
        },
      );
      assert.equal(pluginCalls, 1);
    } finally {
      provider.close();
    }
  });
});
