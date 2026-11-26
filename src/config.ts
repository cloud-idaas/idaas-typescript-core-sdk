import { buildConfiguredUserAgent } from './user-agent';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigException, CredentialException } from './errors';
import { ClientDeployEnvironment, type IDaaSClientConfig, TokenAuthnMethod } from './types';
import type { CredentialProviderOptions } from './credential-provider';

const REQUIRED_ERROR_CODES: Readonly<Record<string, string>> = {
  idaasInstanceId: 'IDaaSInstanceIdNotFound',
  clientId: 'ClientIdNotFound',
  issuer: 'IssuerEndpointNotFound',
  tokenEndpoint: 'TokenEndpointNotFound',
  developerApiEndpoint: 'DeveloperApiEndpointNotFound',
  openApiEndpoint: 'OpenApiEndpointNotFound',
  scope: 'InvalidScope',
  clientSecretEnvVarName: 'ClientSecretEnvVarNameNotFound',
  privateKeyEnvVarName: 'PrivateKeyEnvVarNameNotFound',
  applicationFederatedCredentialName: 'ApplicationFederatedCredentialNameNotFound',
  clientDeployEnvironment: 'ClientDeployEnvironmentNotFound',
  clientX509Certificate: 'ClientX509CertificateNotFound',
  x509CertChains: 'X509CertChainsNotFound',
  pluginName: 'PluginNameNotFound',
};

