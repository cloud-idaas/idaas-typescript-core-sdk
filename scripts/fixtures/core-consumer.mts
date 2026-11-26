import {
  IDaaSClientConfig,
  getSDKVersion,
  buildUserAgent,
  UserAgentMetadata,
  IDaaSCredentialProviderFactory,
  StaticClientSecretAssertionProvider,
  PluginCredentialProvider,
  TokenExchangeOptions,
  validateConfig,
} from '@cloud-idaas/core-sdk';
const config: IDaaSClientConfig = {
  idaasInstanceId: 'instance',
  clientId: 'client',
  issuer: 'https://example.test',
  tokenEndpoint: 'https://example.test/token',
  scope: 'resource|read',
  httpConfiguration: { userAgentMetadata: { applicationId: 'consumer', hostname: false } },
  authnConfiguration: { authnMethod: 'CLIENT_SECRET_POST', clientSecretEnvVarName: 'SECRET' },
};
const factory: IDaaSCredentialProviderFactory = new IDaaSCredentialProviderFactory();
const metadata: UserAgentMetadata = { deploymentEnvironment: 'custom', hostname: 'alias' };
const version: string = getSDKVersion();
const userAgent: string = buildUserAgent(undefined, metadata);
void [version, userAgent];
// @ts-expect-error Hostname collection requires a boolean or an alias string.
const badMetadata: UserAgentMetadata = { hostname: 1 };
void badMetadata;
const assertion = new StaticClientSecretAssertionProvider('example-secret');
void [config, factory, assertion];
// @ts-expect-error Public declarations must reject invalid authentication methods.
const invalid: IDaaSClientConfig = { ...config, authnConfiguration: { authnMethod: 'INVALID' } };
const { scope, ...missingScope } = config;
// @ts-expect-error Missing scope must not silently expand permissions.
const requiresScope: IDaaSClientConfig = missingScope;
void [invalid, scope, requiresScope];
const plugin: PluginCredentialProvider = {
  getName: () => 'consumer',
  getToken: async () => ({ accessToken: 'example', expiresIn: 60, tokenType: 'Bearer' }),
};
const exchange: TokenExchangeOptions = {
  subjectToken: 'example-subject',
  authentication: { clientAssertion: 'example-assertion', clientAssertionType: 'example-type' },
  additionalParameters: { extension: 'value' },
};
const custom = validateConfig(
  { ...config, authnConfiguration: { authnMethod: 'CLIENT_SECRET_POST' } },
  { clientSecretSupplier: () => 'example-secret' },
);
const invalidExchange: TokenExchangeOptions = {
  subjectToken: 'example',
  // @ts-expect-error Additional form values must be strings.
  additionalParameters: { extension: 1 },
};
void [plugin, exchange, custom, invalidExchange];
