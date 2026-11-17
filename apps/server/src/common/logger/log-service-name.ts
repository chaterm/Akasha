export const SERVICE_NAME_SERVER = 'akasha-server';
export const SERVICE_NAME_COLLAB = 'akasha-collab';

export function resolveServiceName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.SERVICE_NAME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : SERVICE_NAME_SERVER;
}
