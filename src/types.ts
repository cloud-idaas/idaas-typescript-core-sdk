export const TokenAuthnMethod = {
  CLIENT_SECRET_BASIC: 'CLIENT_SECRET_BASIC',
  CLIENT_SECRET_POST: 'CLIENT_SECRET_POST',
  CLIENT_SECRET_JWT: 'CLIENT_SECRET_JWT',
  PRIVATE_KEY_JWT: 'PRIVATE_KEY_JWT',
  PKCS7: 'PKCS7',
  OIDC: 'OIDC',
  PCA: 'PCA',
  PLUGIN: 'PLUGIN',
} as const;
export type TokenAuthnMethod = (typeof TokenAuthnMethod)[keyof typeof TokenAuthnMethod];
export const ClientDeployEnvironment = {
  COMMON: 'COMMON',
  COMPUTER: 'COMPUTER',
  CUSTOM: 'CUSTOM',
  KUBERNETES: 'KUBERNETES',
  ALIBABA_CLOUD_ECS: 'ALIBABA_CLOUD_ECS',
  ALIBABA_CLOUD_ECI: 'ALIBABA_CLOUD_ECI',
  ALIBABA_CLOUD_ACK: 'ALIBABA_CLOUD_ACK',
  AWS_EC2: 'AWS_EC2',
  AWS_EKS: 'AWS_EKS',
  AWS_ESK: 'AWS_ESK',
  GOOGLE_VM: 'GOOGLE_VM',
  HUAWEI_CLOUD_ECS: 'HUAWEI_CLOUD_ECS',
} as const;
export type ClientDeployEnvironment =
  (typeof ClientDeployEnvironment)[keyof typeof ClientDeployEnvironment];
export interface IdentityAuthenticationConfiguration {
  authnMethod: TokenAuthnMethod;
  identityType?: 'CLIENT';
  clientSecretEnvVarName?: string;
  privateKeyEnvVarName?: string;
  applicationFederatedCredentialName?: string;
  clientDeployEnvironment?: ClientDeployEnvironment;
  oidcTokenFilePath?: string;
  oidcTokenFilePathEnvVarName?: string;
  clientX509Certificate?: string;
  x509CertChains?: string;
  pluginName?: string;
}
export interface HttpConfiguration {
  /** Optional User-Agent replacement (1-512 printable ASCII characters); default includes Core and runtime versions. */
  userAgent?: string;
  /** Milliseconds, between 2000 and 60000. */
  connectTimeout?: number;
  readTimeout?: number;
  unsafeIgnoreSslCert?: boolean;
}
export interface IDaaSClientConfig {
  idaasInstanceId: string;
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
  /** Default scope, which must be provided explicitly; the SDK never implicitly expands to full PAM permissions. */
  scope: string;
  developerApiEndpoint?: string;
  openApiEndpoint?: string;
  authnConfiguration: IdentityAuthenticationConfiguration;
  httpConfiguration?: HttpConfiguration;
  failureMode?: 'LENIENT' | 'STRICT';
}
/** Server expiration values use Unix seconds; the internal cache explicitly converts them to milliseconds. */
export interface IDaaSCredential {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  expiresAt: number;
}
export interface IDaaSCredentialProvider {
  getCredential(): Promise<IDaaSCredential>;
  getAccessToken(): Promise<string>;
}
export interface OidcTokenProvider {
  getOidcToken(): Promise<string>;
}
export interface Pkcs7AttestedDocumentProvider {
  getAttestedDocument(): Promise<string>;
}
export interface AssertionContext {
  clientId: string;
  tokenEndpoint: string;
}
export interface JwtClientAssertionProvider {
  getClientAssertion(context: AssertionContext): Promise<string>;
}
export interface PluginCredentialProvider {
  /** Stable canonical name for cross-language configuration. */
  getName(): string;
  /** Optional legacy names, returned synchronously without identity reads or I/O. Canonical names and aliases must be unique. */
  getAliases?(): readonly string[];
  getToken(config: Readonly<IDaaSClientConfig>, scope: string): Promise<IDaaSCredential>;
}
export interface Logger {
  info(event: string, fields: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields: Readonly<Record<string, unknown>>): void;
  error(event: string, fields: Readonly<Record<string, unknown>>): void;
}
export const PAM_SCOPE = 'urn:cloud:idaas:pam|.all';
