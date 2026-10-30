import {
  CacheException,
  ConfigException,
  IDaaSUnexpectedException,
  isIDaaSException,
} from './errors';
import { type Logger } from './types';

/** Value and server expiration metadata returned by one refresh; the cache never extends actual expiration. */
export interface RefreshResult<T> {
  /** Domain value; this generic cache does not deep-copy it. Treat it as immutable; credential providers return separate snapshots. */
  value: T;
  /** Internal cache timestamps use Unix milliseconds. */
  expiresAt: number;
  /** Optional original lifetime in milliseconds; must be finite and positive and never extends expiresAt. */
  ttlMs?: number;
}
/** Access-triggered prefetch configuration; injected observers and clocks remain caller-owned. */
export interface CacheOptions {
  /** Defaults to LENIENT, allowing cached values after refresh failures only before actual expiration; STRICT propagates awaited refresh failures. */
  failureMode?: 'STRICT' | 'LENIENT';
  /** Clock returning Unix milliseconds, defaulting to Date.now; supports boundary checks without real waiting. */
  clock?: () => number;
  /** Jitter source returning a finite number between 0 and 1, defaulting to Math.random. */
  random?: () => number;
  /** Optional structured log observer; synchronous exceptions are isolated and the SDK does not close it. */
  logger?: Logger;
}
const logger: Logger = {
  info: (event, fields) => console.info(event, fields),
  warn: (event, fields) => console.warn(event, fields),
  error: (event, fields) => console.error(event, fields),
};

/**
 * Prefetches on access and coalesces concurrent refreshes per instance; the initial beta read must succeed.
 * @remarks Creates no background timers and never returns cached values at or beyond actual expiresAt.
 * Closure stops only this cache; it neither cancels nor closes the caller-supplied refresh source.
 */
export class CachedResultSupplier<T> {
  private cached?: RefreshResult<T>;
  private pending?: Promise<T>;
  private prefetchAt = 0;
  private staleAt = 0;
  private retryAt = 0;
  private closed = false;
  private readonly now: () => number;
  /**
   * Creates an empty cache without immediately invoking refresh.
   * @param refresh - Asynchronous refresh function returning a domain value, Unix-millisecond expiration, and optional TTL in milliseconds.
   * @param options - Mode, clock, jitter, and logger injection; configuration is stored independently.
   * @throws ConfigException - The mode is unsupported or an injected clock or random source is not a function.
   */
  constructor(
    private readonly refresh: () => Promise<RefreshResult<T>>,
    private readonly options: CacheOptions = {},
  ) {
    if (
      options.failureMode !== undefined &&
      options.failureMode !== 'STRICT' &&
      options.failureMode !== 'LENIENT'
    )
      throw new ConfigException('Unsupported failureMode', 'InvalidConfiguration');
    for (const field of ['clock', 'random'] as const) {
      if (options[field] !== undefined && typeof options[field] !== 'function')
        throw new ConfigException(`${field} must be a function`, 'InvalidConfiguration');
    }
    this.options = { ...options };
    const clock = options.clock || Date.now;
    this.now = () => {
      const value = clock();
      if (!Number.isFinite(value))
        throw new CacheException('Cache clock is invalid', 'InvalidClock');
      return value;
    };
  }
  /** Rechecks closure and hard expiration before returning, covering races between refresh and log callbacks. */
  private currentValue(): T {
    if (this.closed) throw new CacheException('Credential provider is closed', 'Closed');
    if (!this.cached || this.now() >= this.cached.expiresAt)
      throw new CacheException(
        'Credentials have reached their actual expiration time',
        'InvalidExpiration',
      );
    return this.cached.value;
  }
  /**
   * Retrieves a valid value, prefetching or awaiting a coalesced refresh when necessary.
   * @returns A domain value before actual expiration; generic T is not deep-copied.
   * @throws CacheException - The cache is closed, refresh results or clock are invalid, or credentials have expired before return.
   * @throws IDaaSException - Refresh fails without usable cached values, or an awaited refresh fails in STRICT mode.
   * @remarks LENIENT never extends actual expiration; background prefetch failures are logged and handled without discarding valid cached values.
   */
  async get(): Promise<T> {
    if (this.closed) throw new CacheException('Credential provider is closed', 'Closed');
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt) {
      if (now < this.prefetchAt) return this.currentValue();
      if (now < this.staleAt) {
        if (now >= this.retryAt) void this.reload().catch(() => undefined);
        return this.currentValue();
      }
      if (this.options.failureMode !== 'STRICT' && now < this.retryAt) return this.currentValue();
    }
    try {
      await this.reload();
      return this.currentValue();
    } catch (error) {
      // Use the actual return time, rather than a timestamp captured before refresh started.
      if (
        !this.closed &&
        this.options.failureMode !== 'STRICT' &&
        this.cached &&
        this.now() < this.cached.expiresAt
      ) {
        this.log('warn', 'credential_degradation', { status: 'using_cache' });
        return this.currentValue();
      }
      throw error;
    }
  }
  private reload(): Promise<T> {
    if (this.pending) return this.pending;
    const started = this.now();
    this.pending = Promise.resolve()
      .then(this.refresh)
      .then((result) => {
        const now = this.now();
        if (this.closed) throw new CacheException('Credential provider is closed', 'Closed');
        if (!Number.isFinite(result.expiresAt) || result.expiresAt <= now)
          throw new CacheException(
            'Refresh result has expired or lacks a valid expiration time',
            'InvalidExpiration',
          );
        const ttl = Math.min(
          result.ttlMs ?? result.expiresAt - started,
          result.expiresAt - started,
        );
        if (!Number.isFinite(ttl) || !(ttl > 0))
          throw new CacheException('Credential lifetime is invalid', 'InvalidExpiration');
        const random = (this.options.random || Math.random)();
        if (!Number.isFinite(random) || random < 0 || random > 1)
          throw new CacheException('Cache random value must be between 0 and 1', 'InvalidRandom');
        const jitter = (random * ttl) / 40;
        this.prefetchAt = result.expiresAt - ttl / 3 - jitter;
        this.staleAt = result.expiresAt - ttl / 5 - jitter;
        // Store expiration metadata independently; the source-owned envelope must not extend cache validity.
        this.cached = { ...result };
        this.retryAt = 0;
        this.log('info', 'credential_refresh', { status: 'success', latencyMs: now - started });
        return result.value;
      })
      .catch((error: unknown) => {
        this.retryAt = this.now() + 1000;
        this.log('warn', 'credential_refresh', {
          status: 'failure',
          errorCode: isIDaaSException(error) ? error.errorCode : 'UnexpectedError',
        });
        throw isIDaaSException(error)
          ? error
          : new IDaaSUnexpectedException(
              'Credential refresh failed; check the custom credential or HTTP source',
              'CredentialRefreshFailed',
            );
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private log(level: keyof Logger, event: string, fields: Record<string, unknown>): void {
    try {
      (this.options.logger || logger)[level](event, fields);
    } catch {
      /* Logging must not disrupt credential retrieval. */
    }
  }
  /**
   * Idempotently closes and clears the cache; subsequent reads fail with Closed.
   * @remarks In-flight refreshes cannot repopulate the cache; does not close, cancel, or await the caller-supplied refresh source.
   */
  close(): void {
    this.closed = true;
    this.cached = undefined;
  }
}
