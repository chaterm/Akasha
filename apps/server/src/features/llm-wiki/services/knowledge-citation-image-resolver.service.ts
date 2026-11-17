import { Injectable, Logger } from '@nestjs/common';
import { Attachment } from '@akasha/db/types/entity.types';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import {
  KnowledgeCitationImageRepo,
  RunImageCandidate,
} from '@akasha/db/repos/llm-wiki/knowledge-citation-image.repo';
import { TokenService } from '../../../core/auth/services/token.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import {
  informativeTerms,
  normalizeSearchText,
} from './knowledge-text-matching.util';
import {
  KnowledgeCitation,
  KnowledgeQueryCitation,
  KnowledgeQueryCitationImage,
} from './knowledge-context-pack.service';
import type { AiKnowledgeCitationEvidence } from './ai-knowledge-chat.service';

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg']);
const MAX_IMAGES_PER_QUERY = 6;
const MIN_WEAK_ASSOCIATION_SCORE = 3;
const GENERIC_MATCH_TERMS = new Set(['图片', '截图', '示意', '意图']);
const ATTACHMENT_ID_PATTERN = /附件\s*ID:\s*([0-9a-fA-F-]{36})/g;

const ASSOCIATION_STRONG = 0;
const ASSOCIATION_WEAK = 1;

type SelectedImage = {
  citationIndex: number;
  sourcePageId: string;
  attachmentId: string;
  attachment: Attachment;
  associationType: typeof ASSOCIATION_STRONG | typeof ASSOCIATION_WEAK;
  score: number;
  imageOrdinal: number;
  description: string;
};

@Injectable()
export class KnowledgeCitationImageResolverService {
  private readonly logger = new Logger(
    KnowledgeCitationImageResolverService.name,
  );

