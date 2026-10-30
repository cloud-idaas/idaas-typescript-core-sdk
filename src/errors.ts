/** Omits raw requests, responses, and causes to prevent third-party errors from leaking credentials. */
export class IDaaSException extends Error {
  constructor(
    message: string,
    public readonly errorCode = 'IDaaSError',
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class ClientException extends IDaaSException {
  constructor(
    message: string,
    errorCode = 'ClientError',
    public readonly statusCode?: number,
    public readonly requestId?: string,
  ) {
    super(message, errorCode);
  }
}
export class ConfigException extends ClientException {}
export class CredentialException extends IDaaSException {}
export class CacheException extends IDaaSException {}
export class HttpException extends IDaaSException {}
export class ServerException extends IDaaSException {
  constructor(
    message: string,
    errorCode = 'ServerError',
    public readonly statusCode?: number,
    public readonly requestId?: string,
  ) {
    super(message, errorCode);
  }
}
export class IDaaSUnexpectedException extends IDaaSException {}

/** Multiple dependency versions may coexist; identify errors across packages by public fields rather than constructor identity. */
export function isIDaaSException(value: unknown): value is IDaaSException {
  if (!value || typeof value !== 'object') return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error.name === 'string' &&
    typeof error.message === 'string' &&
    typeof error.errorCode === 'string' &&
    /^[\w.-]{1,100}$/.test(error.errorCode)
  );
}
