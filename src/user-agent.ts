import { ConfigException } from './errors';
import { SDK_VERSION } from './sdk-version';

/**
 * Builds the default Core SDK identification or validates a caller-supplied User-Agent.
 * @param userAgent - Optional replacement, containing 1-512 printable ASCII characters.
 * @returns The replacement or the installed Core version, Node.js version, OS, and architecture.
 * @throws ConfigException - A supplied value is empty, too long, or contains invalid header characters.
 */
export function buildUserAgent(userAgent?: string): string {
  const value =
    userAgent === undefined
      ? `cloud-idaas-typescript/${SDK_VERSION} Node.js/${process.versions.node} OS(${process.platform}; ${process.arch})`
      : userAgent;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    !/^[\x20-\x7e]+$/.test(value)
  )
    throw new ConfigException(
      'userAgent must contain 1-512 printable ASCII characters',
      'InvalidUserAgent',
    );
  return value.trim();
}
