import Fastify from 'fastify';
import {
  MCP_BODY_LIMIT_BYTES,
  MCP_ROUTE_URL,
  registerMcpBodyLimit,
} from './mcp.body-limit';

const GLOBAL_BODY_LIMIT = 1024 * 1024;

function buildApp() {
  const app = Fastify({ bodyLimit: GLOBAL_BODY_LIMIT });

  registerMcpBodyLimit(app as any);

  app.addContentTypeParser(
    'application/json',
    { bodyLimit: GLOBAL_BODY_LIMIT, parseAs: 'buffer' },
    (req, body, done) => {
      (req as any).rawBody = body;
      app.getDefaultJsonParser('error', 'error')(req, body as any, done);
    },
  );

  app.all(MCP_ROUTE_URL, async () => ({ ok: true }));
  app.post('/api/pages/update', async () => ({ ok: true }));

  return app;
}

function payloadOfBytes(bytes: number) {
  const envelope = JSON.stringify({ jsonrpc: '2.0', blob: '' });
  return JSON.stringify({
    jsonrpc: '2.0',
    blob: 'x'.repeat(bytes - envelope.length),
  });
}

describe('MCP route body limit', () => {
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const inject = (url: string, bytes: number) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: payloadOfBytes(bytes),
    });

  it('is 16MB', () => {
    expect(MCP_BODY_LIMIT_BYTES).toBe(16 * 1024 * 1024);
  });

  it('accepts a JSON-RPC body larger than the global limit', async () => {
    const response = await inject(MCP_ROUTE_URL, 8 * 1024 * 1024);

    expect(response.statusCode).toBe(200);
  });

  it('accepts a body just under the MCP limit', async () => {
    const response = await inject(MCP_ROUTE_URL, MCP_BODY_LIMIT_BYTES - 1024);

    expect(response.statusCode).toBe(200);
  });

  it('rejects a body over the MCP limit', async () => {
    const response = await inject(MCP_ROUTE_URL, MCP_BODY_LIMIT_BYTES + 1024);

    expect(response.statusCode).toBe(413);
  });

  it('leaves other routes on the global limit', async () => {
    const response = await inject(
      '/api/pages/update',
      GLOBAL_BODY_LIMIT + 1024,
    );

    expect(response.statusCode).toBe(413);
  });
});
