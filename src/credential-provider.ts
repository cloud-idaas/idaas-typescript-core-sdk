import { CachedResultSupplier, type CacheOptions } from './cache';
import { registerPluginNames } from './plugin-registry';
import { environment, normalizeScope, record, required, validateConfig } from './config';
import {
  ConfigException,
  CredentialException,
  IDaaSUnexpectedException,
  isIDaaSException,
} from './errors';
import { DefaultHttpClient, type HttpClient, parseJson } from './http';
import { buildConfiguredUserAgent } from './user-agent';
import {
  AlibabaCloudEcsAttestedDocumentProvider,
  AwsEc2Pkcs7AttestedDocumentProvider,
  FileOidcTokenProvider,
  type SecretSupplier,
  StaticClientSecretAssertionProvider,
  StaticPrivateKeyAssertionProvider,
  validateCertificateKey,
  validatePemCertificates,
} from './authentication';
import {
  type IDaaSClientConfig,
  type IDaaSCredential,
  type IDaaSCredentialProvider,
  type JwtClientAssertionProvider,
  type OidcTokenProvider,
  type Pkcs7AttestedDocumentProvider,
  type PluginCredentialProvider,
} from './types';

export interface CredentialProviderOptions {
  httpClient?: HttpClient;
  clientSecretSupplier?: SecretSupplier;
  clientAssertionProvider?: JwtClientAssertionProvider;
  oidcTokenProvider?: OidcTokenProvider;
  attestedDocumentProvider?: Pkcs7AttestedDocumentProvider;
  plugins?: readonly PluginCredentialProvider[];
  cache?: CacheOptions;
}
export interface TokenExchangeOptions {
  subjectToken: string;
  subjectTokenType?: string;
  actorToken?: string;
  actorTokenType?: string;
  requestedTokenType?: string;
  audience?: string;
  scope?: string;
  /** Replaces configured authentication for this request; clientId defaults to the configured ID. */
  authentication?: TokenExchangeAuthentication;
  /** Additional nonempty form fields; fields represented by named options cannot be repeated here. */
  additionalParameters?: Readonly<Record<string, string>>;
}
/** Explicit exchange authentication; the server validates material combinations, trust, and authorization. */
export interface TokenExchangeAuthentication {
  clientId?: string;
  clientSecret?: string;
  clientAssertion?: string;
  clientAssertionType?: string;
  applicationFederatedCredentialName?: string;
  clientX509Certificate?: string;
  x509CertChains?: string;
}
const exchangeAuthenticationFields = {
  clientId: 'client_id',
  clientSecret: 'client_secret',
  clientAssertion: 'client_assertion',
  clientAssertionType: 'client_assertion_type',
  applicationFederatedCredentialName: 'application_federated_credential_name',
  clientX509Certificate: 'client_x509',
  x509CertChains: 'client_x509_chain',
} as const;
const reservedExchangeFields = new Set([
  'grant_type',
  'subject_token',
  'subject_token_type',
  'actor_token',
  'actor_token_type',
  'requested_token_type',
  'audience',
  'scope',
  ...Object.values(exchangeAuthenticationFields),
]);
function validatePrivateJwtAlgorithm(assertion: string): void {
  try {
    const parts = assertion.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error('invalid assertion');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as {
      alg?: unknown;
    };
    if (!['RS256', 'RS384', 'RS512'].includes(String(header.alg)))
      throw new Error('unsupported algorithm');
  } catch {
    throw new CredentialException(
      'PRIVATE_KEY_JWT requires an RSA assertion',
      'InvalidAssertionAlgorithm',
    );
  }
}
/**
 * Validates an OAuth response and conservatively calculates expiration from the request start time.
 * @param input - Untrusted server JSON.
 * @param started - Request start time in Unix milliseconds.
 * @returns Independent credentials with expiresAt in Unix seconds.
 * @throws CredentialException - Fields are missing, types are invalid, or credentials have expired.
 */
