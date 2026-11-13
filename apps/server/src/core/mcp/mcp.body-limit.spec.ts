import Fastify from 'fastify';
import * as http from 'node:http';
import * as net from 'node:net';
import { Readable } from 'node:stream';
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
    expect(MCP_MANUAL_UPLOAD_GUIDANCE).toContain(
      'drag the file into the editor',
    );
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
  let proxy: http.Server;
  let proxyPort: number;
  const upstreamRequests = new Set<http.ClientRequest>();

  beforeAll(async () => {
    app = buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    proxy = http.createServer((request, response) => {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port,
          method: request.method,
          path: request.url,
          // Vite/http-proxy uses Connection: close for its upstream request.
          headers: { ...request.headers, connection: 'close' },
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
          upstreamResponse.on('error', () => response.destroy());
          upstreamResponse.pipe(response);
        },
      );
      upstreamRequests.add(upstream);
      upstream.on('close', () => upstreamRequests.delete(upstream));
      request.on('error', () => upstream.destroy());
      response.on('error', () => upstream.destroy());
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    proxyPort =
      typeof proxyAddress === 'object' && proxyAddress ? proxyAddress.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => (error ? reject(error) : resolve()));
      proxy.closeAllConnections();
      for (const upstream of upstreamRequests) upstream.destroy();
    });
    await app.close();
  });

  const post = async (
    targetPort: number,
    payload: string,
    { chunked = false, close = false } = {},
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${targetPort}${MCP_ROUTE_URL}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(close ? { connection: 'close' } : {}),
        },
        body: chunked
          ? Readable.from([
              payload.slice(0, 64 * 1024),
              payload.slice(64 * 1024),
            ])
          : payload,
        ...(chunked ? { duplex: 'half' } : {}),
        signal: AbortSignal.timeout(3000),
      } as RequestInit,
    );
    return { status: response.status, body: await response.text() };
  };

  it.each(['direct', 'proxy'])(
    'returns a readable 413 for complete oversized uploads (%s)',
    async (target) => {
      const payload = payloadOfBytes(MCP_BODY_LIMIT_BYTES + 1);
      for (let attempt = 0; attempt < 10; attempt++) {
        const result = await post(
          target === 'direct' ? port : proxyPort,
          payload,
        );
        expect(result.status).toBe(413);
        expect(JSON.parse(result.body)).toMatchObject({
          code: 'FILE_TOO_LARGE',
          details: { remediation: 'manual_upload_in_akasha' },
        });
      }
    },
  );

  it.each(['direct', 'proxy'])(
    'returns a readable 413 for chunked uploads (%s)',
    async (target) => {
      const result = await post(
        target === 'direct' ? port : proxyPort,
        payloadOfBytes(MCP_BODY_LIMIT_BYTES + 1024),
        { chunked: true },
      );
      expect(result.status).toBe(413);
      expect(JSON.parse(result.body).code).toBe('FILE_TOO_LARGE');
    },
  );

  it('returns a readable rejection through a proxy for a much larger upload', async () => {
    const result = await post(proxyPort, payloadOfBytes(64 * 1024 * 1024));
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).code).toBe('FILE_TOO_LARGE');
  });

  it('finishes reading uploads from clients that request Connection: close', async () => {
    const result = await post(port, payloadOfBytes(MCP_BODY_LIMIT_BYTES + 1), {
      close: true,
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).code).toBe('FILE_TOO_LARGE');
  });

  it('allows an upload to finish after the 413, then accepts the next request', async () => {
    const payload = payloadOfBytes(MCP_BODY_LIMIT_BYTES + 1);
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let responses = '';
      let continued = false;
      let completed = false;
      const timer = setTimeout(
        () => finish(new Error('upload did not finish')),
        3000,
      );
      let continueTimer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        clearTimeout(continueTimer);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      socket.setEncoding('utf8');
      socket.on('error', finish);
      socket.on('close', () => {
        if (!completed)
          finish(new Error('connection closed during the upload'));
      });
      socket.on('connect', () => {
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n`,
        );
        socket.write(payload.slice(0, 64 * 1024));
      });
      socket.on('data', (chunk) => {
        responses += chunk;
        if (!continued && responses.includes('manual_upload_in_akasha')) {
          continued = true;
          // Keep sending after the rejection, as a buffering proxy may do.
          continueTimer = setTimeout(() => {
            socket.write(payload.slice(64 * 1024));
            socket.write(
              'POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
            );
          }, 25);
        }
        if (
          responses.includes('HTTP/1.1 200') &&
          responses.includes('"ok":true')
        ) {
          finish();
        }
      });
    });
  });

  it('closes a rejected upload that stalls without finishing its body', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let response = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('stalled upload was not closed'));
      }, 2500);
      socket.setEncoding('utf8');
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${MCP_BODY_LIMIT_BYTES + 1}\r\n\r\nx`,
        );
      });
      socket.on('data', (chunk) => (response += chunk));
      socket.on('close', () => {
        clearTimeout(timer);
        try {
          expect(response).toContain('HTTP/1.1 413');
          expect(response).toContain('manual_upload_in_akasha');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });
});
