import { buildConfiguredUserAgent, buildUserAgent } from './user-agent';
import {
  Agent as HttpAgent,
  type ClientRequest,
  type IncomingMessage,
  request as httpRequest,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import { gunzip, inflate } from 'node:zlib';
import {
  ClientException,
  ConfigException,
  CredentialException,
  HttpException,
  ServerException,
} from './errors';
import { type HttpConfiguration } from './types';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers?: Readonly<Record<string, string>>;
  /** SDK-managed inputs for composing the default User-Agent in the native transport. */
  userAgent?: {
    configuration?: HttpConfiguration;
    additionalComponents?: readonly string[];
  };
  body?: string;
}
export interface HttpResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
}
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

const maxResponseBytes = 2 * 1024 * 1024;
const decodeGzip = promisify(gunzip);
const decodeDeflate = promisify(inflate);

async function readResponse(response: IncomingMessage): Promise<HttpResponse> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const data: Buffer = chunk;
    bytes += data.length;
    if (bytes > maxResponseBytes) throw new Error('HTTP response exceeds the size limit');
    chunks.push(data);
  }
  let body: Buffer = Buffer.concat(chunks, bytes);
  const encoding = response.headers['content-encoding'];
  if (encoding === 'gzip' || encoding === 'deflate') {
    const decode = encoding === 'gzip' ? decodeGzip : decodeDeflate;
    body = await decode(body);
  }
  return {
    statusCode: response.statusCode || 0,
    headers: response.headers,
    body: body.toString('utf8'),
  };
}

/** Default Node HTTP transport without retries or redirects. Each client owns its agents. */
export class DefaultHttpClient implements HttpClient {
  private readonly httpAgent = new HttpAgent({ keepAlive: true });
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true });
  private readonly pending = new Set<ClientRequest>();
  private closed = false;
  private readonly userAgent: string;
  constructor(private readonly config: HttpConfiguration = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new ConfigException('HTTP configuration must be an object', 'InvalidConfiguration');
    }
    if (
      config.unsafeIgnoreSslCert !== undefined &&
      typeof config.unsafeIgnoreSslCert !== 'boolean'
    ) {
      throw new ConfigException('unsafeIgnoreSslCert must be a boolean', 'InvalidConfiguration');
    }
    for (const field of ['connectTimeout', 'readTimeout'] as const) {
      const value = config[field];
      if (value !== undefined && (!Number.isInteger(value) || value < 2000 || value > 60000))
        throw new ConfigException(
          `${field} must be between 2000 and 60000 milliseconds`,
          field === 'connectTimeout' ? 'ConnectTimeoutNotValid' : 'ReadTimeoutNotValid',
        );
    }
    this.userAgent = buildConfiguredUserAgent(config);
    this.config = { ...config };
  }
  async send(request: HttpRequest): Promise<HttpResponse> {
    if (this.closed) throw new HttpException('HTTP client is closed', 'Closed');
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      // Native Node TypeError includes an input field; do not forward potentially sensitive credentials.
      throw new HttpException('Unsupported request URL', 'InvalidEndpoint');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new HttpException('Unsupported request URL', 'InvalidEndpoint');
    const headers = this.buildHeaders(request);
    const tls = url.protocol === 'https:';
    const send = tls ? httpsRequest : httpRequest;
    const connectTimeout = this.config.connectTimeout ?? 5000;
    const readTimeout = this.config.readTimeout ?? 10000;
    let pending: ClientRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<HttpResponse>((resolve, reject) => {
        const outgoing = send(
          url,
          {
            method: request.method,
            headers,
            agent: tls ? this.httpsAgent : this.httpAgent,
            rejectUnauthorized: !this.config.unsafeIgnoreSslCert,
          },
          (response) => {
            void readResponse(response).then(resolve, reject);
          },
        );
        pending = outgoing;
        this.pending.add(outgoing);
        const expire = () => outgoing.destroy(new Error('HTTP request timed out'));
        timer = setTimeout(expire, connectTimeout);
        outgoing.once('error', reject);
        outgoing.once('socket', (socket) => {
          const startRead = () => {
            if (outgoing.destroyed) return;
            clearTimeout(timer);
            timer = setTimeout(expire, readTimeout);
          };
          if (outgoing.reusedSocket || (!tls && !socket.connecting)) startRead();
          else socket.once(tls ? 'secureConnect' : 'connect', startRead);
        });
        outgoing.end(request.body === undefined ? undefined : Buffer.from(request.body));
      });
      if (this.closed) throw new HttpException('HTTP client is closed', 'Closed');
      return result;
    } catch {
      pending?.destroy();
      if (this.closed) throw new HttpException('HTTP client is closed', 'Closed');
      throw new HttpException(
        'HTTP request failed, timed out, or exceeded the response limit; check network and timeout settings',
        'HttpRequestFailed',
      );
    } finally {
      clearTimeout(timer);
      if (pending) this.pending.delete(pending);
    }
  }
  private buildHeaders(request: HttpRequest): Record<string, string> {
    const result: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (name.toLowerCase() === 'user-agent') result['user-agent'] = buildUserAgent(value);
      else result[name] = value;
    }
    const composition = request.userAgent;
    result['user-agent'] ??= composition
      ? buildConfiguredUserAgent(composition.configuration ?? this.config, composition)
      : this.userAgent;
    return result;
  }
  close(): void {
    this.closed = true;
    for (const request of this.pending) request.destroy();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}