export function parseTokenResponse(input: unknown, started = Date.now()): IDaaSCredential {
  const data = record(input);
  const accessToken = data.access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim())
    throw new CredentialException('Response is missing access_token', 'AccessTokenNotFound');
  const expiresIn = data.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0)
    throw new CredentialException('expires_in is invalid', 'InvalidTokenResponse');
  const given = data.expires_at;
  if (given !== undefined && (typeof given !== 'number' || !Number.isFinite(given)))
    throw new CredentialException('expires_at is invalid', 'InvalidTokenResponse');
  const expiresAt = Math.min(
    typeof given === 'number' ? given : Infinity,
    started / 1000 + expiresIn,
  );
  if (expiresAt * 1000 <= Date.now())
    throw new CredentialException('Server returned an expired token', 'InvalidTokenResponse');
  if (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')
    throw new CredentialException('Unsupported token_type', 'InvalidTokenType');
  return { accessToken, tokenType: 'Bearer', expiresIn, expiresAt };
}

/** Machine identity credential source for one scope; warms up during asynchronous retrieval, with no constructor I/O. */
export class IDaaSMachineCredentialProvider implements IDaaSCredentialProvider, OidcTokenProvider {
  private readonly config: IDaaSClientConfig;
  private readonly http: HttpClient;
  private readonly cache: CachedResultSupplier<IDaaSCredential>;
  private readonly secret: SecretSupplier;
  private readonly assertion?: JwtClientAssertionProvider;
  private readonly oidc?: OidcTokenProvider;
  private readonly document?: Pkcs7AttestedDocumentProvider;
  private readonly plugin?: PluginCredentialProvider;
  private readonly ownedDocument: boolean;
  private closed = false;
  /**
   * @param config - JSON configuration with an explicit scope; an independent snapshot is stored internally.
   * @param options - Custom HTTP, authentication sources, plugins, and cache policy; injected resources remain caller-managed.
   * @throws ConfigException - Configuration or authentication sources are incomplete.
   */
  constructor(
    config: IDaaSClientConfig,
    private readonly options: CredentialProviderOptions = {},
  ) {
    this.options = { ...options, plugins: options.plugins ? [...options.plugins] : undefined };
    this.config = validateConfig(config, options);
    const auth = this.config.authnConfiguration;
    this.http = options.httpClient || new DefaultHttpClient(this.config.httpConfiguration);
    this.secret = options.clientSecretSupplier || (() => environment(auth.clientSecretEnvVarName));
    this.assertion =
      options.clientAssertionProvider ||
      (auth.authnMethod === 'CLIENT_SECRET_JWT'
        ? new StaticClientSecretAssertionProvider(this.secret)
        : ['PRIVATE_KEY_JWT', 'PCA'].includes(auth.authnMethod)
          ? new StaticPrivateKeyAssertionProvider(() => environment(auth.privateKeyEnvVarName))
          : undefined);
    this.oidc = options.oidcTokenProvider;
    if (
      !this.oidc &&
      auth.authnMethod === 'OIDC' &&
      (auth.oidcTokenFilePath !== undefined ||
        auth.oidcTokenFilePathEnvVarName !== undefined ||
        ['KUBERNETES', 'ALIBABA_CLOUD_ACK', 'AWS_EKS', 'AWS_ESK'].includes(
          auth.clientDeployEnvironment || '',
        ))
    ) {
      const file =
        auth.oidcTokenFilePath ??
        (auth.oidcTokenFilePathEnvVarName !== undefined
          ? environment(auth.oidcTokenFilePathEnvVarName)
          : undefined);
      this.oidc = new FileOidcTokenProvider(file);
    }
    this.document =
      options.attestedDocumentProvider ||
      (auth.authnMethod === 'PKCS7' && auth.clientDeployEnvironment === 'ALIBABA_CLOUD_ECS'
        ? new AlibabaCloudEcsAttestedDocumentProvider(config.idaasInstanceId, {
            httpClient: this.http,
          })
        : auth.authnMethod === 'PKCS7' && auth.clientDeployEnvironment === 'AWS_EC2'
          ? new AwsEc2Pkcs7AttestedDocumentProvider({ httpClient: this.http })
          : undefined);
    this.ownedDocument = !options.attestedDocumentProvider;
    if (auth.authnMethod === 'OIDC' && !this.oidc)
      throw new ConfigException(
        'This environment requires an injected OidcTokenProvider',
        'MissingOidcTokenProvider',
      );
    if (auth.authnMethod === 'PKCS7' && !this.document)
      throw new ConfigException(
        'This environment requires an injected PKCS7 provider',
        'MissingPkcs7Provider',
      );
    if (auth.authnMethod === 'PLUGIN') {
      const plugins = new Map<string, PluginCredentialProvider>();
      for (const plugin of this.options.plugins || []) registerPluginNames(plugins, plugin);
      this.plugin = plugins.get(auth.pluginName!);
      if (!this.plugin)
        throw new ConfigException('Authentication plugin is not registered', 'PluginNotFound');
    }
    this.cache = new CachedResultSupplier(
      async () => {
        const value = await this.requestToken({
          grant_type: 'client_credentials',
          scope: this.config.scope,
        });
        return { value, expiresAt: value.expiresAt * 1000, ttlMs: value.expiresIn * 1000 };
      },
      { ...options.cache, failureMode: this.config.failureMode },
    );
  }
  /**
   * @returns An independent credential snapshot after refresh and actual-expiration checks, with expiration in Unix seconds.
   * @throws IDaaSException - The provider is closed, authentication fails, or valid credentials cannot be obtained.
   */
  async getCredential(): Promise<IDaaSCredential> {
    const credential = await this.cache.get();
    this.checkAvailable(credential);
    return { ...credential };
  }
  /** @returns The access token sharing the getCredential cache; rejects with SDK exceptions on failure. */
  async getAccessToken(): Promise<string> {
    const credential = await this.getCredential();
    this.checkAvailable(credential);
    return credential.accessToken;
  }
  /** @returns The same access token for downstream federation, without another cache. */
  getOidcToken(): Promise<string> {
    return this.getAccessToken();
  }
  private checkAvailable(credential: IDaaSCredential): void {
    if (this.closed) throw new CredentialException('Credential provider is closed', 'Closed');
    if (credential.expiresAt * 1000 <= Date.now())
      throw new CredentialException(
        'Credentials have reached their actual expiration time',
        'InvalidTokenResponse',
      );
  }
  /**
   * Performs one RFC 8693 token exchange without modifying this scope's client_credentials cache.
   * @param options - Required subjectToken; actorToken requires actorTokenType. Explicit authentication replaces configured sources.
   * @returns Independent credentials from this exchange, with expiresAt in Unix seconds.
   * @throws IDaaSException - Input is invalid, PLUGIN has no explicit exchange authentication, or exchange fails; unknown source errors are sanitized.
   */
  async tokenExchange(options: TokenExchangeOptions): Promise<IDaaSCredential> {
    record(options, 'configuration');
    required(options.subjectToken, 'subjectToken');
    for (const field of [
      'subjectTokenType',
      'actorToken',
      'actorTokenType',
      'requestedTokenType',
      'audience',
      'scope',
    ] as const)
      if (options[field] !== undefined) required(options[field], field);
    if (options.actorToken && !options.actorTokenType)
      throw new ConfigException('actorTokenType must not be empty', 'InvalidTokenExchange');
    let authentication: Record<string, string> | undefined;
    if (options.authentication !== undefined) {
      const entries = Object.entries(record(options.authentication, 'configuration'));
      authentication = {};
      for (const [key, value] of entries) {
        if (!Object.prototype.hasOwnProperty.call(exchangeAuthenticationFields, key))
          throw new ConfigException(
            'Unknown exchange authentication field',
            'InvalidTokenExchange',
          );
        if (value === undefined) continue;
        required(value, 'exchange authentication value');
        authentication[exchangeAuthenticationFields[key as keyof TokenExchangeAuthentication]] =
          value;
      }
      if (!Object.keys(authentication).length)
        throw new ConfigException(
          'Exchange authentication must not be empty',
          'InvalidTokenExchange',
        );
    }
    const additional =
      options.additionalParameters === undefined
        ? {}
        : record(options.additionalParameters, 'configuration');
    const additionalEntries = Object.entries(additional).map(([key, value]) => {
      required(key, 'additional parameter name');
      if (reservedExchangeFields.has(key))
        throw new ConfigException(
          'Use named options for reserved exchange fields',
          'InvalidTokenExchange',
        );
      required(value, 'additional parameter value');
      return [key, value] as const;
    });
    if (this.config.authnConfiguration.authnMethod === 'PLUGIN' && !authentication)
      throw new ConfigException(
        'PLUGIN does not support token exchange',
        'UnsupportedAuthenticationMethod',
      );
    const accessTokenType = 'urn:ietf:params:oauth:token-type:access_token';
    const exchangeScope = normalizeScope(
      options.scope === undefined ? this.config.scope : options.scope,
    );
    return this.requestToken(
      {
        ...Object.fromEntries(additionalEntries),
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: options.subjectToken,
        subject_token_type: options.subjectTokenType || accessTokenType,
        requested_token_type: options.requestedTokenType || accessTokenType,
        scope: exchangeScope,
        ...(options.audience ? { audience: options.audience } : {}),
        ...(options.actorToken
          ? { actor_token: options.actorToken, actor_token_type: options.actorTokenType! }
          : {}),
      },
      authentication,
    );
  }
  private async requestToken(
    form: Record<string, string>,
    authentication?: Record<string, string>,
  ): Promise<IDaaSCredential> {
    try {
      const token = await this.sendTokenRequest(form, authentication);
      if (this.closed) throw new CredentialException('Credential provider is closed', 'Closed');
      if (token.expiresAt * 1000 <= Date.now())
        throw new CredentialException(
          'Credentials have reached their actual expiration time',
          'InvalidTokenResponse',
        );
      return token;
    } catch (error) {
      if (isIDaaSException(error)) throw error;
      throw new IDaaSUnexpectedException(
        'Token request failed; check the custom credential, plugin, or HTTP source',
        'TokenRequestFailed',
      );
    }
  }
  private async sendTokenRequest(
    form: Record<string, string>,
    authentication?: Record<string, string>,
  ): Promise<IDaaSCredential> {
    if (this.closed) throw new CredentialException('Credential provider is closed', 'Closed');
    const auth = this.config.authnConfiguration;
    if (auth.authnMethod === 'PLUGIN' && !authentication) {
      // Plugins receive only independent JSON snapshots; Readonly cannot protect nested configuration or JavaScript callers.
      const snapshot = JSON.parse(JSON.stringify(this.config)) as IDaaSClientConfig;
      const started = Date.now();
      const token = record(await this.plugin!.getToken(snapshot, form.scope!));
      return parseTokenResponse(
        {
          access_token: token.accessToken,
          expires_in: token.expiresIn,
          expires_at: token.expiresAt,
          token_type: token.tokenType,
        },
        started,
      );
    }
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    const coreTransport = this.http.send === DefaultHttpClient.prototype.send;
    if (!coreTransport) {
      headers['user-agent'] = buildConfiguredUserAgent(this.config.httpConfiguration);
    }
    if (authentication) {
      Object.assign(form, { client_id: this.config.clientId }, authentication);
    } else if (auth.authnMethod === 'CLIENT_SECRET_BASIC') {
      const secret = await this.secret();
      required(secret, 'client_secret');
      headers.authorization = `Basic ${Buffer.from(`${this.config.clientId}:${secret}`, 'utf8').toString('base64')}`;
    } else {
      form.client_id = this.config.clientId;
      if (auth.authnMethod === 'CLIENT_SECRET_POST') {
        form.client_secret = await this.secret();
        required(form.client_secret, 'client_secret');
      } else if (['CLIENT_SECRET_JWT', 'PRIVATE_KEY_JWT', 'PCA'].includes(auth.authnMethod)) {
        form.client_assertion_type =
          auth.authnMethod === 'PCA'
            ? 'urn:cloud:idaas:params:oauth:client-assertion-type:x509-jwt-bearer'
            : 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
        if (auth.authnMethod === 'PCA' && !this.options.clientAssertionProvider)
          validateCertificateKey(
            auth.clientX509Certificate!,
            environment(auth.privateKeyEnvVarName),
          );
        form.client_assertion = await this.assertion!.getClientAssertion({
          clientId: this.config.clientId,
          tokenEndpoint: this.config.tokenEndpoint,
        });
        required(form.client_assertion, 'client_assertion');
        if (auth.authnMethod === 'PRIVATE_KEY_JWT')
          validatePrivateJwtAlgorithm(form.client_assertion);
      } else if (auth.authnMethod === 'OIDC') {
        form.client_assertion_type =
          'urn:cloud:idaas:params:oauth:client-assertion-type:id-token-bearer';
        form.client_assertion = await this.oidc!.getOidcToken();
        required(form.client_assertion, 'client_assertion');
      } else if (auth.authnMethod === 'PKCS7') {
        form.client_assertion_type =
          'urn:cloud:idaas:params:oauth:client-assertion-type:pkcs7-bearer';
        form.client_assertion = await this.document!.getAttestedDocument();
        required(form.client_assertion, 'client_assertion');
      }
    }
    if (!authentication && ['OIDC', 'PKCS7', 'PCA'].includes(auth.authnMethod))
      form.application_federated_credential_name = auth.applicationFederatedCredentialName!;
    if (!authentication && auth.authnMethod === 'PCA') {
      validatePemCertificates(auth.clientX509Certificate!, false);
      validatePemCertificates(auth.x509CertChains!, true);
      form.client_x509 = auth.clientX509Certificate!;
      form.client_x509_chain = auth.x509CertChains!;
    }
    const started = Date.now();
    const response = await this.http.send({
      url: this.config.tokenEndpoint,
      method: 'POST',
      headers,
      ...(coreTransport ? { userAgent: { configuration: this.config.httpConfiguration } } : {}),
      body: new URLSearchParams(form).toString(),
    });
    const payload = parseJson(response);
    const credential = parseTokenResponse(payload, started);
    if (form.grant_type !== 'urn:ietf:params:oauth:grant-type:token-exchange') return credential;
    const exchange = record(payload);
    if (exchange.issued_token_type !== 'urn:ietf:params:oauth:token-type:access_token')
      throw new CredentialException('Invalid issued token type', 'InvalidTokenResponse');
    if (typeof exchange.scope !== 'string' || !exchange.scope.trim())
      throw new CredentialException('Exchange response is missing scope', 'InvalidTokenResponse');
    return { ...credential, issuedTokenType: exchange.issued_token_type, scope: exchange.scope };
  }
  /** Idempotently closes the cache and owned HTTP/metadata resources, leaving caller-injected shared resources open. */
  close(): void {
    this.closed = true;
    this.cache.close();
    if (!this.options.httpClient && this.http instanceof DefaultHttpClient) this.http.close();
    if (
      this.ownedDocument &&
      (this.document instanceof AlibabaCloudEcsAttestedDocumentProvider ||
        this.document instanceof AwsEc2Pkcs7AttestedDocumentProvider)
    )
      this.document.close();
  }
}
