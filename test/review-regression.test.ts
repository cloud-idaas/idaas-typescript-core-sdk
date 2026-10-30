import { strict as assert } from 'node:assert';
import {
  CachedResultSupplier,
  AlibabaCloudEcsAttestedDocumentProvider,
  AwsEc2Pkcs7AttestedDocumentProvider,
  ConfigException,
  CredentialException,
  DefaultHttpClient,
  HttpException,
  type IDaaSClientConfig,
  IDaaSCredentialProviderFactory,
  IDaaSMachineCredentialProvider,
  IDaaSUnexpectedException,
  parseTokenResponse,
  record,
  StaticClientSecretAssertionProvider,
  StaticPrivateKeyAssertionProvider,
  StaticOidcTokenProvider,
  StaticPkcs7AttestedDocumentProvider,
  validateConfig,
} from '../src';

const quiet = { info() {}, warn() {}, error() {} };
const config = (): IDaaSClientConfig => ({
  idaasInstanceId: 'instance',
  clientId: 'client',
  issuer: 'https://issuer.example',
  tokenEndpoint: 'https://issuer.example/token',
  scope: 'resource|read',
  authnConfiguration: { authnMethod: 'CLIENT_SECRET_POST', clientSecretEnvVarName: 'SECRET' },
});

describe('Review regression: F-CFG-01 / F-VALID-01 / F-EXC-03', () => {
  it('preserves legacy record error classification while returning English messages', () => {
    for (const field of ['configuration', '\u914d\u7f6e']) {
      assert.throws(() => record(null, field), {
        name: 'ConfigException',
        errorCode: 'InvalidResponse',
        message: 'configuration must be an object',
      });
    }
    assert.throws(() => record([], '\u54cd\u5e94'), {
      name: 'CredentialException',
      errorCode: 'InvalidResponse',
      message: 'response must be an object',
    });
  });
  it('requires explicit scope and preserves cross-language configuration error codes', () => {
    const codes = {
      scope: 'InvalidScope',
      idaasInstanceId: 'IDaaSInstanceIdNotFound',
      clientId: 'ClientIdNotFound',
      issuer: 'IssuerEndpointNotFound',
      tokenEndpoint: 'TokenEndpointNotFound',
      authnConfiguration: 'AuthnConfigurationNotFound',
    };
    for (const [field, errorCode] of Object.entries(codes)) {
      // JSON simulates JavaScript callers with missing fields outside the declaration contract.
      const input = JSON.parse(JSON.stringify({ ...config(), [field]: undefined }));
      assert.throws(() => validateConfig(input), { name: 'ConfigException', errorCode });
    }
    for (const field of ['connectTimeout', 'readTimeout']) {
      assert.throws(() => validateConfig({ ...config(), httpConfiguration: { [field]: 0 } }), {
        errorCode: field === 'connectTimeout' ? 'ConnectTimeoutNotValid' : 'ReadTimeoutNotValid',
      });
    }
    assert.throws(() => validateConfig({ ...config(), scope: ' ' }), { errorCode: 'InvalidScope' });
  });
  it('classifies missing and invalid tokens as credential errors rather than configuration errors', () => {
    assert.throws(() => parseTokenResponse({ expires_in: 100 }), CredentialException);
    assert.throws(
      () => parseTokenResponse({ access_token: 'ok', expires_in: 100, token_type: 'bad' }),
      { name: 'CredentialException', errorCode: 'InvalidTokenType' },
    );
  });
});

describe('Review regression: token type contract R-04 / R-05', () => {
  it('requires Bearer, normalizes letter casing, and rejects missing or other token types', () => {
    const response = { access_token: 'offline', expires_in: 60 };
    assert.throws(() => parseTokenResponse(response), { errorCode: 'InvalidTokenType' });
    for (const tokenType of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
      assert.equal(parseTokenResponse({ ...response, token_type: tokenType }).tokenType, 'Bearer');
    }
    for (const tokenType of ['', 'Basic', null, 42]) {
      assert.throws(() => parseTokenResponse({ ...response, token_type: tokenType }), {
        errorCode: 'InvalidTokenType',
      });
    }
  });
});

