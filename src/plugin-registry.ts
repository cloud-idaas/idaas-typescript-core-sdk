import { required } from './config';
import { ConfigException, isIDaaSException } from './errors';
import { type PluginCredentialProvider } from './types';

/** Registers canonical names and compatibility aliases atomically, avoiding partial registration on conflicts. */
export function registerPluginNames(
  registry: Map<string, PluginCredentialProvider>,
  plugin: PluginCredentialProvider,
): void {
  let names: string[];
  try {
    const name = plugin.getName();
    required(name, 'pluginName');
    if (plugin.getAliases !== undefined && typeof plugin.getAliases !== 'function')
      throw new ConfigException('Plugin alias source must be a function', 'InvalidPlugin');
    const aliases = plugin.getAliases ? plugin.getAliases() : [];
    if (!Array.isArray(aliases))
      throw new ConfigException('Plugin aliases must be an array of strings', 'InvalidPlugin');
    for (const alias of aliases) required(alias, 'pluginName');
    names = [...new Set([name, ...aliases])];
  } catch (error) {
    if (isIDaaSException(error)) throw error;
    throw new ConfigException(
      'Unable to read the plugin name and compatibility aliases',
      'InvalidPlugin',
    );
  }
  for (const name of names)
    if (registry.has(name))
      throw new ConfigException('Duplicate plugin name or alias', 'DuplicatePlugin');
  for (const name of names) registry.set(name, plugin);
}
