import * as yauzl from 'yauzl';
import * as path from 'path';
import * as fs from 'node:fs';
import { Logger } from '@nestjs/common';

const logger = new Logger('FileUtils');

export enum FileTaskType {
  Import = 'import',
  Export = 'export',
}

export enum FileImportSource {
  Generic = 'generic',
  Notion = 'notion',
  Confluence = 'confluence',
}

export enum FileTaskStatus {
  Processing = 'processing',
  Success = 'success',
  Failed = 'failed',
}

export function getFileTaskFolderPath(
  type: FileTaskType,
  workspaceId: string,
): string {
  switch (type) {
    case FileTaskType.Import:
      return `${workspaceId}/imports`;
    case FileTaskType.Export:
      return `${workspaceId}/exports`;
  }
}

export async function extractZip(
  source: string,
  target: string,
): Promise<void> {
  return extractZipInternal(source, target, true);
}

function extractZipInternal(
  source: string,
  target: string,
  allowNested: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      source,
      { lazyEntries: true, decodeStrings: false, autoClose: true },
      (err, zipfile) => {
        if (err) return reject(err);

        if (allowNested && zipfile.entryCount === 1) {
          zipfile.readEntry();
          zipfile.once('entry', (entry) => {
            const name = entry.fileName.toString('utf8').replace(/^\/+/, '');
            const isZip =
              !/\/$/.test(entry.fileName) &&
              name.toLowerCase().endsWith('.zip');
            if (isZip) {
              const nestedPath = source.endsWith('.zip')
                ? source.slice(0, -4) + '.inner.zip'
                : source + '.inner.zip';

              zipfile.openReadStream(entry, (openErr, rs) => {
                if (openErr) return reject(openErr);
                const ws = fs.createWriteStream(nestedPath);
                rs.on('error', reject);
                ws.on('error', reject);
                ws.on('finish', () => {
                  zipfile.close();
                  extractZipInternal(nestedPath, target, false)
                    .then(() => {
                      fs.unlinkSync(nestedPath);
                      resolve();
                    })
                    .catch(reject);
                });
                rs.pipe(ws);
              });
            } else {
              zipfile.close();
              extractZipInternal(source, target, false).then(resolve, reject);
            }
          });
          zipfile.once('error', reject);
          return;
        }

        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          const name = entry.fileName.toString('utf8');
          const safe = name.replace(/^\/+/, '');

          const validationError = yauzl.validateFileName(safe);
          if (validationError) {
            logger.warn(
              { entry: safe, reason: 'invalid-file-name', validationError },
              'Skipping zip entry',
            );
            zipfile.readEntry();
            return;
          }

          if (safe.startsWith('__MACOSX/')) {
            zipfile.readEntry();
            return;
          }

          const fullPath = path.join(target, safe);

          const resolved = path.resolve(fullPath);
          const targetResolved = path.resolve(target);

          if (!resolved.startsWith(targetResolved + path.sep)) {
            logger.warn(
              { entry: safe, reason: 'path-outside-target' },
              'Skipping zip entry',
            );
            zipfile.readEntry();
            return;
          }

          if (/\/$/.test(name)) {
            try {
              fs.mkdirSync(fullPath, { recursive: true });
            } catch (mkdirErr: any) {
              if (mkdirErr.code === 'ENAMETOOLONG') {
                logger.warn(
                  {
                    entry: safe,
                    fullPath,
                    reason: 'path-too-long',
                    op: 'mkdir-directory',
                  },
                  'Skipping zip entry',
                );
                zipfile.readEntry();
                return;
              }
              return reject(mkdirErr);
            }
            zipfile.readEntry();
            return;
          }

          try {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          } catch (mkdirErr: any) {
            if (mkdirErr.code === 'ENAMETOOLONG') {
              logger.warn(
                {
                  entry: safe,
                  fullPath,
                  reason: 'path-too-long',
                  op: 'mkdir-parent',
                },
                'Skipping zip entry',
              );
              zipfile.readEntry();
              return;
            }
            return reject(mkdirErr);
          }

          zipfile.openReadStream(entry, (openErr, rs) => {
            if (openErr) return reject(openErr);

            let ws: fs.WriteStream;
            try {
              ws = fs.createWriteStream(fullPath);
            } catch (openWsErr: any) {
              if (openWsErr.code === 'ENAMETOOLONG') {
                logger.warn(
                  {
                    entry: safe,
                    fullPath,
                    reason: 'path-too-long',
                    op: 'create-write-stream',
                  },
                  'Skipping zip entry',
                );
                zipfile.readEntry();
                return;
              }
              return reject(openWsErr);
            }

            rs.on('error', (err) => reject(err));
            ws.on('error', (err) => {
              if ((err as any).code === 'ENAMETOOLONG') {
                logger.warn(
                  {
                    entry: safe,
                    fullPath,
                    reason: 'path-too-long',
                    op: 'write-stream',
                  },
                  'Skipping zip entry',
                );
                zipfile.readEntry();
              } else {
                reject(err);
              }
            });
            ws.on('finish', () => zipfile.readEntry());
            rs.pipe(ws);
          });
        });

        zipfile.on('end', () => resolve());
        zipfile.on('error', (err) => reject(err));
      },
    );
  });
}

export function cleanUrlString(url: string): string {
  if (!url) return null;
  const [mainUrl] = url.split('?', 1);
  return mainUrl;
}
