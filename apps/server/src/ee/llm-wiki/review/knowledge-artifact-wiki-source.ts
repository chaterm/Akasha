import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import {
  KnowledgeClaim,
  KnowledgeLink,
  KnowledgePage,
  KnowledgePageSource,
} from '@akasha/db/types/entity.types';
import {
  Claim,
  OutLink,
  StructuredWiki,
  WikiDocument,
  WikiFolder,
  parseStructuredWiki,
} from './structured-wiki';
import { WikiSource } from './wiki-source';

const DEFAULT_ARTIFACT_LIMIT = 200;

// Compiler-generated overview pages are summaries, not reviewable artifacts.
const EXCLUDED_PAGE_TYPES = new Set<string>(['overview']);

export type KnowledgeArtifactWikiSourceOptions = {
  workspaceId: string;
  spaceId: string;
  limit?: number;
};

export type ReviewDocMeta = {
  id: string;
  title: string;
  sourcePageId?: string;
};

export class KnowledgeArtifactWikiSource implements WikiSource {
  private cache: StructuredWiki | null = null;
  private docMetaCache: Map<string, ReviewDocMeta> | null = null;

  constructor(
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly options: KnowledgeArtifactWikiSourceOptions,
  ) {}

  async load(): Promise<StructuredWiki> {
    if (this.cache) return this.cache;

    const { workspaceId, spaceId } = this.options;
    const limit = this.options.limit ?? DEFAULT_ARTIFACT_LIMIT;

    const candidates = await this.capsuleRepo.findGraphCandidatesForSpace({
      workspaceId,
      spaceId,
      limit,
    });

    const pages = candidates.pages.filter(
      (page) => !EXCLUDED_PAGE_TYPES.has(page.pageType ?? ''),
    );
    const pageIds = pages.map((p) => p.id);

    const claims = await this.capsuleRepo.findClaimsByPageIds({
      workspaceId,
      knowledgePageIds: pageIds,
    });

    const wiki = this.toStructuredWiki(pages, claims, candidates.links);
    this.docMetaCache = this.buildDocMeta(pages, candidates.pageSources);

    this.cache = parseStructuredWiki(wiki);
    return this.cache;
  }

  async getDocMeta(): Promise<ReviewDocMeta[]> {
    await this.load();
    return [...(this.docMetaCache?.values() ?? [])];
  }

  async getDocument(id: string): Promise<WikiDocument | null> {
    const wiki = await this.load();
    return wiki.documents.find((doc) => doc.id === id) ?? null;
  }

  async listFolders(): Promise<WikiFolder[]> {
    const wiki = await this.load();
    return wiki.folders;
  }

  private toStructuredWiki(
    pages: KnowledgePage[],
    claims: KnowledgeClaim[],
    links: KnowledgeLink[],
  ): StructuredWiki {
    const claimsByPage = new Map<string, Claim[]>();
    for (const c of claims) {
      const list = claimsByPage.get(c.knowledgePageId) ?? [];
      list.push(this.toClaim(c));
      claimsByPage.set(c.knowledgePageId, list);
    }

    const knownPageIds = new Set(pages.map((p) => p.id));
    const linksByPage = new Map<string, OutLink[]>();
    for (const l of links) {
      if (!l.toKnowledgePageId || !knownPageIds.has(l.toKnowledgePageId)) {
        continue;
      }
      const list = linksByPage.get(l.fromKnowledgePageId) ?? [];
      list.push({
        targetDocId: l.toKnowledgePageId,
        type: 'related',
        reason: l.linkText || undefined,
      });
      linksByPage.set(l.fromKnowledgePageId, list);
    }

    const documents: WikiDocument[] = pages.map((page) => ({
      id: page.id,
      title: page.title,
      folderId: null,
      body: page.body,
      claims: claimsByPage.get(page.id) ?? [],
      links: linksByPage.get(page.id) ?? [],
      tags: [],
      status: 'reviewed',
      confidence: 0.5,
    }));

    return {
      version: '1',
      folders: [],
      documents,
    };
  }

  private toClaim(row: KnowledgeClaim): Claim {
    return {
      id: row.id,
      statement: row.text,
      sources: [],
      confidence: row.confidence ?? 0.5,
    };
  }

  private buildDocMeta(
    pages: KnowledgePage[],
    pageSources: KnowledgePageSource[],
  ): Map<string, ReviewDocMeta> {
    const sourceIdsByPage = new Map<string, Set<string>>();
    for (const src of pageSources) {
      const set = sourceIdsByPage.get(src.knowledgePageId) ?? new Set<string>();
      set.add(src.sourcePageId);
      sourceIdsByPage.set(src.knowledgePageId, set);
    }

    const meta = new Map<string, ReviewDocMeta>();
    for (const page of pages) {
      const sourceIds = sourceIdsByPage.get(page.id);
      const sourcePageId =
        sourceIds && sourceIds.size === 1 ? [...sourceIds][0] : undefined;
      meta.set(page.id, { id: page.id, title: page.title, sourcePageId });
    }
    return meta;
  }
}
