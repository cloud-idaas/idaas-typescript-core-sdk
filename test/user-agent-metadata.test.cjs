const assert = require('node:assert/strict');
const os = require('node:os');
const { createServer } = require('node:http');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const sdk = require('../src');

const metadata = {
  applicationId: 'example app',
  applicationVersion: '2.0+preview',
  deploymentEnvironment: 'custom/env',
  hostname: 'worker-alias',
};
const documented = {
  userAgentApplicationName: metadata.applicationId,
  userAgentApplicationVersion: metadata.applicationVersion,
  userAgentDeploymentEnvironment: metadata.deploymentEnvironment,
  userAgentHostname: metadata.hostname,
};
const config = {
  idaasInstanceId: 'instance',
  clientId: 'client',
  issuer: 'https://issuer.example',
  tokenEndpoint: 'https://issuer.example/token',
  scope: 'resource|read',
  authnConfiguration: { authnMethod: 'CLIENT_SECRET_POST' },
  httpConfiguration: documented,
};
function check(value) {
  assert(value.startsWith(`idaas-typescript-core-sdk/${sdk.getSDKVersion()} (`));
  for (const token of [
    'app/example%20app',
    'app-version/2.0%2Bpreview',
    'deployment/custom%2Fenv',
    'hostname/worker-alias',
  ])
    assert(value.includes(token), value);
}
const response = JSON.stringify({
  access_token: 'access',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'resource|read',
  issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
});
async function exercise(provider) {
  try {
    await provider.getCredential();
    await provider.tokenExchange({ subjectToken: 'subject', scope: 'resource|read' });
  } finally {
    provider.close();
  }
}

function maximumMetadata() {
  const labels = {
    userAgentHostnameEnabled: false,
    userAgentApplicationName: 'a'.repeat(128),
    userAgentApplicationVersion: 'b'.repeat(128),
    userAgentDeploymentEnvironment: 'c'.repeat(128),
  };
  const length = 515 - sdk.buildConfiguredUserAgent(labels).length - ' hostname/'.length;
  const widest = {
    ...labels,
    userAgentHostnameEnabled: true,
    userAgentHostname: 'x'.repeat(length),
  };
  return widest;
}

