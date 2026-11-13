import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const MCP_ROUTE_URL = '/mcp';

export const MCP_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

// Discard rather than parse rejected uploads, but bound their bandwidth/time.
const REJECT_DRAIN_MAX_BYTES = 4 * MCP_BODY_LIMIT_BYTES;
const REJECT_DRAIN_TIMEOUT_MS = 1000;

export const MCP_UPLOAD_MAX_BASE64_CHARS = 14_000_000;

export const MCP_UPLOAD_MAX_BINARY_BYTES = Math.floor(
  (MCP_UPLOAD_MAX_BASE64_CHARS * 3) / 4,
);

export const MCP_MANUAL_UPLOAD_GUIDANCE =
  'Do not retry and do not split the file into chunks. Ask the user to upload the file manually in Akasha: open the target page and drag the file into the editor, or use the editor attachment button. The browser upload streams the file, so it handles sizes this tool cannot.';

export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)}KB`
    : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function payloadTooLargeMessage(
  limitBytes: number,
  actualBytes?: number,
): string {
  const actual =
    actualBytes === undefined ? '' : `${formatBytes(actualBytes)} payload: `;
  return `${actual}exceeds the ${formatBytes(limitBytes)} MCP request limit. ${MCP_MANUAL_UPLOAD_GUIDANCE}`;
}

export function payloadTooLargeDetails(limitBytes: number) {
  return {
    limitBytes,
    remediation: 'manual_upload_in_akasha' as const,
  };
}

export function uploadTooLargeMessage(actualChars?: number): string {
  const actual =
    actualChars === undefined ? '' : `${formatCount(actualChars)} characters: `;
  return `${actual}exceeds the upload limit of ${formatCount(MCP_UPLOAD_MAX_BASE64_CHARS)} base64 characters (about ${formatBytes(MCP_UPLOAD_MAX_BINARY_BYTES)} of binary). ${MCP_MANUAL_UPLOAD_GUIDANCE}`;
}

export function uploadTooLargeDetails() {
  return {
    maxBase64Chars: MCP_UPLOAD_MAX_BASE64_CHARS,
    maxBinaryBytes: MCP_UPLOAD_MAX_BINARY_BYTES,
    remediation: 'manual_upload_in_akasha' as const,
  };
}

export function registerMcpBodyLimit(instance: FastifyInstance): void {
  const reject = (
    request: FastifyRequest,
    reply: FastifyReply,
    maxDrainBytes: number,
  ): void => {
    const raw = request.raw;
    const keepAlive = reply.raw.shouldKeepAlive;
    const send = () => {
      // Fastify's parser also sets Connection: close on errors. Keeping the
      // connection open lets clients/proxies read the 413 while still writing.
      reply
        .code(413)
        .removeHeader('connection')
        .send({
          code: 'FILE_TOO_LARGE',
          message: payloadTooLargeMessage(MCP_BODY_LIMIT_BYTES),
          details: payloadTooLargeDetails(MCP_BODY_LIMIT_BYTES),
        });
    };

    if (raw.readableEnded) {
      send();
      return;
    }

    let drainedBytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      raw.removeListener('data', onData);
      raw.removeListener('end', onEnd);
      raw.removeListener('close', cleanup);
    };
    const stop = () => {
      cleanup();
      if (keepAlive) {
        raw.destroy();
      } else if (!reply.raw.destroyed) {
        send();
      }
    };
    const onData = (chunk: Buffer) => {
      drainedBytes += chunk.length;
      if (drainedBytes > maxDrainBytes) stop();
    };
    const onEnd = () => {
      cleanup();
      // For Connection: close requests, Node closes as soon as the response
      // finishes, so wait for the upload to end before sending that response.
      if (!keepAlive && !reply.raw.destroyed) send();
    };
    const timer = setTimeout(stop, REJECT_DRAIN_TIMEOUT_MS);
    timer.unref();

    raw.on('data', onData);
    raw.once('end', onEnd);
    raw.once('close', cleanup);
    raw.resume();
    if (keepAlive) send();
  };

  instance.addHook('onRequest', (request, reply, done) => {
    if (request.routeOptions?.url !== MCP_ROUTE_URL) return done();

    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > MCP_BODY_LIMIT_BYTES) {
      // No body has been parsed yet. Discard a near-limit request without
      // buffering it, while bounding the work spent on much larger uploads.
      reject(request, reply, REJECT_DRAIN_MAX_BYTES);
      return;
    }

    done();
  });

  instance.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url !== MCP_ROUTE_URL) return;

    routeOptions.bodyLimit = MCP_BODY_LIMIT_BYTES;
    routeOptions.errorHandler = (error, request, reply) => {
      if ((error as { code?: string }).code !== 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.send(error);
      }

      // The parser has already consumed the allowed body before this error.
      reject(request, reply, REJECT_DRAIN_MAX_BYTES - MCP_BODY_LIMIT_BYTES);
    };
  });
}
