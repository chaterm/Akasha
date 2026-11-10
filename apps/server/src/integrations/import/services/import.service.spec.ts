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

describe('ImportService extractTitleAndRemoveHeading', () => {
  const service = new ImportService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  const heading = (level: number, ...content: any[]) => ({
    type: 'heading',
    attrs: { level },
    content,
  });
  const text = (value: string, marks?: any[]) => ({
    type: 'text',
    text: value,
    ...(marks ? { marks } : {}),
  });
  const paragraph = (value: string) => ({
    type: 'paragraph',
    content: [text(value)],
  });
  const doc = (...content: any[]) => ({ type: 'doc', content });

  it('lifts a leading H1 and joins all of its text nodes', () => {
    const result = service.extractTitleAndRemoveHeading(
      doc(
        heading(
          1,
          text('Hello '),
          text('World', [{ type: 'bold' }]),
          { type: 'hardBreak' },
          text('again'),
        ),
        paragraph('body'),
      ),
      { requireSingleH1: true },
    );
    expect(result.title).toBe('Hello World again');
    expect(result.prosemirrorJson.content).toEqual([paragraph('body')]);
  });

  it('keeps the body when another H1 exists and single H1 is required', () => {
    const state = doc(
      heading(1, text('Background')),
      paragraph('a'),
      heading(1, text('Plan')),
    );
    const result = service.extractTitleAndRemoveHeading(state, {
      requireSingleH1: true,
    });
    expect(result.title).toBeNull();
    expect(result.prosemirrorJson.content).toHaveLength(3);
  });

  it('still lifts the first of several H1s without the option', () => {
    const result = service.extractTitleAndRemoveHeading(
      doc(heading(1, text('Title')), heading(1, text('Section'))),
    );
    expect(result.title).toBe('Title');
    expect(result.prosemirrorJson.content).toEqual([
      heading(1, text('Section')),
    ]);
  });

  it.each([
    ['a paragraph', paragraph('intro')],
    ['an H2', heading(2, text('Section'))],
    ['an empty H1', heading(1)],
  ])('keeps the body when the first block is %s', (_, first) => {
    const result = service.extractTitleAndRemoveHeading(
      doc(first, paragraph('body')),
      { requireSingleH1: true },
    );
    expect(result.title).toBeNull();
    expect(result.prosemirrorJson.content).toEqual([first, paragraph('body')]);
  });
});
