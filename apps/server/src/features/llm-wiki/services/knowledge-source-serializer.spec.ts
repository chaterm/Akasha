import {
  attachmentMarker,
  serializeKnowledgeSource,
} from './knowledge-source-serializer';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { Attachment } from '@akasha/db/types/entity.types';
import { jsonToText } from '../../../collaboration/collaboration.util';

const WORKSPACE = 'w-1';
const SPACE = 's-1';
const PAGE = 'p-1';

function attachment(
  overrides: Partial<Attachment> & { id: string },
): Attachment {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    spaceId: overrides.spaceId ?? SPACE,
    pageId: overrides.pageId ?? PAGE,
    aiChatId: null,
    creatorId: 'u-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-02-02T00:00:00.000Z'),
    deletedAt: overrides.deletedAt ?? null,
    fileExt: overrides.fileExt ?? '.pdf',
    fileName: overrides.fileName ?? 'file.pdf',
    filePath: 'path/file.pdf',
    fileSize: overrides.fileSize ?? (1024 as unknown as Attachment['fileSize']),
    mimeType: overrides.mimeType ?? 'application/pdf',
    textContent: null,
    tsv: null,
    type: overrides.type ?? AttachmentType.File,
  } as Attachment;
}

function attachmentNode(attachmentId: string, type = 'attachment') {
  return { type, attrs: { attachmentId } };
}

function paragraph(...content: unknown[]) {
  return { type: 'paragraph', content };
}

function textNode(text: string) {
  return { type: 'text', text };
}