describe('Review regression: F-EXPIRY-05 / TS-ASYNC-05', () => {
  it('removes internal whitespace from EC2 multiline PKCS7 Base64 consistently across languages', async () => {
    const provider = new AwsEc2Pkcs7AttestedDocumentProvider({
      httpClient: {
        async send(request) {
          return {
            statusCode: 200,
            headers: {},
            body: request.method === 'PUT' ? 'token' : '\nYWJj\r\n ZGVm\t',
          };
        },
      },
    });
    try {
      assert.equal(await provider.getAttestedDocument(), 'YWJjZGVm');
    } finally {
      provider.close();
    }
  });
  it('does not extend PKCS7 document cache validity by metadata request duration', async () => {
    const original = Date.now;
    let now = original();
    const started = now;
    let fail = false;
    Date.now = () => now;
    const provider = new AlibabaCloudEcsAttestedDocumentProvider('instance', {
      httpClient: {
        async send(request) {
          if (fail) throw new Error('metadata down');
          if (request.method === 'GET') now += 2000;
          return {
            statusCode: 200,
            headers: {},
            body: request.method === 'GET' ? 'document' : 'token',
          };
        },
      },
    });
    try {
      assert.equal(await provider.getAttestedDocument(), 'document');
      now = started + 3600000;
      fail = true;
      await assert.rejects(provider.getAttestedDocument());
    } finally {
      provider.close();
      Date.now = original;
    }
  });
  it('rejects refreshed credentials when logging crosses hard expiration', async () => {
    let now = 0;
    const cache = new CachedResultSupplier(async () => ({ value: 'new', expiresAt: 1000 }), {
      clock: () => now,
      random: () => 0,
      logger: {
        ...quiet,
        info() {
          now = 1000;
        },
      },
    });
    await assert.rejects(cache.get(), { errorCode: 'InvalidExpiration' });
    cache.close();
  });
  it('rejects cached values when fallback logging reaches hard expiration', async () => {
    let now = 0;
    let fail = false;
    const cache = new CachedResultSupplier(
      async () => {
        if (fail) throw new Error('down');
        return { value: 'old', expiresAt: 1000 };
      },
      {
        clock: () => now,
        random: () => 0,
        logger: {
          ...quiet,
          warn(event) {
            if (event === 'credential_degradation') now = 1000;
          },
        },
      },
    );
    await cache.get();
    now = 850;
    fail = true;
    await assert.rejects(cache.get(), { errorCode: 'InvalidExpiration' });
    cache.close();
  });
  it('rejects refreshed credentials when a log callback closes the cache', async () => {
    const cache = new CachedResultSupplier(async () => ({ value: 'new', expiresAt: 1000 }), {
      clock: () => 0,
      logger: {
        ...quiet,
        info() {
          cache.close();
        },
      },
    });
    await assert.rejects(cache.get(), { errorCode: 'Closed' });
  });
  it('does not extend cache validity when the refresh source mutates its original envelope', async () => {
    let now = 0;
    let calls = 0;
    const result = { value: 'old', expiresAt: 1000 };
    const cache = new CachedResultSupplier(
      async () => {
        if (++calls > 1) throw new Error('down');
        return result;
      },
      { clock: () => now, random: () => 0, logger: quiet },
    );
    assert.equal(await cache.get(), 'old');
    result.expiresAt = 100000;
    now = 1000;
    await assert.rejects(cache.get());
    cache.close();
  });
  it('rejects misspelled cache modes and invalid clocks instead of silently using lenient mode', async () => {
    assert.throws(
      () =>
        new CachedResultSupplier(
          async () => ({ value: 'ok', expiresAt: 1000 }),
          JSON.parse('{"failureMode":"STRICTT"}'),
        ),
      ConfigException,
    );
    const cache = new CachedResultSupplier(async () => ({ value: 'ok', expiresAt: 1000 }), {
      clock: () => NaN,
    });
    await assert.rejects(cache.get(), { errorCode: 'InvalidClock' });
    cache.close();
  });
});

