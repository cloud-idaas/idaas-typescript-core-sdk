const scope = process.env.IDAAS_PACKAGE_SCOPE || '@cloud-idaas';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sdk = require(scope + '/core-sdk');

async function main() {
  const esm = await import(scope + '/core-sdk');
  assert.equal(sdk.IDaaSCredentialProviderFactory, esm.IDaaSCredentialProviderFactory);
  assert.equal(sdk.getSDKVersion(), esm.getSDKVersion());
  assert.equal(
    sdk.getSDKVersion(),
    JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(require.resolve(scope + '/core-sdk')), '../package.json'),
        'utf8',
      ),
    ).version,
  );
  const context = { clientId: 'runtime-client', tokenEndpoint: 'https://issuer.example/token' };
  const secret = '0123456789abcdef0123456789abcdef';
  const hmac = await new sdk.StaticClientSecretAssertionProvider(secret).getClientAssertion(
    context,
  );
  const [header, payload, signature] = hmac.split('.');
  assert.equal(
    crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'),
    signature,
  );
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.aud, context.tokenEndpoint);
  assert.equal(claims.exp - claims.iat, 600);
  for (const type of ['rsa', 'ec']) {
    const pair =
      type === 'rsa'
        ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
        : crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const provider = new sdk.StaticPrivateKeyAssertionProvider(
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    const [first, second, third] = (await provider.getClientAssertion(context)).split('.');
    assert(
      crypto.verify(
        'sha256',
        Buffer.from(`${first}.${second}`),
        { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(third, 'base64url'),
      ),
    );
  }
  for (const core of [sdk, esm]) {
    const config = {
      clientId: 'runtime-client',
      idaasInstanceId: 'instance',
      issuer: 'https://issuer.example',
      tokenEndpoint: context.tokenEndpoint,
      scope: 'resource|read',
      httpConfiguration: { userAgentMetadata: { applicationId: 'runtime', hostname: false } },
      authnConfiguration: { authnMethod: 'CLIENT_SECRET_BASIC' },
    };
    const provider = new core.IDaaSMachineCredentialProvider(config, {
      clientSecretSupplier: () =>
        assert.fail('Explicit exchange must not read default credentials'),
      httpClient: {
        async send(request) {
          assert.equal(
            request.headers['user-agent'],
            core.buildUserAgent(undefined, config.httpConfiguration.userAgentMetadata),
          );
          const form = new URLSearchParams(request.body);
          assert.equal(request.headers.authorization, undefined);
          assert.equal(form.get('client_id'), config.clientId);
          assert.equal(form.get('client_secret'), 'explicit-secret');
          assert.equal(form.get('extension'), ' +&=');
          return {
            statusCode: 200,
            headers: {},
            body: JSON.stringify({
              access_token: 'runtime-exchange',
              expires_in: 60,
              token_type: 'bearer',
              scope: 'resource|read',
              issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            }),
          };
        },
      },
    });
    try {
      const result = await provider.tokenExchange({
        subjectToken: 'runtime-subject',
        authentication: { clientId: undefined, clientSecret: 'explicit-secret' },
        additionalParameters: { extension: ' +&=' },
      });
      assert.equal(result.scope, 'resource|read');
      assert.equal(result.tokenType, 'Bearer');
    } finally {
      provider.close();
    }
  }
  console.info(
    `Runtime compatibility passed: ${process.version}, HS256/RS256/ES256, CJS/ESM, exchange materials`,
  );
}

async function packageChecks() {
  const names = [
    'core-sdk',
    'pam-client-sdk',
    'core-alibabacloud-authentication-plugin',
    'akless-alibabacloud-adapter',
    'akless-aws-adapter',
    'akless-tencent-adapter',
  ];
  for (const name of names) {
    const cjs = require(scope + '/' + name);
    const esm = await import(scope + '/' + name);
    for (const key of Object.keys(cjs)) assert.equal(cjs[key], esm[key], name + ':' + key);
  }
  const server = require('node:http').createServer((request, response) => {
    assert(
      request.headers['user-agent'].includes('idaas-typescript-core-sdk/' + sdk.getSDKVersion()),
    );
    response.setHeader('connection', 'close');
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const http = new sdk.DefaultHttpClient();
  try {
    assert.equal(
      (
        await http.send({
          url: 'http://127.0.0.1:' + server.address().port,
          method: 'POST',
          body: 'a=b',
        })
      ).body,
      '{"ok":true}',
    );
  } finally {
    http.close();
    await new Promise((resolve) => server.close(resolve));
  }
  const scopes = [];
  sdk.IDaaSCredentialProviderFactory.registerPlugin({
    getName() {
      return 'runtime';
    },
    async getToken(config, scope) {
      scopes.push(scope);
      return {
        accessToken: 'runtime-access',
        tokenType: 'Bearer',
        expiresIn: 3600,
        expiresAt: Date.now() / 1000 + 3600,
      };
    },
  });
  await sdk.IDaaSCredentialProviderFactory.init({
    idaasInstanceId: 'instance',
    clientId: 'client',
    issuer: 'https://issuer.test',
    tokenEndpoint: 'https://issuer.test/token',
    developerApiEndpoint: 'https://pam.test',
    httpConfiguration: {
      userAgentHostnameEnabled: false,
      userAgentApplicationName: 'a'.repeat(128),
      userAgentApplicationVersion: 'b'.repeat(128),
      userAgentDeploymentEnvironment: 'c'.repeat(128),
    },
    openApiEndpoint: 'https://openapi.test',
    scope: 'resource|read',
    authnConfiguration: { authnMethod: 'PLUGIN', pluginName: 'runtime' },
  });
  const component = (name) => {
    const entry = require.resolve(scope + '/' + name);
    const { version } = require(require('node:path').join(entry, '../../package.json'));
    return 'idaas-typescript-' + name + '/' + version;
  };
  const adapters = {
    ali: 'akless-alibabacloud-adapter',
    aws: 'akless-aws-adapter',
    tencent: 'akless-tencent-adapter',
  };
  const httpClient = {
    async send(request) {
      assert.equal(request.headers.authorization, 'Bearer runtime-access');
      const role = new URL(request.url).searchParams.get('cloudAccountRoleExternalId');
      const names = ['core-sdk', 'pam-client-sdk'];
      if (role && adapters[role]) names.push(adapters[role]);
      const expected = names.map(component);
      const actual = request.headers['user-agent']
        .split(' ')
        .filter((field) => field.startsWith('idaas-typescript-'));
      assert.deepEqual(actual, expected);
      assert(request.headers['user-agent'].includes('deployment/' + 'c'.repeat(128)));
      const data = request.url.includes('/credentials/')
        ? { credentialContent: { apiKeyContent: { apiKey: 'key' } } }
        : {
            cloudAccountRoleAccessCredential: {
              accessCredentialExpiresAt: Date.now() / 1000 + 3600,
              alibabaCloudStsToken: {
                accessKeyId: 'ak',
                accessKeySecret: 'sk',
                securityToken: 'session',
              },
              awsStsToken: { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'session' },
              tencentCloudStsToken: { tmpSecretId: 'id', tmpSecretKey: 'key', token: 'session' },
            },
          };
      return { statusCode: 200, headers: {}, body: JSON.stringify(data) };
    },
  };
  const Pam = require(scope + '/pam-client-sdk').IDaaSPamClient;
  const pam = new Pam({ httpClient });
  assert.equal('fetchOAuthAuthenticationToken' in pam, false);
  assert.equal(await pam.getApiKey('credential'), 'key');
  assert.equal(
    (await pam.obtainAccessCredential('pam')).alibabaCloudStsToken.securityToken,
    'session',
  );
  pam.close();
  const Ali = require(
    scope + '/akless-alibabacloud-adapter',
  ).IDaaSPamAlibabaCloudCredentialsProvider;
  const ali = Ali.builder().roleExternalId('ali').httpClient(httpClient).build();
  assert.equal((await ali.toAlibabaCloudCredential().getCredential()).securityToken, 'session');
  ali.close();
  const Aws = require(scope + '/akless-aws-adapter').IDaaSPamAwsCredentialsProvider;
  const aws = Aws.builder().roleExternalId('aws').httpClient(httpClient).build();
  assert.equal((await aws.toAwsCredentialsProvider()()).sessionToken, 'session');
  aws.close();
  const Tc = require(scope + '/akless-tencent-adapter').IDaaSPamTencentCloudCredentialsProvider;
  const tc = Tc.builder().roleExternalId('tencent').httpClient(httpClient).build();
  assert.equal((await tc.getCredential()).secretId, 'id');
  tc.close();
  assert(scopes.includes(sdk.PAM_SCOPE));
  await sdk.IDaaSCredentialProviderFactory.close();
  console.info('All 6 packages passed CJS/ESM identity and shared-default-factory runtime checks');
}

async function parityChecks() {
  const { AlibabaOpenApiCredentialProvider, getSDKVersion: getPluginVersion } = require(
    scope + '/core-alibabacloud-authentication-plugin',
  );
  const plugin = new AlibabaOpenApiCredentialProvider({
    tokenOperation: async (_request, _endpoint, context) => {
      assert(context.userAgent.includes('idaas-typescript-core-sdk/' + sdk.getSDKVersion()));
      assert(
        context.userAgent.includes(
          'idaas-typescript-core-alibabacloud-authentication-plugin/' + getPluginVersion(),
        ),
      );
      assert(context.userAgent.includes('app/runtime-plugin'));
      assert(!context.userAgent.includes('hostname/'));
      assert.equal(
        getPluginVersion(),
        JSON.parse(
          fs.readFileSync(
            path.join(
              path.dirname(require.resolve(scope + '/core-alibabacloud-authentication-plugin')),
              '../package.json',
            ),
            'utf8',
          ),
        ).version,
      );
      return {
        body: {
          tokenResponse: {
            accessToken: 'token',
            expiresIn: 3600,
            expiresAt: Date.now() / 1000 + 3600,
          },
        },
      };
    },
  });
  assert.equal(plugin.getName(), 'alibabacloudPluginCredentialProvider');
  for (const pluginName of [plugin.getName(), ...plugin.getAliases()]) {
    const factory = new sdk.IDaaSCredentialProviderFactory({
      plugins: [plugin],
      cache: { logger: { info() {}, warn() {}, error() {} } },
    });
    try {
      await factory.init({
        idaasInstanceId: 'i',
        clientId: 'c',
        issuer: 'https://issuer.example',
        tokenEndpoint: 'https://issuer.example/token',
        openApiEndpoint: 'https://eiam.example',
        httpConfiguration: {
          userAgentApplicationName: 'runtime-plugin',
          userAgentHostnameEnabled: false,
        },
        scope: 'resource|read',
        authnConfiguration: { authnMethod: 'PLUGIN', pluginName },
      });
      assert.equal(await (await factory.getIDaaSCredentialProvider()).getAccessToken(), 'token');
    } finally {
      await factory.close();
    }
  }
  const provider = new sdk.AwsEc2Pkcs7AttestedDocumentProvider({
    httpClient: {
      async send(request) {
        return {
          statusCode: 200,
          headers: {},
          body: request.method === 'PUT' ? 'token' : 'YWJj\nZGVm',
        };
      },
    },
  });
  try {
    assert.equal(await provider.getAttestedDocument(), 'YWJjZGVm');
  } finally {
    provider.close();
  }
  console.log('Canonical/legacy plugin names and multiline PKCS7 passed:', process.version);
}

main()
  .then(() => (process.argv[2] === '--core-only' ? undefined : packageChecks()))
  .then(() => (process.argv[2] === '--core-only' ? undefined : parityChecks()))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
