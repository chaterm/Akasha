import Fastify from 'fastify';
import * as http from 'node:http';
import {
  MCP_BODY_LIMIT_BYTES,
  MCP_MANUAL_UPLOAD_GUIDANCE,
  MCP_ROUTE_URL,
  MCP_UPLOAD_MAX_BINARY_BYTES,
  formatBytes,
  payloadTooLargeMessage,
  registerMcpBodyLimit,
  uploadTooLargeMessage,
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

  it('is 32MB', () => {
    expect(MCP_BODY_LIMIT_BYTES).toBe(32 * 1024 * 1024);
  });

  it('accepts a JSON-RPC body larger than the global limit', async () => {
    const response = await inject(MCP_ROUTE_URL, 8 * 1024 * 1024);

    expect(response.statusCode).toBe(200);
  });

  it('accepts a body just under the MCP limit', async () => {
    const response = await inject(MCP_ROUTE_URL, MCP_BODY_LIMIT_BYTES - 1024);

    expect(response.statusCode).toBe(200);
  });

  it('rejects an oversized body with manual-upload guidance', async () => {
    const response = await inject(MCP_ROUTE_URL, MCP_BODY_LIMIT_BYTES + 1024);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: 'FILE_TOO_LARGE',
      details: { remediation: 'manual_upload_in_akasha' },
    });
    expect(response.json().message).toContain('32.0MB');
    expect(response.json().message).toContain('upload the file manually');
  });

  it('leaves other routes on the global limit', async () => {
    const response = await inject(
      '/api/pages/update',
      GLOBAL_BODY_LIMIT + 1024,
    );

    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
    expect(response.payload).not.toContain('manual_upload_in_akasha');
  });
});

describe('payloadTooLargeMessage', () => {
  it('tells the agent not to retry or chunk, and to route the user to Akasha', () => {
    expect(MCP_MANUAL_UPLOAD_GUIDANCE).toContain('Do not retry');
    expect(MCP_MANUAL_UPLOAD_GUIDANCE).toContain('do not split the file');
    expect(MCP_MANUAL_UPLOAD_GUIDANCE).toContain('upload the file manually');
    expect(MCP_MANUAL_UPLOAD_GUIDANCE).toContain('drag the file into the editor');
  });

  it('names the limit and includes the guidance', () => {
    const message = payloadTooLargeMessage(MCP_BODY_LIMIT_BYTES);

    expect(message).toContain('32.0MB');
    expect(message).toContain(MCP_MANUAL_UPLOAD_GUIDANCE);
  });

  it('reports the actual size when known', () => {
    const message = payloadTooLargeMessage(MCP_BODY_LIMIT_BYTES, 40_000_000);

    expect(message).toContain('38.1MB payload');
    expect(message).toContain(formatBytes(MCP_BODY_LIMIT_BYTES));
  });

  it('formats sub-megabyte sizes in KB', () => {
    expect(formatBytes(512 * 1024)).toBe('512.0KB');
  });
});

describe('uploadTooLargeMessage', () => {
  it('reports the binary ceiling, not the base64 character count', () => {
    const message = uploadTooLargeMessage();

    expect(MCP_UPLOAD_MAX_BINARY_BYTES).toBe(10_500_000);
    expect(message).toContain('14,000,000 base64 characters');
    expect(message).toContain('10.0MB of binary');
    expect(message).not.toContain('13.4MB');
  });

  it('reports how many characters the caller actually sent', () => {
    expect(uploadTooLargeMessage(15_000_000)).toContain(
      '15,000,000 characters:',
    );
  });

  it('includes the manual-upload guidance', () => {
    expect(uploadTooLargeMessage()).toContain(MCP_MANUAL_UPLOAD_GUIDANCE);
  });
});

describe('MCP body limit over a real socket', () => {
  let app: ReturnType<typeof buildApp>;
  let port: number;

  beforeAll(async () => {
    app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a readable 413 while the client is still sending', async () => {
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const declared = MCP_BODY_LIMIT_BYTES + 1024 * 1024;
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: MCP_ROUTE_URL,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(declared),
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );

        req.on('error', reject);
        req.write('x'.repeat(64 * 1024));

        setTimeout(() => {
          req.destroy();
          reject(new Error('no response within 5s'));
        }, 5000).unref();
      },
    );

    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toMatchObject({
      code: 'FILE_TOO_LARGE',
      details: { remediation: 'manual_upload_in_akasha' },
    });
  });
});
