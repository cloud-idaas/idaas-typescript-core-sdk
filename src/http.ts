import { buildUserAgent } from './user-agent';
import * as httpx from 'httpx';
import { Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
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

/** Public httpx wrapper without retries or redirects; resources belong only to this instance. */
export class DefaultHttpClient implements HttpClient {
  private readonly httpAgent = new HttpAgent({ keepAlive: true });
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true });
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
    this.userAgent = buildUserAgent(config.userAgent);
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
    const headers = this.buildHeaders(request.headers);
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(),
      (this.config.connectTimeout || 5000) + (this.config.readTimeout || 10000),
    );
    let response: IncomingMessage | undefined;
    try {
      response = await httpx.request(request.url, {
        method: request.method,
        data: request.body === undefined ? undefined : Buffer.from(request.body),
        headers,
        connectTimeout: this.config.connectTimeout || 5000,
        readTimeout: this.config.readTimeout || 10000,
        rejectUnauthorized: !this.config.unsafeIgnoreSslCert,
        agent: url.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
        beforeRequest: (options) => ({ ...options, signal: abort.signal }),
      });
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) response?.destroy(new Error('response limit'));
      });
      const body = await httpx.read(response, '');
      return {
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: body.toString('utf8'),
      };
    } catch {
      response?.destroy();
      throw new HttpException(
        'HTTP request failed, timed out, or exceeded the response limit; check network and timeout settings',
        'HttpRequestFailed',
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private buildHeaders(headers: HttpRequest['headers']): Record<string, string> {
    const result: Record<string, string> = Object.create(null);
    result['user-agent'] = this.userAgent;
    for (const [name, value] of Object.entries(headers || {})) {
      if (name.toLowerCase() === 'user-agent') result['user-agent'] = buildUserAgent(value);
      else result[name] = value;
    }
    return result;
  }
  close(): void {
    this.closed = true;
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}
export function checkResponse(response: HttpResponse): void {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  let errorCode = `HTTP_${response.statusCode}`;
  let requestId: string | undefined;
  try {
    const data = JSON.parse(response.body) as Record<string, unknown>;
    const code = data.error_code || data.error || data.code || data.Code;
    const id = data.requestId || data.RequestId || response.headers['x-acs-request-id'];
    if (typeof code === 'string' && /^[\w.-]{1,100}$/.test(code)) errorCode = code;
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