describe('serializeKnowledgeSource', () => {
  it('emits a marker and occurrence for a normal file attachment in place', () => {
    const content = {
      type: 'doc',
      content: [
        paragraph(textNode('See the config below.')),
        attachmentNode('att-1'),
        paragraph(textNode('Then restart.')),
      ],
    };
    const file = attachment({ id: 'att-1', fileName: 'config.xlsx' });

    const result = serializeKnowledgeSource({
      page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
      attachmentsByPage: [file],
    });

    expect(result.attachmentOccurrences).toHaveLength(1);
    const occurrence = result.attachmentOccurrences[0];
    expect(occurrence.attachmentId).toBe('att-1');
    expect(occurrence.sourcePageId).toBe(PAGE);
    expect(occurrence.attachmentUpdatedAt).toBe(file.updatedAt.toISOString());
    const span = result.text.slice(
      occurrence.startOffset,
      occurrence.endOffset,
    );
    expect(span).toBe(`config.xlsx ${attachmentMarker('att-1')}`);
    expect(result.text).toContain(attachmentMarker('att-1'));
    expect(result.blocks).toHaveLength(3);
  });

  it('emits markers for pdf nodes', () => {
    const content = {
      type: 'doc',
      content: [attachmentNode('att-1', 'pdf')],
    };
    const result = serializeKnowledgeSource({
      page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
      attachmentsByPage: [attachment({ id: 'att-1', fileName: 'spec.pdf' })],
    });
    expect(result.attachmentOccurrences).toHaveLength(1);
    expect(result.text).toContain(`spec.pdf ${attachmentMarker('att-1')}`);
  });

  it('drills into nested lists', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [paragraph(textNode('Item')), attachmentNode('att-1')],
            },
          ],
        },
      ],
    };
    const result = serializeKnowledgeSource({
      page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
      attachmentsByPage: [attachment({ id: 'att-1', fileName: 'nested.pdf' })],
    });
    expect(result.attachmentOccurrences).toHaveLength(1);
    expect(result.text).toContain(`nested.pdf ${attachmentMarker('att-1')}`);
  });

  it('drills into tables down to cells', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [paragraph(attachmentNode('att-1'))],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = serializeKnowledgeSource({
      page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
      attachmentsByPage: [attachment({ id: 'att-1', fileName: 'cell.pdf' })],
    });
    expect(result.attachmentOccurrences).toHaveLength(1);
    expect(result.text).toContain(`cell.pdf ${attachmentMarker('att-1')}`);
  });

  it('does not emit occurrences for image attachments', () => {
    const content = { type: 'doc', content: [attachmentNode('att-1')] };
    const png = attachment({
      id: 'att-1',
      fileName: 'diagram.png',
      mimeType: 'image/png',
      fileExt: '.png',
    });
    const svg = attachment({
      id: 'att-1',
      fileName: 'diagram.svg',
      mimeType: 'image/svg+xml',
      fileExt: '.svg',
    });
    // Generic/missing MIME falls back to the extension check. This must cover
    // every raster extension the exporter recognizes (jpe/apng/tif/dib
    // included), otherwise an image leaks into the top-level attachments.
    const octetImages = [
      '.png',
      '.apng',
      '.jpe',
      '.tif',
      '.dib',
      '.heic',
      '.ico',
    ].map((fileExt) =>
      attachment({
        id: 'att-1',
        fileName: `diagram${fileExt}`,
        mimeType: 'application/octet-stream',
        fileExt,
      }),
    );

    for (const file of [png, svg, ...octetImages]) {
      const result = serializeKnowledgeSource({
        page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
        attachmentsByPage: [file],
      });
      expect(result.attachmentOccurrences).toHaveLength(0);
    }
  });

  it('keeps old node names and user-typed markers as ordinary text', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'attachment',
          attrs: { name: 'legacy.pdf', url: '/api/files/att-1/file.pdf' },
        },
        paragraph(textNode(`hand written ${attachmentMarker('att-1')}`)),
        { type: 'text', text: 'external', marks: [{ type: 'link' }] },
      ],
    };
    const result = serializeKnowledgeSource({
      page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
      attachmentsByPage: [attachment({ id: 'att-1', fileName: 'file.pdf' })],
    });
    expect(result.attachmentOccurrences).toHaveLength(0);
    expect(result.text).toContain('legacy.pdf');
    expect(result.text).toContain(attachmentMarker('att-1'));
  });

  it('emits one occurrence per node when the same file appears twice', () => {
    const content = {
      type: 'doc',
      content: [
        paragraph(attachmentNode('att-1')),
        paragraph(attachmentNode('att-1')),
      ],
    };
    const result = serializeKnowledgeSource({
      page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
      attachmentsByPage: [attachment({ id: 'att-1', fileName: 'dup.pdf' })],
    });
    expect(result.attachmentOccurrences).toHaveLength(2);
    expect(
      result.attachmentOccurrences.every((o) => o.attachmentId === 'att-1'),
    ).toBe(true);
  });

  it('excludes attachments that do not match workspace/space/page', () => {
    const content = { type: 'doc', content: [attachmentNode('att-1')] };
    const cases = [
      attachment({ id: 'att-1', workspaceId: 'other' }),
      attachment({ id: 'att-1', spaceId: 'other' }),
      attachment({ id: 'att-1', pageId: 'other' }),
      attachment({ id: 'att-1', deletedAt: new Date() }),
      attachment({ id: 'att-1', type: AttachmentType.Chat }),
    ];
    for (const file of cases) {
      const result = serializeKnowledgeSource({
        page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
        attachmentsByPage: [file],
      });
      expect(result.attachmentOccurrences).toHaveLength(0);
    }
  });

  it('preserves schema-aware mention text on attachment-bearing pages', () => {
    const before = paragraph(textNode('Owner: '), {
      type: 'mention',
      attrs: {
        id: 'user-1',
        entityId: 'user-1',
        entityType: 'user',
        label: 'Alice',
      },
    });
    const after = paragraph(textNode('Review after deployment.'));
    const content = {
      type: 'doc',
      content: [before, attachmentNode('att-1'), after],
    };

    const result = serializeKnowledgeSource({
      page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
      attachmentsByPage: [attachment({ id: 'att-1', fileName: 'plan.pdf' })],
    });

    expect(result.text).toContain(
      jsonToText({ type: 'doc', content: [before] }),
    );
    expect(result.text).toContain('@Alice');
    expect(result.text).toContain('Review after deployment.');
    expect(result.attachmentOccurrences).toHaveLength(1);
  });

  it('produces deterministic text, offsets, and blocks despite random sentinels', () => {
    const content = {
      type: 'doc',
      content: [
        paragraph(textNode('Before')),
        attachmentNode('att-1'),
        paragraph(textNode('After')),
      ],
    };
    const input = {
      page: { id: PAGE, workspaceId: WORKSPACE, spaceId: SPACE, content },
      attachmentsByPage: [attachment({ id: 'att-1', fileName: 'stable.pdf' })],
    };

    const first = serializeKnowledgeSource(input);
    const second = serializeKnowledgeSource(input);

    expect(second).toEqual(first);
    expect(first.text).not.toContain('AKASHA_SOURCE_ATTACHMENT');
  });
});