// Pass through only protocol codes the SDK recognizes. Unknown response values are untrusted.
const knownErrorCodes = new Set([
  'access_denied',
  'insufficient_scope',
  'invalid_client',
  'invalid_grant',
  'invalid_request',
  'invalid_scope',
  'invalid_target',
  'invalid_token',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_token_type',
  // Developer API response codes for identity, role, and credential checks.
  'application_not_enabled',
  'application_not_found',
  'authentication_token_creator_type_not_supported',
  'authorization_rule_disallowed',
  'authorization_server_not_enabled',
  'client_ability_not_enabled',
  'cloud_account_not_found',
  'cloud_account_role_not_enabled',
  'cloud_account_role_not_found',
  'cloud_vendor_access_credential_already_expired',
  'cloud_vendor_access_credential_missing_expiration',
  'cloud_vendor_access_credential_obtain_failed',
  'credential_not_enabled',
  'credential_not_found',
  'credential_provider_mismatch_operation',
  'credential_provider_not_enabled',
  'credential_provider_not_found',
  'instance_key_not_found',
  'instance_not_found',
  'internal_error',
  'invalid_access_token',
  'invalid_credential_identifier',
  'invalid_duration_seconds',
  'invalid_instance',
  'missing_access_token',
  'missing_credential_identifier',
  'resource_server_not_enabled',
  'trusted_authorization_server_not_found',
  'unauthorized_scope',
  'unsupported_credential_provider',
  'user_exclusive_credential_not_allowed',
  'user_exclusive_credential_unauthorized_access',
  'user_locked',
  'user_not_enabled',
  'user_not_found',
]);

export function checkResponse(response: HttpResponse): void {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  let errorCode = `HTTP_${response.statusCode}`;
  let requestId: string | undefined;
  try {
    const data = JSON.parse(response.body) as Record<string, unknown>;
    const code = data.error_code || data.error || data.code || data.Code;
    const id =
      data.requestId || data.RequestId || data.request_id || response.headers['x-acs-request-id'];
    if (typeof code === 'string' && knownErrorCodes.has(code)) errorCode = code;
    if (typeof id === 'string' && /^[\w-]{1,100}$/.test(id)) requestId = id;
  } catch {
    /* For non-JSON errors, retain only the status and never expose the response body. */
  }
  const ErrorType = response.statusCode >= 500 ? ServerException : ClientException;
  throw new ErrorType(
    `HTTP ${response.statusCode} request failed; use the error code to check permissions or service status`,
    errorCode,
    response.statusCode,
    requestId,
  );
}
export function parseJson<T = unknown>(response: HttpResponse): T {
  checkResponse(response);
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new CredentialException('Server returned invalid JSON', 'InvalidResponse');
  }
}
