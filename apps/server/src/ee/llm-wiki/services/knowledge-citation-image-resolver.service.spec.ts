import { Attachment } from '@akasha/db/types/entity.types';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import {
  KnowledgeCitationImageRepo,
  RunImageCandidate,
} from '@akasha/db/repos/llm-wiki/knowledge-citation-image.repo';
import { TokenService } from '../../../core/auth/services/token.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { KnowledgeCitationImageResolverService } from './knowledge-citation-image-resolver.service';
import type { KnowledgeCitation } from './knowledge-context-pack.service';
import type { AiKnowledgeCitationEvidence } from './ai-knowledge-chat.service';

const APP_URL = 'https://example.com';
const WORKSPACE = 'workspace-1';

/** Deterministic 36-char lowercase uuid-shaped id matching the strong regex. */
function uid(seed: number): string {
  const hex = seed.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

function citation(sourcePageId: string, n = 1): KnowledgeCitation {
  return {
    sourcePageId,
    title: `Title ${sourcePageId} ${n}`,
    url: `/p/${sourcePageId}`,
  };
}

function evidence(
  sourcePageId: string,
  texts: string[],
): AiKnowledgeCitationEvidence {
  return {
    ...citation(sourcePageId),
    excerpts: texts.map((text) => ({
      text,
      sourceRange: { startOffset: 0, endOffset: text.length },
      quoteHash: `sha256:${text.length}`,
    })),
  };
}

function attachment(
  id: string,
  pageId: string,
  overrides: Partial<Attachment> = {},
): Attachment {
  return {
    id,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    type: AttachmentType.File,
    pageId,
    spaceId: 'space-1',
    workspaceId: WORKSPACE,
    deletedAt: null,
    ...overrides,
  } as unknown as Attachment;
}

function runImage(
  sourcePageId: string,
  attachmentId: string,
  overrides: Partial<RunImageCandidate> = {},
): RunImageCandidate {
  return {
    sourcePageId,
    attachmentId,
    altText: null,
    imageOrdinal: 0,
    extractionId: null,
    fileName: `${attachmentId}.png`,
    mimeType: 'image/png',
    ...overrides,
  };
}

type Mocks = {
  citationImageRepo: {
    findCurrentPublishedRunImages: jest.Mock;
    findExtractionCaptions: jest.Mock;
  };
  attachmentRepo: { findByIds: jest.Mock };
  tokenService: { generateAttachmentToken: jest.Mock };
  environmentService: { getAppUrl: jest.Mock };
};

function buildService(config: {
  runImages?: RunImageCandidate[];
  captions?: Map<string, string>;
  attachments?: Attachment[];
  tokenImpl?: (attachmentId: string) => Promise<string>;
}): { service: KnowledgeCitationImageResolverService; mocks: Mocks } {
  const mocks: Mocks = {
    citationImageRepo: {
      findCurrentPublishedRunImages: jest
        .fn()
        .mockResolvedValue(config.runImages ?? []),
      findExtractionCaptions: jest
        .fn()
        .mockResolvedValue(config.captions ?? new Map<string, string>()),
    },
    attachmentRepo: {
      findByIds: jest.fn().mockResolvedValue(config.attachments ?? []),
    },
    tokenService: {
      generateAttachmentToken: jest.fn(
        async (opts: { attachmentId: string }) =>
          config.tokenImpl
            ? config.tokenImpl(opts.attachmentId)
            : `tok-${opts.attachmentId}`,
      ),
    },
    environmentService: { getAppUrl: jest.fn().mockReturnValue(APP_URL) },
  };

  const service = new KnowledgeCitationImageResolverService(
    mocks.citationImageRepo as unknown as KnowledgeCitationImageRepo,
    mocks.attachmentRepo as unknown as AttachmentRepo,
    mocks.tokenService as unknown as TokenService,
    mocks.environmentService as unknown as EnvironmentService,
  );
  return { service, mocks };
}

function publicUrl(attachmentId: string, fileName: string): string {
  return `${APP_URL}/api/files/public/${attachmentId}/${encodeURIComponent(
    fileName,
  )}?jwt=tok-${attachmentId}`;
}

describe('KnowledgeCitationImageResolverService', () => {
  it('returns [] and skips repo work when there are no citations', async () => {
    const { service, mocks } = buildService({});
    await expect(
      service.resolveImagesForCitations({
        workspaceId: WORKSPACE,
        citations: [],
        citationEvidence: [],
        answerText: 'anything',
      }),
    ).resolves.toEqual([]);
    expect(
      mocks.citationImageRepo.findCurrentPublishedRunImages,
    ).not.toHaveBeenCalled();
  });

  // 1. Strong association from evidence attachment id.
  it('returns a strong-association image when evidence carries a valid 附件 ID', async () => {
    const attId = uid(1);
    const { service } = buildService({
      attachments: [attachment(attId, 'page-1', { fileName: 'diagram.png' })],
    });

    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [evidence('page-1', [`见图 附件 ID: ${attId} 说明`])],
      answerText: 'irrelevant answer',
    });

    expect(resolved.images).toEqual([
      {
        attachmentId: attId,
        fileName: 'diagram.png',
        mimeType: 'image/png',
        url: publicUrl(attId, 'diagram.png'),
        description: '',
      },
    ]);
  });

  // 2. Weak association: highest-scoring run image whose alt hits answer text.
  it('returns the single highest-scoring weak image matching the answer text', async () => {
    const high = uid(10);
    const low = uid(11);
    const { service } = buildService({
      runImages: [
        runImage('page-1', high, {
          altText: 'deployment architecture',
          imageOrdinal: 0,
        }),
        runImage('page-1', low, {
          altText: 'deployment overview',
          imageOrdinal: 1,
          extractionId: 'ext-low',
        }),
      ],
      captions: new Map([[low, 'deployment']]),
      attachments: [
        attachment(high, 'page-1', { fileName: 'high.png' }),
        attachment(low, 'page-1'),
      ],
    });

    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [],
      answerText: 'Please review the deployment architecture diagram.',
    });

    expect(resolved.images).toHaveLength(1);
    expect(resolved.images[0].attachmentId).toBe(high);
    expect(resolved.images[0].description).toBe('deployment architecture');
  });

  // 3. A run-image attachment alone never becomes a strong association.
  it('does not treat a run-image candidate as strong when evidence has no 附件 ID', async () => {
    const attId = uid(20);
    const { service } = buildService({
      runImages: [runImage('page-1', attId, { altText: 'unrelated banner' })],
      attachments: [attachment(attId, 'page-1')],
    });

    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [evidence('page-1', ['文本里没有附件标识'])],
      answerText: 'question about pricing tiers',
    });

    // No strong (no id), and weak alt does not hit the answer -> empty.
    expect(resolved.images).toEqual([]);
  });

  // 4. Scoring: below-threshold weak candidate is dropped; identifier bonus lifts it.
  it('drops a weak candidate scoring below 3 and keeps one lifted by the identifier bonus', async () => {
    // alt "value details" hits only "value" (+2); not a verbatim phrase in the
    // match text and no identifier term -> total 2, below the threshold of 3.
    const plain = uid(30);
    const { service: svcPlain } = buildService({
      runImages: [runImage('page-1', plain, { altText: 'value details' })],
      attachments: [attachment(plain, 'page-1')],
    });
    const [plainResolved] = await svcPlain.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [],
      answerText: 'the value here',
    });
    expect(plainResolved.images).toEqual([]);

    // alt "x1a details" hits "x1a" (+2) + identifier bonus (+1, mixed alnum) = 3.
    const ident = uid(31);
    const { service: svcIdent } = buildService({
      runImages: [runImage('page-1', ident, { altText: 'x1a details' })],
      attachments: [attachment(ident, 'page-1')],
    });
    const [identResolved] = await svcIdent.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [],
      answerText: 'the x1a here',
    });
    expect(identResolved.images).toHaveLength(1);
    expect(identResolved.images[0].attachmentId).toBe(ident);
  });

  // 5. Only one weak image per citation (already partly covered in test 2).
  it('keeps at most one weak image per citation', async () => {
    const a = uid(40);
    const b = uid(41);
    const { service } = buildService({
      runImages: [
        runImage('page-1', a, { altText: 'deployment guide notes' }),
        runImage('page-1', b, { altText: 'deployment guide steps' }),
      ],
      attachments: [attachment(a, 'page-1'), attachment(b, 'page-1')],
    });
    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [],
      answerText: 'read the deployment guide steps and notes',
    });
    expect(resolved.images).toHaveLength(1);
  });

  // 6. Global 6-image cap + strong-first ordering across citations.
  it('caps at 6 images globally with strong associations taking the whole budget', async () => {
    const strongIds = Array.from({ length: 7 }, (_, i) => uid(50 + i));
    const weakId = uid(60);
    const evidenceText = strongIds
      .map((id) => `附件 ID: ${id}`)
      .join('\n');

    const { service } = buildService({
      runImages: [runImage('page-A', weakId, { altText: 'deployment guide' })],
      attachments: [
        ...strongIds.map((id, i) =>
          attachment(id, 'page-B', { fileName: `s${i}.png` }),
        ),
        attachment(weakId, 'page-A'),
      ],
    });

    const resolved = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-A'), citation('page-B')],
      citationEvidence: [
        evidence('page-A', ['weak page evidence']),
        evidence('page-B', [evidenceText]),
      ],
      answerText: 'read the deployment guide',
    });

    const citationA = resolved[0];
    const citationB = resolved[1];
    // 6 strong from B fill the budget; weak A gets nothing.
    expect(citationB.images).toHaveLength(6);
    expect(citationA.images).toHaveLength(0);
    // First 6 strong ids in evidence order (imageOrdinal falls back to first
    // occurrence index, which is ascending along the evidence text).
    expect(citationB.images.map((img) => img.attachmentId)).toEqual(
      strongIds.slice(0, 6),
    );
  });

  // 7. Same attachmentId dedupe across citations.
  it('dedupes the same attachmentId shared across citations', async () => {
    const shared = uid(70);
    const { service } = buildService({
      attachments: [attachment(shared, 'page-1')],
    });

    const resolved = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      // Both citations point at page-1 and both reference the shared id.
      citations: [citation('page-1'), citation('page-1')],
      citationEvidence: [evidence('page-1', [`附件 ID: ${shared}`])],
      answerText: 'irrelevant',
    });

    const all = resolved.flatMap((c) => c.images.map((i) => i.attachmentId));
    expect(all).toEqual([shared]);
  });

  // 8. §4.3 record validation filters.
  it('filters strong candidates failing §4.3 record validation without dropping valid ones', async () => {
    const missing = uid(80);
    const deleted = uid(81);
    const wrongType = uid(82);
    const badMime = uid(83);
    const wrongPage = uid(84);
    const wrongWorkspace = uid(85);
    const valid = uid(86);

    const { service } = buildService({
      attachments: [
        attachment(deleted, 'page-1', { deletedAt: new Date() }),
        attachment(wrongType, 'page-1', { type: AttachmentType.Chat }),
        attachment(badMime, 'page-1', { mimeType: 'image/gif' }),
        attachment(wrongPage, 'page-2'),
        attachment(wrongWorkspace, 'page-1', { workspaceId: 'other-ws' }),
        attachment(valid, 'page-1', { fileName: 'ok.png' }),
        // `missing` intentionally absent from findByIds result.
      ],
    });

    const ids = [
      missing,
      deleted,
      wrongType,
      badMime,
      wrongPage,
      wrongWorkspace,
      valid,
    ];
    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [
        evidence(
          'page-1',
          ids.map((id) => `附件 ID: ${id}`),
        ),
      ],
      answerText: 'irrelevant',
    });

    expect(resolved.images.map((i) => i.attachmentId)).toEqual([valid]);
  });

  // 9. No candidates -> empty images array.
  it('returns images: [] for a citation with no candidates at all', async () => {
    const { service } = buildService({});
    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [evidence('page-1', ['plain text, no ids'])],
      answerText: 'nothing matches',
    });
    expect(resolved.images).toEqual([]);
  });

  // 10a. Description priority alt > caption > '' via the WEAK path, which reads
  //      alt straight off the run candidate (unaffected by the strong-path key
  //      bug documented in test 10c).
  it('resolves weak-image description with alt > caption > empty precedence', async () => {
    // alt present -> alt wins (trimmed).
    const altWins = uid(90);
    const { service: svcAlt } = buildService({
      runImages: [
        runImage('page-1', altWins, { altText: '  deployment guide  ' }),
      ],
      attachments: [attachment(altWins, 'page-1')],
    });
    const [rAlt] = await svcAlt.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [],
      answerText: 'the deployment guide steps',
    });
    expect(rAlt.images[0].description).toBe('deployment guide');

    // alt empty, caption present -> caption wins (trimmed). Score comes from
    // caption term hits (deployment+guide+steps = 3).
    const captionWins = uid(91);
    const { service: svcCap } = buildService({
      runImages: [
        runImage('page-1', captionWins, {
          altText: null,
          extractionId: 'ext-cap',
        }),
      ],
      // findExtractionCaptions returns a map keyed by attachmentId.
      captions: new Map([[captionWins, '  deployment guide steps  ']]),
      attachments: [attachment(captionWins, 'page-1')],
    });
    const [rCap] = await svcCap.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [],
      answerText: 'the deployment guide steps',
    });
    expect(rCap.images[0].description).toBe('deployment guide steps');
  });

  // 10b. Strong image with neither alt nor caption -> description ''.
  it('gives a strong image an empty description when no alt/caption is available', async () => {
    const attId = uid(93);
    const { service } = buildService({
      attachments: [attachment(attId, 'page-1')],
    });
    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [evidence('page-1', [`附件 ID: ${attId}`])],
      answerText: 'irrelevant',
    });
    expect(resolved.images[0].description).toBe('');
  });

  // 10c. When a strong-association attachment also exists in the current
  //      published run, its description prefers the run image's altText over
  //      caption (design §5 alt -> caption -> ''), keyed by pageId + attachmentId.
  it('strong image prefers run alt over caption for its description', async () => {
    const attId = uid(94);
    const { service } = buildService({
      runImages: [
        runImage('page-1', attId, { altText: 'diagram alt', imageOrdinal: 7 }),
      ],
      captions: new Map([[attId, 'caption fallback']]),
      attachments: [attachment(attId, 'page-1')],
    });
    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [evidence('page-1', [`附件 ID: ${attId}`])],
      answerText: 'irrelevant',
    });
    expect(resolved.images[0].description).toBe('diagram alt');
  });

  // 11. URL format with special-character filenames encoded.
  it('signs public URLs and encodeURIComponent-encodes special filenames', async () => {
    const attId = uid(100);
    const fileName = '架构 图/v2 final.png';
    const { service } = buildService({
      attachments: [attachment(attId, 'page-1', { fileName })],
    });

    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [evidence('page-1', [`附件 ID: ${attId}`])],
      answerText: 'irrelevant',
    });

    expect(resolved.images[0].url).toBe(
      `${APP_URL}/api/files/public/${attId}/${encodeURIComponent(
        fileName,
      )}?jwt=tok-${attId}`,
    );
    expect(resolved.images[0].url).toContain('%E6%9E%B6%E6%9E%84'); // 架构
    expect(resolved.images[0].url).toContain('%2F'); // encoded slash
  });

  // 12. Token failure isolation.
  it('skips only the image whose token signing rejects and keeps the rest', async () => {
    const good = uid(110);
    const bad = uid(111);
    const { service } = buildService({
      attachments: [
        attachment(good, 'page-1', { fileName: 'good.png' }),
        attachment(bad, 'page-1', { fileName: 'bad.png' }),
      ],
      tokenImpl: async (attachmentId) => {
        if (attachmentId === bad) throw new Error('token boom');
        return `tok-${attachmentId}`;
      },
    });

    const [resolved] = await service.resolveImagesForCitations({
      workspaceId: WORKSPACE,
      citations: [citation('page-1')],
      citationEvidence: [
        evidence('page-1', [`附件 ID: ${good}\n附件 ID: ${bad}`]),
      ],
      answerText: 'irrelevant',
    });

    expect(resolved.images.map((i) => i.attachmentId)).toEqual([good]);
  });
});

