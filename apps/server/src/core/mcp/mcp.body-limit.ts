import { FastifyInstance } from 'fastify';

export const MCP_ROUTE_URL = '/mcp';

export const MCP_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export function registerMcpBodyLimit(instance: FastifyInstance): void {
  instance.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === MCP_ROUTE_URL) {
      routeOptions.bodyLimit = MCP_BODY_LIMIT_BYTES;
    }
  });
}
