import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, randomUUID, X509Certificate } from 'node:crypto';
import { CachedResultSupplier } from './cache';
import { CredentialException, isIDaaSException } from './errors';
import { DefaultHttpClient, type HttpClient, checkResponse } from './http';
import { required } from './config';
import {
  type AssertionContext,
  type JwtClientAssertionProvider,
  type OidcTokenProvider,
  type Pkcs7AttestedDocumentProvider,
} from './types';

/** On-demand sensitive string source; each call may return a rotated value. Never log its result. */
export type SecretSupplier = () => string | Promise<string>;

/** Public authentication sources also apply validation and sanitization when used directly. */
async function readCredentialSource(source: string | SecretSupplier): Promise<string> {
  try {
    const value = typeof source === 'function' ? await source() : source;
    if (typeof value !== 'string' || !value.trim())
      throw new CredentialException(
        'Authentication source returned an empty value or invalid type',
        'InvalidCredentialSource',
      );
    return value;
  } catch (error) {
    if (isIDaaSException(error)) throw error;
    throw new CredentialException(
      'Custom authentication source call failed',
      'CredentialSourceFailed',
    );
  }
}

/**
 * Generates HS256 client assertions with jose on Node.js 20/22/24.
 * @remarks jose is loaded on demand through native dynamic import in CJS; public declarations expose no internal jose types.
 * This source neither caches assertions nor owns the caller's SecretSupplier and creates no background resources requiring cleanup.
 */
export class StaticClientSecretAssertionProvider implements JwtClientAssertionProvider {
  /** @param secret - Static client secret or a source invoked for each signature; construction does not read the source. */
  constructor(private readonly secret: string | SecretSupplier) {}
  /**
   * Generates a ten-minute HS256 assertion for the target token endpoint.
   * @param context - Client ID and full token endpoint URL, used for iss/sub and aud respectively.
   * @returns A new compact JWT; iat/exp use Unix seconds and jti is unique per call.
   * @throws CredentialException - The secret source, input, or signature is invalid; raw third-party errors are not propagated.
   */
  async getClientAssertion(context: AssertionContext): Promise<string> {
    const secret = await readCredentialSource(this.secret);
    try {
      const { SignJWT } = await import('jose');
      const now = Math.floor(Date.now() / 1000);
      return await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(context.clientId)
        .setSubject(context.clientId)
        .setAudience(context.tokenEndpoint)
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(new TextEncoder().encode(secret));
    } catch {
      throw new CredentialException(
        'Client secret assertion generation failed',
        'InvalidClientAssertion',
      );
    }
  }
}
/**
 * Generates RSA/EC client assertions with jose, normalizing private keys to PKCS#8 through Node crypto.
 * @remarks RSA requires at least 2048 bits; P-256/P-384/P-521 use ES256/ES384/ES512 respectively.
 * Does not cache assertions or own the private key source lifecycle; construction does not read keys.
 */
