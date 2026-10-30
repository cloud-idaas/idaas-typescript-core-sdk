import {
  IDaaSClientConfig,
  IDaaSCredentialProviderFactory,
  StaticClientSecretAssertionProvider,
} from '@cloud-idaas/core-sdk';
const config: IDaaSClientConfig = {
  idaasInstanceId: 'instance',
  clientId: 'client',
  issuer: 'https://example.test',
  tokenEndpoint: 'https://example.test/token',
  scope: 'resource|read',
  authnConfiguration: { authnMethod: 'CLIENT_SECRET_POST', clientSecretEnvVarName: 'SECRET' },
};
const factory: IDaaSCredentialProviderFactory = new IDaaSCredentialProviderFactory();
const assertion = new StaticClientSecretAssertionProvider('example-secret');
void [config, factory, assertion];
// @ts-expect-error Public declarations must reject invalid authentication methods.
const invalid: IDaaSClientConfig = { ...config, authnConfiguration: { authnMethod: 'INVALID' } };
const { scope, ...missingScope } = config;
// @ts-expect-error Missing scope must not silently expand permissions.
const requiresScope: IDaaSClientConfig = missingScope;
void [invalid, scope, requiresScope];
