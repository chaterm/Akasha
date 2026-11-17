import { User } from '@akasha/db/types/entity.types';

export class KnowledgeAuthorizationCache {
  private readonly workspaceId: string;
  private readonly userId: string;
  private readonly chatId?: string;

  private readonly readableByPageId = new Map<string, boolean>();

  private readonly readableBySpaceId = new Map<string, boolean>();

  private userPromise?: Promise<User | undefined>;

  constructor(scope: { workspaceId: string; userId: string; chatId?: string }) {
    this.workspaceId = scope.workspaceId;
    this.userId = scope.userId;
    this.chatId = scope.chatId;
  }

  getChatId(): string | undefined {
    return this.chatId;
  }

  assertScope(workspaceId: string, userId: string): void {
    if (workspaceId !== this.workspaceId || userId !== this.userId) {
      throw new KnowledgeAuthorizationCacheScopeError(
        `Authorization cache scope mismatch: bound to ${this.workspaceId}/${this.userId}, used with ${workspaceId}/${userId}`,
      );
    }
  }

  getUser(load: () => Promise<User | undefined>): Promise<User | undefined> {
    if (!this.userPromise) {
      const pending = load().catch((error) => {
        if (this.userPromise === pending) {
          this.userPromise = undefined;
        }
        throw error;
      });
      this.userPromise = pending;
    }
    return this.userPromise;
  }

  partitionPages(pageIds: string[]): {
    knownReadable: Set<string>;
    unknown: string[];
  } {
    const knownReadable = new Set<string>();
    const unknown: string[] = [];
    const seenUnknown = new Set<string>();
    for (const pageId of pageIds) {
      const cached = this.readableByPageId.get(pageId);
      if (cached === true) {
        knownReadable.add(pageId);
      } else if (cached === undefined && !seenUnknown.has(pageId)) {
        seenUnknown.add(pageId);
        unknown.push(pageId);
      }
      // cached === false => drop
    }
    return { knownReadable, unknown };
  }

  recordPages(
    queriedPageIds: Iterable<string>,
    readablePageIds: Set<string>,
  ): void {
    for (const pageId of queriedPageIds) {
      this.readableByPageId.set(pageId, readablePageIds.has(pageId));
    }
  }

  partitionSpaces(spaceIds: string[]): {
    knownReadable: Set<string>;
    unknown: string[];
  } {
    const knownReadable = new Set<string>();
    const unknown: string[] = [];
    const seenUnknown = new Set<string>();
    for (const spaceId of spaceIds) {
      const cached = this.readableBySpaceId.get(spaceId);
      if (cached === true) {
        knownReadable.add(spaceId);
      } else if (cached === undefined && !seenUnknown.has(spaceId)) {
        seenUnknown.add(spaceId);
        unknown.push(spaceId);
      }
    }
    return { knownReadable, unknown };
  }

  recordSpaces(
    queriedSpaceIds: Iterable<string>,
    readableSpaceIds: Set<string>,
  ): void {
    for (const spaceId of queriedSpaceIds) {
      this.readableBySpaceId.set(spaceId, readableSpaceIds.has(spaceId));
    }
  }
}

export class KnowledgeAuthorizationCacheScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeAuthorizationCacheScopeError';
  }
}