export class StaticPrivateKeyAssertionProvider implements JwtClientAssertionProvider {
  /** @param privateKey - Unencrypted PEM private key or a source read for each signature; this interface has no passphrase field. */
  constructor(private readonly privateKey: string | SecretSupplier) {}
  /**
   * Generates a ten-minute private key assertion, using clientId for iss/sub and the full token endpoint for aud.
   * @param context - Current authentication context.
   * @returns A new compact JWT with iat/exp in Unix seconds and a new jti per call.
   * @throws CredentialException - The private key format, size, curve, or signature is invalid.
   * @remarks Custom private key source errors are sanitized; resource ownership is not transferred.
   */
  async getClientAssertion(context: AssertionContext): Promise<string> {
    const pem = await readCredentialSource(this.privateKey);
    try {
      const key = createPrivateKey(pem);
      let alg: string;
      if (key.asymmetricKeyType === 'rsa') {
        if ((key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error('small RSA key');
        alg = 'RS256';
      } else if (key.asymmetricKeyType === 'ec') {
        const algorithms: Record<string, string> = {
          prime256v1: 'ES256',
          secp384r1: 'ES384',
          secp521r1: 'ES512',
        };
        const value = algorithms[key.asymmetricKeyDetails?.namedCurve || ''];
        if (!value) throw new Error('unsupported curve');
        alg = value;
      } else {
        throw new Error('unsupported key');
      }
      const { SignJWT, importPKCS8 } = await import('jose');
      const signingKey = await importPKCS8(
        key.export({ format: 'pem', type: 'pkcs8' }).toString(),
        alg,
      );
      const now = Math.floor(Date.now() / 1000);
      return await new SignJWT({})
        .setProtectedHeader({ alg })
        .setIssuer(context.clientId)
        .setSubject(context.clientId)
        .setAudience(context.tokenEndpoint)
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(signingKey);
    } catch {
      throw new CredentialException(
        'Invalid private key, unsupported algorithm, or signing failure; check RSA key size or EC curve',
        'InvalidPrivateKey',
      );
    }
  }
}

/**
 * Validates that the PCA leaf certificate public key matches the private key; does not replace server trust-chain validation.
 * @param certificate - PEM or base64 DER certificate.
 * @param privateKey - Unencrypted PEM private key.
 * @throws CredentialException - The certificate or private key is invalid, or public keys do not match; errors contain no raw keys.
 */
export function validateCertificateKey(certificate: string, privateKey: string): void {
  try {
    const input = certificate.includes('BEGIN CERTIFICATE')
      ? certificate
      : Buffer.from(certificate, 'base64');
    const publicKey = new X509Certificate(input).publicKey.export({ type: 'spki', format: 'der' });
    const expected = createPublicKey(createPrivateKey(privateKey)).export({
      type: 'spki',
      format: 'der',
    });
    if (!publicKey.equals(expected)) throw new Error('key mismatch');
  } catch {
    throw new CredentialException(
      'PCA certificate and private key do not match or have an invalid format',
      'InvalidCertificate',
    );
  }
}
/**
 * Normalizes an X.509 certificate to base64 DER as a standalone utility.
 * @param certificate - PEM or base64 DER certificate.
 * @returns A base64 DER string without PEM delimiters; does not validate server-side trust or define the PCA wire format.
 * @throws CredentialException - The certificate format is invalid.
 */
export function normalizeCertificate(certificate: string): string {
  try {
    const input = certificate.includes('BEGIN CERTIFICATE')
      ? certificate
      : Buffer.from(certificate, 'base64');
    return new X509Certificate(input).raw.toString('base64');
  } catch {
    throw new CredentialException(
      'Invalid certificate format; provide PEM or base64 DER',
      'InvalidCertificate',
    );
  }
}
/** Validates complete PEM certificate counts and intermediate CA types, without validating trust paths. */
export function validatePemCertificates(pem: string, chain: boolean): void {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const remainder = pem
    .replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '')
    .trim();
  try {
    if (remainder || blocks.length < 1 || blocks.length > (chain ? 5 : 1)) throw new Error();
    for (const block of blocks) {
      const cert = new X509Certificate(block);
      if (chain && !cert.ca) throw new Error();
    }
  } catch {
    throw new CredentialException(
      'Invalid PCA PEM certificate or intermediate CA chain',
      'InvalidCertificateChain',
    );
  }
}
/** OIDC source that rereads files on every request, supporting token file rotation in environments such as Kubernetes. */
export class FileOidcTokenProvider implements OidcTokenProvider {
  /**
   * Stores the file location without reading it during construction.
   * @param path - Defaults to the Kubernetes ServiceAccount token path.
   * @throws ConfigException - The path is empty.
   */
  constructor(private readonly path = '/var/run/secrets/kubernetes.io/serviceaccount/token') {
    required(path, 'oidcTokenFilePath');
  }
  /**
   * Asynchronously rereads the file and trims surrounding whitespace, without caching contents.
   * @returns The current OIDC token.
   * @throws CredentialException - The file cannot be read; errors never expose file contents.
   * @throws ConfigException - The file contents are empty.
   */
  async getOidcToken(): Promise<string> {
    let token: string;
    try {
      token = (await readFile(this.path, 'utf8')).trim();
    } catch {
      throw new CredentialException(
        'OIDC file read failed; check the path and permissions',
        'OidcTokenReadError',
      );
    }
    required(token, 'OIDC Token');
    return token;
  }
}
/** Static or rotating OIDC source; does not validate, refresh, or extend external token validity. */
export class StaticOidcTokenProvider implements OidcTokenProvider {
  /** @param token - Static OIDC token or source invoked on each read; lifecycle remains caller-managed. */
  constructor(private readonly token: string | SecretSupplier) {}
  /**
   * Reads the current external token without creating background resources.
   * @returns A nonempty OIDC token.
   * @throws CredentialException - The source returns an empty value or fails; errors contain no raw source data.
   */
  async getOidcToken(): Promise<string> {
    return readCredentialSource(this.token);
  }
}
/** Static or on-demand PKCS7 document source; does not replace server signature and instance identity validation. */
export class StaticPkcs7AttestedDocumentProvider implements Pkcs7AttestedDocumentProvider {
  /** @param document - Document string or source invoked on each read; source resource ownership is not transferred. */
  constructor(private readonly document: string | SecretSupplier) {}
  /**
   * Reads the current nonempty PKCS7 document without caching custom source results.
   * @returns PKCS7 document.
   * @throws CredentialException - The source returns an empty value or fails; errors contain no raw document.
   */
  async getAttestedDocument(): Promise<string> {
    return readCredentialSource(this.document);
  }
}
/** IMDSv2 metadata read options shared by ECS/EC2 PKCS7 sources. */
export interface MetadataProviderOptions {
  /** Optional shared HTTP instance; provider close leaves it open. */
  httpClient?: HttpClient;
  /** Optional metadata base URL; defaults to the cloud link-local metadata address and can be replaced for controlled validation. */
  metadataEndpoint?: string;
}

/** Uses IMDSv2 without falling back to tokenless metadata access after token retrieval failures. */
abstract class MetadataDocumentProvider implements Pkcs7AttestedDocumentProvider {
  private readonly http: HttpClient;
  private readonly owned: boolean;
  private readonly cache: CachedResultSupplier<string>;
  protected constructor(
    private readonly vendor: 'alibaba' | 'aws',
    private readonly instanceId: string,
    private readonly options: MetadataProviderOptions = {},
  ) {
    this.http = options.httpClient || new DefaultHttpClient();
    this.owned = !options.httpClient;
    this.cache = new CachedResultSupplier(async () => {
      const started = Date.now();
      const value = await this.fetch();
      return { value, expiresAt: started + 3600_000, ttlMs: 3600_000 };
    });
  }
  /**
   * Retrieves a cached identity document or rereads it through IMDSv2.
   * @returns A nonempty PKCS7 document, conservatively cached for one hour from request start without adding network time.
   * @throws IDaaSException - Metadata retrieval fails without a valid cache, or the provider is closed.
   */
  getAttestedDocument(): Promise<string> {
    return this.cache.get();
  }
  private async fetch(): Promise<string> {
    const ali = this.vendor === 'alibaba';
    const endpoint =
      this.options.metadataEndpoint || (ali ? 'http://100.100.100.200' : 'http://169.254.169.254');
    const prefix = ali ? 'X-aliyun-ecs-metadata-token' : 'X-aws-ec2-metadata-token';
    const tokenResponse = await this.http.send({
      url: `${endpoint}/latest/api/token`,
      method: 'PUT',
      headers: { [`${prefix}-ttl-seconds`]: '3600' },
    });
    checkResponse(tokenResponse);
    required(tokenResponse.body, 'metadata token');
    const url = new URL(`${endpoint}/latest/dynamic/instance-identity/pkcs7`);
    if (ali)
      url.searchParams.set(
        'audience',
        JSON.stringify({ aud: this.instanceId, signingTime: Math.floor(Date.now() / 1000) }),
      );
    const response = await this.http.send({
      url: url.href,
      method: 'GET',
      headers: { [prefix]: tokenResponse.body.trim() },
    });
    checkResponse(response);
    required(response.body, 'PKCS7 document');
    // EC2 returns multiline Base64; normalize it consistently across languages to avoid sending newlines on the wire.
    return ali ? response.body.trim() : response.body.replace(/\s/g, '');
  }
  /** Idempotently closes the document cache and owned default HTTP client, leaving injected shared HTTP open. */
  close(): void {
    this.cache.close();
    if (this.owned && this.http instanceof DefaultHttpClient) this.http.close();
  }
}
/** Alibaba Cloud ECS PKCS7 source using IMDSv2 with IDaaS audience/signingTime. */
export class AlibabaCloudEcsAttestedDocumentProvider extends MetadataDocumentProvider {
  /**
   * Creates an ECS document source without sending requests.
   * @param instanceId - IDaaS instance ID used for audience, distinct from the ECS instance ID.
   * @param options - Metadata address and optional shared HTTP; creates and owns HTTP cleanup when none is injected.
   * @throws ConfigException - The IDaaS instance ID is empty.
   */
  constructor(instanceId: string, options: MetadataProviderOptions = {}) {
    required(instanceId, 'idaasInstanceId');
    super('alibaba', instanceId, options);
  }
}
/** AWS EC2 PKCS7 source; never falls back to tokenless metadata access after IMDSv2 token retrieval fails. */
export class AwsEc2Pkcs7AttestedDocumentProvider extends MetadataDocumentProvider {
  /**
   * Creates an EC2 document source without sending requests.
   * @param options - Optional metadata address and shared HTTP; inherited close releases owned HTTP resources.
   */
  constructor(options: MetadataProviderOptions = {}) {
    super('aws', '', options);
  }
}
