import { parse } from 'dotenv';

export type RuntimeConfigurationOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

const requiredConsulVariables = [
  'CONSUL_HTTP_ADDR',
  'CONSUL_HTTP_TOKEN',
  'CONSUL_KV_KEY',
] as const;

export function shouldIgnoreEnvironmentFile(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV?.toLowerCase() === 'production' ||
    env.CONFIG_SOURCE?.toLowerCase() === 'consul'
  );
}

export async function loadRuntimeConfiguration(
  options: RuntimeConfigurationOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (env.CONFIG_SOURCE?.toLowerCase() !== 'consul') return;

  for (const variable of requiredConsulVariables) {
    if (!env[variable]) {
      throw new Error(
        `Consul configuration source requires ${variable} to be set`,
      );
    }
  }

  const address = env.CONSUL_HTTP_ADDR.replace(/\/+$/, '');
  const encodedKey = env.CONSUL_KV_KEY.split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = `${address}/v1/kv/${encodedKey}?raw`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'X-Consul-Token': env.CONSUL_HTTP_TOKEN },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load configuration from Consul: ${reason}`);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to load configuration from Consul: status ${response.status}`,
    );
  }

  const values = parse(await response.text());
  if (Object.keys(values).length === 0) {
    throw new Error('Consul value contains no configuration entries');
  }

  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
}