describe('Diagnostic User-Agent metadata', () => {
  it('deduplicates full SDK components and preserves different versions and full overrides', () => {
    const first = 'idaas-typescript-pam-client-sdk/0.1.0-beta.4';
    const second = 'idaas-typescript-pam-client-sdk/0.1.0-beta.5';
    const core = 'idaas-typescript-core-sdk/' + sdk.getSDKVersion();
    const configuration = { userAgentHostnameEnabled: false };
    const options = { additionalComponents: [first, core, first, second] };
    const header = sdk.buildConfiguredUserAgent(configuration, options).split(' ');
    for (const item of [first, second, core]) {
      assert.equal(header.filter((value) => value === item).length, 1);
    }
    assert(header.indexOf(first) < header.indexOf(second));
    assert.equal(
      sdk.buildConfiguredUserAgent({ ...configuration, userAgent: 'Legacy/2' }, options),
      'Legacy/2',
    );
  });

  it('preserves the historical metadata budget and the raw override limit', () => {
    const widest = maximumMetadata();
    assert.equal(sdk.buildConfiguredUserAgent(widest).length, 515);
    assert(
      sdk
        .buildConfiguredUserAgent(widest, {
          additionalComponents: ['idaas-typescript-pam-client-sdk/0.1.0-beta.3'],
        })
        .endsWith('idaas-typescript-pam-client-sdk/0.1.0-beta.3'),
    );
    assert.throws(() => sdk.buildUserAgent('x'.repeat(513)), { errorCode: 'InvalidUserAgent' });
  });

  it('retains SDK markers and safely encodes arbitrary labels', () => {
    check(sdk.buildUserAgent(undefined, metadata));
    assert(
      sdk
        .buildUserAgent(undefined, { applicationId: '\u4e2d\u6587/()' })
        .includes('app/%E4%B8%AD%E6%96%87%2F%28%29'),
    );
  });
  it('skips local lookup for explicit disable, aliases, and a full replacement', () => {
    const previous = os.hostname;
    let lookups = 0;
    os.hostname = () => {
      lookups += 1;
      return 'unexpected-hostname';
    };
    try {
      assert(!sdk.buildUserAgent(undefined, { hostname: false }).includes('hostname/'));
      check(sdk.buildUserAgent(undefined, metadata));
      assert.equal(sdk.buildUserAgent('Legacy/1', { hostname: true }), 'Legacy/1');
      const disabled = sdk.buildConfiguredUserAgent({
        ...documented,
        userAgentHostnameEnabled: false,
        userAgentMetadata: metadata,
      });
      assert(!disabled.includes('hostname/'));
      assert(disabled.includes(' deployment/custom%2Fenv'));
      check(
        sdk.buildConfiguredUserAgent({
          ...documented,
          userAgentMetadata: { applicationId: 'old', hostname: 'old-host' },
        }),
      );
      assert.equal(lookups, 0);
    } finally {
      os.hostname = previous;
    }
  });
  it('discovers a hostname by default and tolerates lookup failures', () => {
    const previous = os.hostname;
    try {
      os.hostname = () => 'local-node';
      assert(sdk.buildUserAgent().endsWith(' hostname/local-node'));
      assert(sdk.buildUserAgent(undefined, { hostname: true }).endsWith(' hostname/local-node'));
      assert(
        sdk
          .buildConfiguredUserAgent({
            userAgentHostnameEnabled: true,
            userAgentMetadata: { hostname: false },
          })
          .endsWith(' hostname/local-node'),
      );
      const disabled = sdk.buildConfiguredUserAgent({ userAgentHostnameEnabled: false });
      for (const value of ['', 'bad\r\nvalue', 'x'.repeat(129)]) {
        os.hostname = () => value;
        assert.equal(sdk.buildUserAgent(), disabled);
      }
      os.hostname = () => {
        throw new Error('unavailable');
      };
      assert.equal(sdk.buildUserAgent(), disabled);
    } finally {
      os.hostname = previous;
    }
  });
  it('marks unavailable or unsafe runtime fields as unknown', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const arch = Object.getOwnPropertyDescriptor(process, 'arch');
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: undefined });
      Object.defineProperty(process, 'arch', { ...arch, value: 'bad\r\nvalue' });
      assert(
        sdk
          .buildUserAgent()
          .startsWith(
            `idaas-typescript-core-sdk/${sdk.getSDKVersion()} (unknown; unknown) Node.js/`,
          ),
      );
    } finally {
      Object.defineProperty(process, 'platform', platform);
      Object.defineProperty(process, 'arch', arch);
    }
  });
  it('rejects unsafe, malformed, or oversized caller metadata without exposing it', () => {
    for (const value of [null, [], 1, 'text']) {
      assert.throws(() => sdk.buildUserAgent(undefined, value), { errorCode: 'InvalidUserAgent' });
    }
    for (const field of [
      'applicationId',
      'applicationVersion',
      'deploymentEnvironment',
      'hostname',
    ]) {
      for (const value of [
        null,
        1,
        {},
        '',
        ' ',
        'bad\r\nsecret',
        '\u0000',
        '\u007f',
        '\ud800',
        'x'.repeat(129),
      ]) {
        assert.throws(
          () => sdk.buildUserAgent(undefined, { [field]: value }),
          (error) => error.errorCode === 'InvalidUserAgent' && !error.message.includes('secret'),
        );
      }
    }
    assert.throws(
      () =>
        sdk.buildUserAgent(undefined, {
          applicationId: 'x'.repeat(128),
          applicationVersion: 'x'.repeat(128),
          deploymentEnvironment: 'x'.repeat(128),
          hostname: 'x'.repeat(128),
        }),
      { errorCode: 'InvalidUserAgent' },
    );
    for (const [field, value] of [
      ['userAgentHostnameEnabled', 'false'],
      ['userAgentHostname', true],
      ['userAgentApplicationName', null],
      ['userAgentApplicationVersion', 'bad\r\nvalue'],
      ['userAgentDeploymentEnvironment', []],
    ]) {
      assert.throws(() => sdk.buildConfiguredUserAgent({ [field]: value }), {
        errorCode: 'InvalidUserAgent',
      });
    }
    assert.throws(
      () =>
        sdk.validateConfig(
          {
            ...config,
            httpConfiguration: { userAgentMetadata: { applicationId: 'bad\nvalue' } },
          },
          { clientSecretSupplier: () => 'test-secret' },
        ),
      { errorCode: 'InvalidUserAgent' },
    );
  });
  it('distinguishes invalid Unicode from an oversized encoded label', () => {
    assert.throws(() => sdk.buildUserAgent(undefined, { applicationId: 'private-label\ud800' }), {
      errorCode: 'InvalidUserAgent',
      message: 'User-Agent metadata contains invalid Unicode',
    });
    assert.throws(() => sdk.buildUserAgent(undefined, { applicationId: '\u4e2d'.repeat(15) }), {
      errorCode: 'InvalidUserAgent',
      message: 'User-Agent metadata exceeds the header limit',
    });
  });
  it('provides the same header to custom transports for normal and exchange authentication', async () => {
    const requests = [];
    await exercise(
      new sdk.IDaaSMachineCredentialProvider(config, {
        clientSecretSupplier: () => 'test-secret',
        httpClient: {
          async send(request) {
            requests.push(request);
            return { statusCode: 200, headers: {}, body: response };
          },
        },
      }),
    );
    assert.equal(requests.length, 2);
    for (const request of requests) check(request.headers['user-agent']);
    assert.equal(requests[0].headers['user-agent'], requests[1].headers['user-agent']);
  });
  it('sends metadata once on actual token and exchange HTTP requests', async () => {
    const requests = [];
    const server = createServer((request, res) => {
      requests.push({ value: request.headers['user-agent'], raw: request.rawHeaders });
      res.setHeader('connection', 'close');
      res.end(response);
    });
    const dir = await mkdtemp(join(os.tmpdir(), 'idaas-ua-config-'));
    const configFile = join(dir, 'client.json');
    const options = { clientSecretSupplier: () => 'test-secret' };
    const previous = os.hostname;
    os.hostname = () => 'local-node';
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      for (const httpConfiguration of [
        {},
        documented,
        { ...documented, userAgentHostnameEnabled: false },
        { ...documented, userAgent: 'Legacy/2' },
        maximumMetadata(),
      ]) {
        await writeFile(
          configFile,
          JSON.stringify({
            ...config,
            tokenEndpoint: 'http://127.0.0.1:' + server.address().port,
            httpConfiguration,
          }),
        );
        await exercise(
          new sdk.IDaaSMachineCredentialProvider(
            await sdk.loadConfig(configFile, options),
            options,
          ),
        );
      }
      const injectedHttp = new sdk.DefaultHttpClient({ userAgent: 'Transport/1' });
      try {
        await exercise(
          new sdk.IDaaSMachineCredentialProvider(await sdk.loadConfig(configFile, options), {
            ...options,
            httpClient: injectedHttp,
          }),
        );
      } finally {
        injectedHttp.close();
      }
      assert.equal(requests.length, 12);
      for (let index = 0; index < requests.length; index += 2) {
        assert.equal(requests[index].value, requests[index + 1].value);
      }
      assert(requests[0].value.endsWith(' hostname/local-node'));
      check(requests[2].value);
      assert(requests[4].value.includes('app/example%20app'));
      assert(!requests[4].value.includes('hostname/'));
      assert.equal(requests[6].value, 'Legacy/2');
      assert.equal(requests[8].value.length, 515);
      assert.equal(requests[10].value, requests[8].value);
      for (const request of requests) {
        assert.equal(
          request.raw.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'user-agent').length,
          1,
        );
      }
    } finally {
      os.hostname = previous;
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