  constructor(
    private readonly citationImageRepo: KnowledgeCitationImageRepo,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly tokenService: TokenService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async resolveImagesForCitations(input: {
    workspaceId: string;
    citations: KnowledgeCitation[];
    citationEvidence: AiKnowledgeCitationEvidence[];
    answerText: string;
  }): Promise<KnowledgeQueryCitation[]> {
    const { workspaceId, citations, citationEvidence, answerText } = input;

    if (citations.length === 0) return [];

    const evidenceTextByPage = this.buildEvidenceTextByPage(citationEvidence);

    const strongByCitation = citations.map((citation) =>
      this.extractStrongAttachmentIds(
        evidenceTextByPage.get(citation.sourcePageId) ?? '',
      ),
    );

    const sourcePageIds = [...new Set(citations.map((c) => c.sourcePageId))];
    const runImages =
      await this.citationImageRepo.findCurrentPublishedRunImages({
        workspaceId,
        sourcePageIds,
      });
    const runImagesByPage = new Map<string, RunImageCandidate[]>();
    for (const image of runImages) {
      const list = runImagesByPage.get(image.sourcePageId) ?? [];
      list.push(image);
      runImagesByPage.set(image.sourcePageId, list);
    }
    const runAltByPageAttachment = new Map<string, string | null>();
    const runOrdinalByPageAttachment = new Map<string, number>();
    for (const image of runImages) {
      const key = `${image.sourcePageId} ${image.attachmentId}`;
      runAltByPageAttachment.set(key, image.altText);
      runOrdinalByPageAttachment.set(key, image.imageOrdinal);
    }

    const candidateAttachmentIds = new Set<string>();
    for (const ids of strongByCitation) {
      for (const id of ids.keys()) candidateAttachmentIds.add(id);
    }
    for (const image of runImages) {
      candidateAttachmentIds.add(image.attachmentId);
    }
    const attachments = await this.attachmentRepo.findByIds([
      ...candidateAttachmentIds,
    ]);
    const attachmentById = new Map<string, Attachment>();
    for (const attachment of attachments) {
      attachmentById.set(attachment.id, attachment);
    }

    const extractionIds = runImages
      .map((image) => image.extractionId)
      .filter((id): id is string => id !== null);
    const strongAttachmentIds = strongByCitation.flatMap((ids) => [
      ...ids.keys(),
    ]);
    const captionByAttachment =
      await this.citationImageRepo.findExtractionCaptions({
        workspaceId,
        extractionIds,
        attachmentIds: strongAttachmentIds,
      });

    const selected = this.selectImages({
      citations,
      workspaceId,
      strongByCitation,
      runImagesByPage,
      attachmentById,
      captionByAttachment,
      runAltByPageAttachment,
      runOrdinalByPageAttachment,
      answerText,
      evidenceTextByPage,
    });

    return this.assembleCitations({ citations, workspaceId, selected });
  }

  private buildEvidenceTextByPage(
    citationEvidence: AiKnowledgeCitationEvidence[],
  ): Map<string, string> {
    const byPage = new Map<string, string[]>();
    for (const evidence of citationEvidence) {
      const texts = byPage.get(evidence.sourcePageId) ?? [];
      for (const excerpt of evidence.excerpts) {
        texts.push(excerpt.text);
      }
      byPage.set(evidence.sourcePageId, texts);
    }
    const joined = new Map<string, string>();
    for (const [pageId, texts] of byPage) {
      joined.set(pageId, texts.join('\n'));
    }
    return joined;
  }

  private extractStrongAttachmentIds(text: string): Map<string, number> {
    const ids = new Map<string, number>();
    if (!text) return ids;
    ATTACHMENT_ID_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTACHMENT_ID_PATTERN.exec(text)) !== null) {
      const attachmentId = match[1].toLowerCase();
      if (!ids.has(attachmentId)) {
        ids.set(attachmentId, match.index);
      }
    }
    return ids;
  }

  private validateAttachment(
    attachment: Attachment | undefined,
    sourcePageId: string,
    workspaceId: string,
  ): Attachment | null {
    if (!attachment) return null;
    if (attachment.deletedAt !== null) return null;
    if (attachment.type !== AttachmentType.File) return null;
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)) return null;
    if (attachment.pageId !== sourcePageId) return null;
    if (attachment.workspaceId !== workspaceId) return null;
    return attachment;
  }

  private selectImages(args: {
    citations: KnowledgeCitation[];
    workspaceId: string;
    strongByCitation: Array<Map<string, number>>;
    runImagesByPage: Map<string, RunImageCandidate[]>;
    attachmentById: Map<string, Attachment>;
    captionByAttachment: Map<string, string>;
    runAltByPageAttachment: Map<string, string | null>;
    runOrdinalByPageAttachment: Map<string, number>;
    answerText: string;
    evidenceTextByPage: Map<string, string>;
  }): SelectedImage[] {
    const {
      citations,
      workspaceId,
      strongByCitation,
      runImagesByPage,
      attachmentById,
      captionByAttachment,
      runAltByPageAttachment,
      runOrdinalByPageAttachment,
      answerText,
      evidenceTextByPage,
    } = args;

    const candidates: SelectedImage[] = [];

    citations.forEach((citation, citationIndex) => {
      const pageId = citation.sourcePageId;
      const strongIds = strongByCitation[citationIndex];
      const strongCovered = new Set<string>();

      for (const [attachmentId, evidenceIndex] of strongIds) {
        const attachment = this.validateAttachment(
          attachmentById.get(attachmentId),
          pageId,
          workspaceId,
        );
        if (!attachment) continue;
        strongCovered.add(attachmentId);
        const altKey = `${pageId} ${attachmentId}`;
        const alt = runAltByPageAttachment.get(altKey) ?? null;
        const caption = captionByAttachment.get(attachmentId) ?? '';
        candidates.push({
          citationIndex,
          sourcePageId: pageId,
          attachmentId,
          attachment,
          associationType: ASSOCIATION_STRONG,
          score: Number.POSITIVE_INFINITY,
          imageOrdinal: runOrdinalByPageAttachment.get(altKey) ?? evidenceIndex,
          description: this.resolveDescription(alt, caption),
        });
      }

      if (strongCovered.size > 0) return;

      const matchText = `${answerText}\n${evidenceTextByPage.get(pageId) ?? ''}`;
      const queryTerms = informativeTerms(matchText).filter(
        (term) => !GENERIC_MATCH_TERMS.has(term),
      );
      const normalizedMatchText = this.collapseWhitespace(
        normalizeSearchText(matchText),
      );

      let best: SelectedImage | null = null;
      for (const runImage of runImagesByPage.get(pageId) ?? []) {
        const attachment = this.validateAttachment(
          attachmentById.get(runImage.attachmentId),
          pageId,
          workspaceId,
        );
        if (!attachment) continue;

        const caption = captionByAttachment.get(runImage.attachmentId) ?? '';
        const score = this.scoreWeakCandidate({
          alt: runImage.altText,
          caption,
          queryTerms,
          normalizedMatchText,
        });
        if (score < MIN_WEAK_ASSOCIATION_SCORE) continue;

        const candidate: SelectedImage = {
          citationIndex,
          sourcePageId: pageId,
          attachmentId: runImage.attachmentId,
          attachment,
          associationType: ASSOCIATION_WEAK,
          score,
          imageOrdinal: runImage.imageOrdinal,
          description: this.resolveDescription(runImage.altText, caption),
        };
        if (best === null || this.isBetterWeak(candidate, best)) {
          best = candidate;
        }
      }
      if (best !== null) candidates.push(best);
    });

    return this.mergeSortAndCap(candidates);
  }

  private isBetterWeak(a: SelectedImage, b: SelectedImage): boolean {
    if (a.score !== b.score) return a.score > b.score;
    if (a.imageOrdinal !== b.imageOrdinal)
      return a.imageOrdinal < b.imageOrdinal;
    return a.attachmentId < b.attachmentId;
  }

  private mergeSortAndCap(candidates: SelectedImage[]): SelectedImage[] {
    candidates.sort((a, b) => {
      if (a.associationType !== b.associationType)
        return a.associationType - b.associationType;
      if (a.citationIndex !== b.citationIndex)
        return a.citationIndex - b.citationIndex;
      if (a.score !== b.score) return b.score - a.score;
      if (a.imageOrdinal !== b.imageOrdinal)
        return a.imageOrdinal - b.imageOrdinal;
      return a.attachmentId < b.attachmentId ? -1 : 1;
    });

    const seen = new Set<string>();
    const deduped: SelectedImage[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.attachmentId)) continue;
      seen.add(candidate.attachmentId);
      deduped.push(candidate);
      if (deduped.length >= MAX_IMAGES_PER_QUERY) break;
    }
    return deduped;
  }

  private scoreWeakCandidate(args: {
    alt: string | null;
    caption: string;
    queryTerms: string[];
    normalizedMatchText: string;
  }): number {
    const { alt, caption, queryTerms, normalizedMatchText } = args;
    if (queryTerms.length === 0) return 0;

    let score = 0;
    const normalizedAlt = this.collapseWhitespace(
      normalizeSearchText(alt ?? ''),
    );
    const normalizedCaption = this.collapseWhitespace(
      normalizeSearchText(caption),
    );

    for (const term of queryTerms) {
      if (normalizedAlt.includes(term)) score += 2;
    }
    for (const term of queryTerms) {
      if (normalizedCaption.includes(term)) score += 1;
    }

    if (normalizedAlt && normalizedMatchText.includes(normalizedAlt)) {
      score += 3;
    }

    const hasIdentifierHit = queryTerms.some(
      (term) =>
        normalizedAlt.includes(term) &&
        (/[_/.:-]/.test(term) || (/[a-z]/.test(term) && /[0-9]/.test(term))),
    );
    if (hasIdentifierHit) score += 1;

    return score;
  }

  private resolveDescription(alt: string | null, caption: string): string {
    const trimmedAlt = alt?.trim();
    if (trimmedAlt) return trimmedAlt;
    const trimmedCaption = caption.trim();
    if (trimmedCaption) return trimmedCaption;
    return '';
  }

  private collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private async assembleCitations(args: {
    citations: KnowledgeCitation[];
    workspaceId: string;
    selected: SelectedImage[];
  }): Promise<KnowledgeQueryCitation[]> {
    const { citations, workspaceId, selected } = args;

    const settled = await Promise.allSettled(
      selected.map((image) => this.buildImage(image, workspaceId)),
    );

    const imagesByCitation = new Map<number, KnowledgeQueryCitationImage[]>();
    let failedTokenCount = 0;
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled' || result.value === null) {
        failedTokenCount += 1;
        return;
      }
      const citationIndex = selected[index].citationIndex;
      const list = imagesByCitation.get(citationIndex) ?? [];
      list.push(result.value);
      imagesByCitation.set(citationIndex, list);
    });

    if (failedTokenCount > 0) {
      this.logger.warn(
        `image url signing skipped ${failedTokenCount} image(s) ` +
          `[workspaceId=${workspaceId}, stage=token, selected=${selected.length}]`,
      );
    }

    return citations.map((citation, citationIndex) => ({
      ...citation,
      images: imagesByCitation.get(citationIndex) ?? [],
    }));
  }

  private async buildImage(
    image: SelectedImage,
    workspaceId: string,
  ): Promise<KnowledgeQueryCitationImage | null> {
    try {
      const token = await this.tokenService.generateAttachmentToken({
        attachmentId: image.attachmentId,
        pageId: image.sourcePageId,
        workspaceId,
      });
      const appUrl = this.environmentService.getAppUrl();
      const fileName = image.attachment.fileName;
      const url = `${appUrl}/api/files/public/${image.attachmentId}/${encodeURIComponent(
        fileName,
      )}?jwt=${token}`;
      return {
        attachmentId: image.attachmentId,
        fileName,
        mimeType: image.attachment.mimeType,
        url,
        description: image.description,
      };
    } catch {
      return null;
    }
  }
}
