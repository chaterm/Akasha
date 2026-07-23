import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';
import { buildConfluenceImportMetadata } from '../import.controller';
import { ImportService } from './import.service';

jest.mock('../utils/import-formatter', () => ({
  normalizeImportHtml: jest.fn(),
}));

describe('ImportService Confluence task metadata', () => {
  it('persists optional Confluence space context on the file task', async () => {
    let inserted: Record<string, unknown> | undefined;
    const storageService = {
      upload: jest.fn(async (_path: string, stream: Readable) => {
        for await (const _chunk of stream) {
          // Drain the byte-counting stream so fileSize is finalized.
        }
      }),
    };
    const query = {
      values(value: Record<string, unknown>) {
        inserted = value;
        return this;
      },
      returningAll() {
        return this;
      },
      async executeTakeFirst() {
        return inserted;
      },
    };
    const db = {
      insertInto: jest.fn(() => query),
    };
    const fileTaskQueue = { add: jest.fn(async () => undefined) };
    const service = new ImportService(
      undefined as never,
      storageService as never,
      db as never,
      fileTaskQueue as never,
      undefined as never,
    );

    const metadata = {
      confluence: { spaceId: '6389822', spaceKey: 'open' },
    };
    await service.importZip(
      Promise.resolve({
        filename: 'Confluence-space-export.html.zip',
        file: Readable.from(Buffer.from('zip')),
      } as never),
      'confluence',
      'user-1',
      'space-1',
      'workspace-1',
      metadata,
    );

    expect(inserted).toMatchObject({
      source: 'confluence',
      metadata,
    });
  });

  it('keeps metadata null for existing generic imports', async () => {
    let inserted: Record<string, unknown> | undefined;
    const query = {
      values(value: Record<string, unknown>) {
        inserted = value;
        return this;
      },
      returningAll() {
        return this;
      },
      async executeTakeFirst() {
        return inserted;
      },
    };
    const service = new ImportService(
      undefined as never,
      { upload: async (_path: string, stream: Readable) => {
        for await (const _chunk of stream) {
          // Drain stream.
        }
      } } as never,
      { insertInto: () => query } as never,
      { add: async () => undefined } as never,
      undefined as never,
    );

    await service.importZip(
      Promise.resolve({
        filename: 'generic.zip',
        file: Readable.from(Buffer.from('zip')),
      } as never),
      'generic',
      'user-1',
      'space-1',
      'workspace-1',
    );

    expect(inserted).toMatchObject({ source: 'generic', metadata: null });
  });

  it('validates optional Confluence multipart context as an all-or-nothing pair', () => {
    expect(
      buildConfluenceImportMetadata('confluence', '6389822', '~user@xxxxx.net'),
    ).toEqual({
      confluence: { spaceId: '6389822', spaceKey: '~user@xxxxxx.net' },
    });
    expect(buildConfluenceImportMetadata('confluence', undefined, undefined))
      .toBeUndefined();
    expect(buildConfluenceImportMetadata('generic', '6389822', 'open'))
      .toBeUndefined();
    expect(() =>
      buildConfluenceImportMetadata('confluence', '6389822', undefined),
    ).toThrow(BadRequestException);
    expect(() =>
      buildConfluenceImportMetadata('confluence', 'not-a-number', 'open'),
    ).toThrow(/Confluence space ID/i);
    expect(() =>
      buildConfluenceImportMetadata('confluence', '6389822', 'x'.repeat(256)),
    ).toThrow(/Confluence space Key/i);
  });
});
