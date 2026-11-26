import {
  IDaaSClientConfig,
  getSDKVersion,
  buildUserAgent,
  UserAgentMetadata,
  IDaaSCredentialProviderFactory,
  StaticClientSecretAssertionProvider,
} from '@cloud-idaas/core-sdk';
import { IDaaSPamClient } from '@cloud-idaas/pam-client-sdk';
import {
  AlibabaOpenApiCredentialProvider,
  getSDKVersion as getPluginVersion,
} from '@cloud-idaas/core-alibabacloud-authentication-plugin';
import { createAlibabaCloudCredentialsProvider } from '@cloud-idaas/akless-alibabacloud-adapter';
import { createAwsCredentialsProvider } from '@cloud-idaas/akless-aws-adapter';
import { createTencentCloudCOSCredentialsProvider } from '@cloud-idaas/akless-tencent-adapter';
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
const pluginVersion: string = getPluginVersion();
const customPlugin = new AlibabaOpenApiCredentialProvider({
  tokenOperation: async (_request, _endpoint, context) => {
    const header: string = context.userAgent;
    return { header };
  },
});
void [pluginVersion, customPlugin];
// @ts-expect-error Hostname collection requires a boolean or an alias string.
const badMetadata: UserAgentMetadata = { hostname: 1 };
void badMetadata;
const assertion = new StaticClientSecretAssertionProvider('secret');
void [
  config,
  factory,
  assertion,
  IDaaSPamClient,
  AlibabaOpenApiCredentialProvider,
  createAlibabaCloudCredentialsProvider,
  createAwsCredentialsProvider,
  createTencentCloudCOSCredentialsProvider,
];

// @ts-expect-error Public types must reject invalid authentication enum values.
const invalid: IDaaSClientConfig = { ...config, authnConfiguration: { authnMethod: 'INVALID' } };
void invalid;

const { scope, ...missingScope } = config;
// @ts-expect-error scope is required; PAM permissions must not be expanded implicitly.
const scopeRequired: IDaaSClientConfig = missingScope;
void [scope, scopeRequired];
declare const pam: IDaaSPamClient;
const apiKey: Promise<string | null> = pam.getApiKey('id');
void apiKey;

// @ts-expect-error Deprecated PAM OAuth methods must not appear in CJS/ESM public declarations.
pam.fetchOAuthAuthenticationToken('provider');
