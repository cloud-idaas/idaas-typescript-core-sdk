import { loadConfig, normalizeScope, validateConfig } from './config';
import { ConfigException } from './errors';
import {
  type CredentialProviderOptions,
  IDaaSMachineCredentialProvider,
} from './credential-provider';
import { type IDaaSClientConfig, type PluginCredentialProvider } from './types';
import { registerPluginNames } from './plugin-registry';

/**
 * Manages machine credential providers and scope-isolated caches for beta authentication on Node.js 20/22/24.
 *
 * @remarks Independent instances are supported; static methods operate on the default factory in this Core package instance.
 * Physical copies, processes, and workers do not implicitly share factories. Factories own providers they create;
 * caller-injected HTTP, authentication sources, and plugins remain caller-managed.
 */
export class IDaaSCredentialProviderFactory {
  private static readonly defaultFactory = new IDaaSCredentialProviderFactory();
  private config?: IDaaSClientConfig;
  private initialization?: Promise<void>;
  private readonly providers = new Map<string, Promise<IDaaSMachineCredentialProvider>>();
  private readonly plugins = new Map<string, PluginCredentialProvider>();
  private closed = false;
  /**
   * Creates an uninitialized factory without reading configuration files or requesting tokens.
   * @param options - Injected HTTP, authentication sources, plugins, and cache options.
   * @throws ConfigException - An injected plugin name is empty or duplicated, or registration violates the lifecycle.
   */
  constructor(private readonly options: CredentialProviderOptions = {}) {
    this.options = { ...options };
    for (const plugin of options.plugins || []) this.registerPlugin(plugin);
  }
  /**
   * Explicitly registers an authentication plugin before initialization.
   * @param plugin - An instance implementing the public plugin contract; its lifecycle remains caller-owned.
   * @throws ConfigException - The factory is initializing, initialized, or closed, or a plugin name is empty or duplicated.
   */
  registerPlugin(plugin: PluginCredentialProvider): void {
    if (this.config || this.initialization || this.closed)
      throw new ConfigException(
        'Plugins can only be registered before initialization',
        'InvalidLifecycle',
      );
    registerPluginNames(this.plugins, plugin);
  }
  /**
   * Reads and validates configuration, completing initialization only after the default scope warms up successfully.
   * @param configOrPath - Configuration object or explicit file path; omission uses the environment path and default configuration path.
   * @returns A Promise of completed initialization; concurrent calls coalesce and subsequent successful calls retain the first configuration.
   * @throws ConfigException - The configuration is invalid or the factory is closed.
   * @throws IDaaSException - Initial credential retrieval fails; this method can be retried after failure.
   */
  init(configOrPath?: IDaaSClientConfig | string): Promise<void> {
    if (this.closed) return Promise.reject(new ConfigException('Factory is closed', 'Closed'));
    if (this.config) {
      this.logInitialization(true);
      return Promise.resolve();
    }
    if (this.initialization) return this.initialization;
    this.initialization = Promise.resolve()
      .then(async () => {
        const config =
          typeof configOrPath === 'object'
            ? validateConfig(configOrPath)
            : await loadConfig(configOrPath);
        const provider = this.create(config);
        try {
          await provider.getCredential();
          if (this.closed) throw new ConfigException('Factory is closed', 'Closed');
          this.config = config;
          this.providers.set(config.scope, Promise.resolve(provider));
          this.logInitialization(false);
        } catch (error) {
          provider.close();
          throw error;
        }
      })
      .finally(() => {
        this.initialization = undefined;
      });
    return this.initialization;
  }
  /**
   * Returns an independent JSON copy of the initialized configuration.
   * @returns A caller-mutable configuration snapshot that does not affect internal factory state.
   * @throws ConfigException - The factory is uninitialized or closed.
   */
  getConfig(): IDaaSClientConfig {
    if (!this.config || this.closed)
      throw new ConfigException(
        'Factory is uninitialized or closed; await init() first',
        'IDaaSCredentialProviderFactoryNotInit',
      );
    return JSON.parse(JSON.stringify(this.config)) as IDaaSClientConfig;
  }
  /**
   * Gets or creates a provider for the scope; initial creation requires successful warmup.
   * @param scope - Space-separated resourceServerIdentifier|scope values; omission uses the configured default.
   * @returns A provider shared by the same normalized scope; callers typically close providers through the factory.
   * @throws ConfigException - The factory is not ready or closed, or the scope is invalid.
   * @throws IDaaSException - Initial retrieval for this scope fails; subsequent calls may retry creation.
   */
  async getIDaaSCredentialProvider(scope?: string): Promise<IDaaSMachineCredentialProvider> {
    const config = this.getConfig();
    const key = normalizeScope(scope === undefined ? config.scope : scope);
    let pending = this.providers.get(key);
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        const provider = this.create({ ...config, scope: key });
        try {
          await provider.getCredential();
          if (this.closed) throw new ConfigException('Factory is closed', 'Closed');
          return provider;
        } catch (error) {
          provider.close();
          this.providers.delete(key);
          throw error;
        }
      });
      this.providers.set(key, pending);
    }
    return pending;
  }
  private create(config: IDaaSClientConfig): IDaaSMachineCredentialProvider {
    return new IDaaSMachineCredentialProvider(config, {
      ...this.options,
      plugins: [...new Set(this.plugins.values())],
    });
  }
  private logInitialization(repeated: boolean): void {
    const fields = { status: repeated ? 'already_initialized' : 'success' };
    try {
      const logger = this.options.cache?.logger;
      if (logger) logger.info('factory_initialize', fields);
      else console.info('factory_initialize', fields);
    } catch {
      /* Log observers must not disrupt initialization. */
    }
  }
  /**
   * Stops the factory and closes its providers, awaiting in-progress initialization and creation.
   * @returns A Promise of completed cleanup; idempotent, and a closed factory cannot be reinitialized.
   * @remarks Leaves caller-injected shared HTTP, authentication sources, and plugins open.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.initialization?.catch(() => undefined);
    const providers = await Promise.allSettled(this.providers.values());
    for (const result of providers) if (result.status === 'fulfilled') result.value.close();
    this.providers.clear();
    this.config = undefined;
  }
  /**
   * Initializes the default factory for this package instance, requiring successful initial beta warmup.
   * @param configOrPath - Configuration object or file path; omission uses the instance method's path precedence.
   * @returns A Promise of completed default factory initialization.
   * @throws IDaaSException - Configuration, lifecycle, or warmup fails, with the same semantics as instance init.
   */
  static init(configOrPath?: IDaaSClientConfig | string): Promise<void> {
    return this.defaultFactory.init(configOrPath);
  }
  /**
   * Returns an independent copy of the default factory configuration.
   * @returns An initialized configuration snapshot.
   * @throws ConfigException - The default factory is uninitialized or closed.
   */
  static getConfig(): IDaaSClientConfig {
    return this.defaultFactory.getConfig();
  }
  /**
   * Gets a shared scope-isolated provider from the default factory.
   * @param scope - Optional target scope; omission uses the configured default.
   * @returns A successfully warmed-up provider whose lifecycle is managed by the default factory.
   * @throws IDaaSException - The default factory is not ready, the scope is invalid, or initial credential retrieval fails.
   */
  static getIDaaSCredentialProvider(scope?: string): Promise<IDaaSMachineCredentialProvider> {
    return this.defaultFactory.getIDaaSCredentialProvider(scope);
  }
  /**
   * Registers a caller-owned plugin instance before default factory initialization.
   * @param plugin - An authentication plugin with a unique name.
   * @throws ConfigException - Names conflict or registration violates the lifecycle.
   */
  static registerPlugin(plugin: PluginCredentialProvider): void {
    this.defaultFactory.registerPlugin(plugin);
  }
  /**
   * Closes the default factory and its providers; injected shared resources remain caller-owned.
   * @returns A Promise of completed cleanup; the static default factory cannot be reinitialized after closure.
   */
  static close(): Promise<void> {
    return this.defaultFactory.close();
  }
}