export function required(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigException(
      `${field} must not be empty; check the configuration or credential source`,
      REQUIRED_ERROR_CODES[field] || 'InvalidConfiguration',
    );
  }
}
export function record(value: unknown, field = 'response'): Record<string, unknown> {
  // Preserve legacy caller labels while keeping public error messages in English.
  const label =
    field === '\u914d\u7f6e' ? 'configuration' : field === '\u54cd\u5e94' ? 'response' : field;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const ErrorType =
      label === 'configuration' || label === 'authnConfiguration'
        ? ConfigException
        : CredentialException;
    throw new ErrorType(
      `${label} must be an object`,
      label === 'authnConfiguration' ? 'AuthnConfigurationNotFound' : 'InvalidResponse',
    );
  }
  return value as Record<string, unknown>;
}
export function normalizeScope(scope: string): string {
  required(scope, 'scope');
  const values = scope.trim().split(/\s+/);
  if (values.some((value) => !/^[^\s|]+\|[^\s|]+$/.test(value))) {
    throw new ConfigException(
      'scope must use resourceServerIdentifier|scope, with multiple values separated by spaces',
      'InvalidScope',
    );
  }
  return [...new Set(values)].sort().join(' ');
}
export function endpointUrl(value: string): URL {
  required(value, 'endpoint');
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new ConfigException('endpoint is not a valid URL', 'InvalidEndpoint');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ConfigException(
      'endpoint must be an HTTP(S) URL without credentials, query parameters, or fragments',
      'InvalidEndpoint',
    );
  }
  return url;
}
export function environment(name: string | undefined): string {
  required(name, 'environment variable name');
  const value = process.env[name];
  required(value, `environment variable ${name}`);
  return value;
}
/** Validates configuration against the selected sources without reading credentials. */
export function validateConfig(
  input: IDaaSClientConfig,
  sources: CredentialProviderOptions = {},
): IDaaSClientConfig {
  record(input, 'configuration');
  let config: IDaaSClientConfig;
  try {
    config = JSON.parse(JSON.stringify(input)) as IDaaSClientConfig;
  } catch {
    throw new ConfigException('Configuration must be JSON-serializable', 'InvalidConfiguration');
  }
  record(config, 'configuration');
  for (const field of ['idaasInstanceId', 'clientId', 'issuer', 'tokenEndpoint'] as const)
    required(config[field], field);
  endpointUrl(config.issuer);
  endpointUrl(config.tokenEndpoint);
  if (!config.tokenEndpoint.includes('://'))
    throw new ConfigException('tokenEndpoint must include a URL scheme', 'InvalidEndpoint');
  config.scope = normalizeScope(config.scope);
  if (config.developerApiEndpoint !== undefined) endpointUrl(config.developerApiEndpoint);
  if (config.openApiEndpoint !== undefined) endpointUrl(config.openApiEndpoint);
  const auth = config.authnConfiguration;
  record(auth, 'authnConfiguration');
  if (!Object.values(TokenAuthnMethod).includes(auth.authnMethod))
    throw new ConfigException('Unsupported authnMethod', 'UnsupportedAuthenticationMethod');
  if (auth.identityType !== undefined && auth.identityType !== 'CLIENT')
    throw new ConfigException(
      'This version supports only CLIENT identities',
      'UnsupportedIdentity',
    );
  for (const [source, method] of [
    [sources.clientAssertionProvider, 'getClientAssertion'],
    [sources.oidcTokenProvider, 'getOidcToken'],
    [sources.attestedDocumentProvider, 'getAttestedDocument'],
  ] as const) {
    if (
      source !== undefined &&
      (!source || typeof source[method as keyof typeof source] !== 'function')
    )
      throw new ConfigException('Invalid authentication source', 'InvalidConfiguration');
  }
  if (
    sources.clientSecretSupplier !== undefined &&
    typeof sources.clientSecretSupplier !== 'function'
  )
    throw new ConfigException('Invalid client secret source', 'InvalidConfiguration');
  if (
    auth.authnMethod.startsWith('CLIENT_SECRET_') &&
    !sources.clientSecretSupplier &&
    !(auth.authnMethod === 'CLIENT_SECRET_JWT' && sources.clientAssertionProvider)
  )
    required(auth.clientSecretEnvVarName, 'clientSecretEnvVarName');
  if (['PRIVATE_KEY_JWT', 'PCA'].includes(auth.authnMethod) && !sources.clientAssertionProvider)
    required(auth.privateKeyEnvVarName, 'privateKeyEnvVarName');
  if (['PCA', 'OIDC', 'PKCS7'].includes(auth.authnMethod))
    required(auth.applicationFederatedCredentialName, 'applicationFederatedCredentialName');
  const fileOidc = auth.authnMethod === 'OIDC' && !sources.oidcTokenProvider;
  if (fileOidc) {
    if (auth.oidcTokenFilePath !== undefined) required(auth.oidcTokenFilePath, 'oidcTokenFilePath');
    else if (auth.oidcTokenFilePathEnvVarName !== undefined)
      required(auth.oidcTokenFilePathEnvVarName, 'oidcTokenFilePathEnvVarName');
  }
  const needsEnvironment =
    (fileOidc &&
      auth.oidcTokenFilePath === undefined &&
      auth.oidcTokenFilePathEnvVarName === undefined) ||
    (auth.authnMethod === 'PKCS7' && !sources.attestedDocumentProvider);
  if (needsEnvironment) {
    required(auth.clientDeployEnvironment, 'clientDeployEnvironment');
    if (!Object.values(ClientDeployEnvironment).includes(auth.clientDeployEnvironment))
      throw new ConfigException(
        'Unsupported clientDeployEnvironment',
        'UnsupportedClientDeployEnvironment',
      );
  }
  if (auth.authnMethod === 'PCA') {
    required(auth.clientX509Certificate, 'clientX509Certificate');
    required(auth.x509CertChains, 'x509CertChains');
  }
  if (auth.authnMethod === 'PLUGIN') {
    required(auth.pluginName, 'pluginName');
  }
  if (config.httpConfiguration !== undefined) record(config.httpConfiguration, 'configuration');
  const http = (config.httpConfiguration = {
    connectTimeout: 5000,
    readTimeout: 10000,
    unsafeIgnoreSslCert: false,
    ...config.httpConfiguration,
  });
  for (const field of ['connectTimeout', 'readTimeout'] as const) {
    const value = http[field];
    if (!Number.isInteger(value) || value < 2000 || value > 60000)
      throw new ConfigException(
        `${field} must be between 2000 and 60000 milliseconds`,
        field === 'connectTimeout' ? 'ConnectTimeoutNotValid' : 'ReadTimeoutNotValid',
      );
  }
  buildConfiguredUserAgent(http);
  if (typeof http.unsafeIgnoreSslCert !== 'boolean')
    throw new ConfigException('unsafeIgnoreSslCert must be a boolean', 'InvalidConfiguration');
  config.failureMode = config.failureMode === undefined ? 'LENIENT' : config.failureMode;
  if (!['STRICT', 'LENIENT'].includes(config.failureMode))
    throw new ConfigException('Unsupported failureMode', 'InvalidConfiguration');
  return config;
}
/** Loads JSON configuration and validates only the dependencies of the selected sources. */
export async function loadConfig(
  path?: string,
  sources: CredentialProviderOptions = {},
): Promise<IDaaSClientConfig> {
  const location =
    path ||
    process.env.CLOUD_IDAAS_CONFIG_PATH ||
    join(homedir(), '.cloud_idaas', 'client-config.json');
  let data: IDaaSClientConfig;
  try {
    data = JSON.parse(await readFile(location, 'utf8')) as IDaaSClientConfig;
  } catch {
    throw new ConfigException(
      'Unable to read JSON configuration; check the file path, permissions, and format',
      'LoadConfigFileFailed',
    );
  }
  return validateConfig(data, sources);
}
