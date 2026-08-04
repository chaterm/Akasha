import { Readable } from 'stream';

export function streamToBuffer(
  readableStream: Readable,
  abortSignal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const cleanup = () => {
      abortSignal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      const error =
        abortSignal?.reason instanceof Error
          ? abortSignal.reason
          : new Error('Storage read aborted.');
      readableStream.destroy(error);
    };
    if (abortSignal?.aborted) {
      onAbort();
    } else {
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    }
    readableStream.on('data', (chunk) => chunks.push(chunk));
    readableStream.on('end', () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    });
    readableStream.on('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}
