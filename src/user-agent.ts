import { ConfigException } from './errors';
import { SDK_VERSION } from './sdk-version';
import { hostname } from 'node:os';
import { type HttpConfiguration, type UserAgentMetadata } from './types';

const maxHeaderLength = 512;
const coreComponentName = 'idaas-typescript-core-sdk';
// Preserve the metadata budget when emitting the longer canonical name.
const maxGeneratedCoreLength =
  maxHeaderLength + coreComponentName.length - 'cloud-idaas-typescript'.length;

/** Returns the installed build version, including prerelease labels, or unknown for an unversioned build. */
export function getSDKVersion(): string {
  return SDK_VERSION;
}

function metadataToken(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value))
    throw new ConfigException('Invalid User-Agent metadata value', 'InvalidUserAgent');
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    throw new ConfigException('User-Agent metadata contains invalid Unicode', 'InvalidUserAgent');
  }
  encoded = encoded.replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  if (encoded.length > 128)
    throw new ConfigException('User-Agent metadata exceeds the header limit', 'InvalidUserAgent');
  return ` ${name}/${encoded}`;
}

/**
 * Builds the default Core SDK identification or validates a caller-supplied User-Agent.
 * @param userAgent - Optional replacement, containing 1-512 printable ASCII characters.
 * @param metadata - Optional diagnostic labels, used only with the default identifier.
 * @returns The replacement or the installed Core version, Node.js version, OS, and architecture.
 * @throws ConfigException - A supplied value is empty, too long, or contains invalid header characters.
 */
export function buildUserAgent(userAgent?: string, metadata?: UserAgentMetadata): string {
  return buildConfiguredUserAgent({ userAgent, userAgentMetadata: metadata });
}

function environmentToken(value: string | undefined): string {
  return value && /^[a-zA-Z0-9_.+-]+$/.test(value) ? value : 'unknown';
}

/** Builds a Core request header or the Core extension for a transport that supplies its own base. */
export function buildConfiguredUserAgent(
  config: HttpConfiguration = {},
  {
    includeRuntime = true,
    additionalComponents = [],
  }: { includeRuntime?: boolean; additionalComponents?: readonly string[] } = {},
): string {
  if (config.userAgent !== undefined) return validateUserAgent(config.userAgent);

  const metadata = config.userAgentMetadata;
  if (
    metadata !== undefined &&
    (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
  )
    throw new ConfigException('Invalid User-Agent metadata', 'InvalidUserAgent');

  const coreComponent = `${coreComponentName}/${SDK_VERSION}`;
  let value = coreComponent;
  if (includeRuntime) {
    const platform = environmentToken(process.platform);
    const arch = environmentToken(process.arch);
    const nodeVersion = environmentToken(process.versions.node);
    value += ` (${platform}; ${arch}) Node.js/${nodeVersion}`;
  }
  for (const [label, configured, legacy] of [
    ['app', config.userAgentApplicationName, metadata?.applicationId],
    ['app-version', config.userAgentApplicationVersion, metadata?.applicationVersion],
    ['deployment', config.userAgentDeploymentEnvironment, metadata?.deploymentEnvironment],
  ] as const) {
    const option = configured === undefined ? legacy : configured;
    if (option !== undefined) value += metadataToken(label, option);
  }

  const enabled = config.userAgentHostnameEnabled;
  if (enabled !== undefined && typeof enabled !== 'boolean')
    throw new ConfigException('Invalid User-Agent hostname switch', 'InvalidUserAgent');
  if (enabled ?? metadata?.hostname !== false) {
    if (config.userAgentHostname !== undefined) {
      value += metadataToken('hostname', config.userAgentHostname);
    } else if (metadata?.hostname === undefined || typeof metadata.hostname === 'boolean') {
      try {
        const discovered = metadataToken('hostname', hostname());
        if (value.length + discovered.length <= maxGeneratedCoreLength) value += discovered;
      } catch {
        // Optional local environment discovery must never prevent authentication.
      }
    } else {
      value += metadataToken('hostname', metadata.hostname);
    }
  }
  // Keep the existing limit for caller-controlled metadata and the Core fragment.
  value = validateUserAgent(value, maxGeneratedCoreLength);
  for (const component of new Set(additionalComponents)) {
    if (typeof component !== 'string' || !/^idaas-[a-z0-9-]+\/[0-9A-Za-z.+-]+$/.test(component))
      throw new ConfigException('Invalid User-Agent SDK component', 'InvalidUserAgent');
    if (component !== coreComponent) value += ` ${component}`;
  }
  return value;
}

function validateUserAgent(value: string, maxLength = maxHeaderLength): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength ||
    !/^[\x20-\x7e]+$/.test(value)
  )
    throw new ConfigException(
      `userAgent must contain 1-${maxLength} printable ASCII characters`,
      'InvalidUserAgent',
    );
  return value.trim();
}