describe('Review regression: TS-ERR-01/02 / TS-TYPE-05', () => {
  it('shares the registry between canonical plugin names and aliases without partial registration on conflicts', async () => {
    const token = {
      accessToken: 'ok',
      tokenType: 'Bearer',
      expiresIn: 3600,
      expiresAt: Date.now() / 1000 + 3600,
    };
    const factory = new IDaaSCredentialProviderFactory({
      cache: { logger: quiet },
      plugins: [
        { getName: () => 'canonical', getAliases: () => ['legacy'], getToken: async () => token },
      ],
    });
    const second = {
      getName: () => 'second',
      getAliases: () => ['legacy'],
      getToken: async () => token,
    };
    assert.throws(() => factory.registerPlugin(second), { errorCode: 'DuplicatePlugin' });
    // If second were stored before the conflict check, this valid registration would falsely fail as a duplicate.
    factory.registerPlugin({ ...second, getAliases: () => [] });
    try {
      await factory.init({
        ...config(),
        openApiEndpoint: 'https://eiam.example',
        authnConfiguration: { authnMethod: 'PLUGIN', pluginName: 'legacy' },
      });
      assert.equal(await (await factory.getIDaaSCredentialProvider()).getAccessToken(), 'ok');
    } finally {
      await factory.close();
    }
  });
  it('sanitizes third-party errors when public OIDC, PKCS7, and JWT sources are used directly', async () => {
    const fail = async (): Promise<string> => {
      throw new Error('SECRET_VALUE');
    };
    const context = { clientId: 'client', tokenEndpoint: 'https://issuer.example/token' };
    const operations = [
      () => new StaticClientSecretAssertionProvider(fail).getClientAssertion(context),
      () => new StaticPrivateKeyAssertionProvider(fail).getClientAssertion(context),
      () => new StaticOidcTokenProvider(fail).getOidcToken(),
      () => new StaticPkcs7AttestedDocumentProvider(fail).getAttestedDocument(),
    ];
    for (const operation of operations)
      await assert.rejects(operation(), (error: unknown) => {
        assert(error instanceof CredentialException);
        assert(!String(error).includes('SECRET_VALUE'));
        assert(!JSON.stringify(error).includes('SECRET_VALUE'));
        return true;
      });
  });
  it('rejects explicit empty token exchange scope instead of falling back to default permissions', async () => {
    const provider = new IDaaSMachineCredentialProvider(config(), {
      clientSecretSupplier: () => 'secret',
      httpClient: {
        async send() {
          throw new Error('must not send');
        },
      },
    });
    try {
      await assert.rejects(provider.tokenExchange({ subjectToken: 'subject', scope: '' }), {
        errorCode: 'InvalidScope',
      });
    } finally {
      provider.close();
    }
  });
  it('sanitizes unknown HTTP and credential source errors during token exchange', async () => {
    for (const source of ['http', 'secret']) {
      const provider = new IDaaSMachineCredentialProvider(config(), {
        clientSecretSupplier() {
          if (source === 'secret') throw new Error('SECRET_VALUE');
          return 'ok';
        },
        httpClient: {
          async send() {
            throw new Error('SECRET_VALUE');
          },
        },
        cache: { logger: quiet },
      });
      try {
        await assert.rejects(
          provider.tokenExchange({ subjectToken: 'subject' }),
          (error: unknown) => {
            assert(error instanceof IDaaSUnexpectedException);
            assert(!JSON.stringify(error).includes('SECRET_VALUE'));
            assert(!error.message.includes('SECRET_VALUE'));
            return true;
          },
        );
      } finally {
        provider.close();
      }
    }
  });
  it('classifies invalid HTTP URLs consistently without exposing the original input', async () => {
    const client = new DefaultHttpClient();
    try {
      await assert.rejects(
        client.send({ url: 'SECRET_VALUE', method: 'GET' }),
        (error: unknown) => {
          assert(error instanceof HttpException);
          assert.equal(error.errorCode, 'InvalidEndpoint');
          assert(!JSON.stringify(error).includes('SECRET_VALUE'));
          return true;
        },
      );
    } finally {
      client.close();
    }
  });
  it('prevents plugin mutations of nested configuration and endpoints from changing later authentication', async () => {
    const started = Date.now();
    let now = started;
    let calls = 0;
    const settings: IDaaSClientConfig = {
      ...config(),
      openApiEndpoint: 'https://eiam.example',
      authnConfiguration: { authnMethod: 'PLUGIN', pluginName: 'custom' },
    };
    const provider = new IDaaSMachineCredentialProvider(settings, {
      cache: { clock: () => now, random: () => 0, logger: quiet },
      httpClient: {
        async send() {
          throw new Error('wrong authentication branch');
        },
      },
      plugins: [
        {
          getName: () => 'custom',
          async getToken(snapshot) {
            calls++;
            assert.equal(snapshot.authnConfiguration.authnMethod, 'PLUGIN');
            snapshot.authnConfiguration.authnMethod = 'CLIENT_SECRET_POST';
            return {
              accessToken: `token-${calls}`,
              tokenType: 'Bearer',
              expiresIn: 3600,
              expiresAt: started / 1000 + 3600,
            };
          },
        },
      ],
    });
    try {
      assert.equal(await provider.getAccessToken(), 'token-1');
      now = started + 3000000;
      assert.equal(await provider.getAccessToken(), 'token-2');
      assert.equal(calls, 2);
    } finally {
      provider.close();
    }
  });
});
