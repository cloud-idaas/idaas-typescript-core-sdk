const scope = process.env.IDAAS_PACKAGE_SCOPE || '@cloud-idaas';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sdk = require(scope + '/core-sdk');

async function main() {
  const esm = await import(scope + '/core-sdk');
  assert.equal(sdk.IDaaSCredentialProviderFactory, esm.IDaaSCredentialProviderFactory);
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
  console.info(`Runtime compatibility passed: ${process.version}, HS256/RS256/ES256, CJS/ESM`);
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
    openApiEndpoint: 'https://openapi.test',
    scope: 'resource|read',
    authnConfiguration: { authnMethod: 'PLUGIN', pluginName: 'runtime' },
  });
  const httpClient = {
    async send(request) {
      assert.equal(request.headers.authorization, 'Bearer runtime-access');
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
  const { AlibabaOpenApiCredentialProvider } = require(
    scope + '/core-alibabacloud-authentication-plugin',
  );
  const plugin = new AlibabaOpenApiCredentialProvider({
    tokenOperation: async () => ({
      body: {
        tokenResponse: {
          accessToken: 'token',
          expiresIn: 3600,
          expiresAt: Date.now() / 1000 + 3600,
        },
      },
    }),
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
