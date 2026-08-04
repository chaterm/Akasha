import { User } from '@akasha/db/types/entity.types';

/**
 * Request-scoped memoization for knowledge source authorization.
 *
 * A single instance MUST be bound to exactly one (workspaceId, userId) pair and
 * live for the duration of a single request (e.g. one AiKnowledgeChatService.chat
 * call). It is NEVER shared across requests or users: permissions can change at
 * any time, so a longer-lived cache would open an authorization-staleness window.
 *
 * Within one request the same pages/spaces are authorized several times (main
 * retrieval, two-hop graph expansion, capsule citations, explicit context). This
 * cache removes those repeated lookups while preserving the exact fail-closed
 * semantics of KnowledgeSourceAuthorizationService.
 */
export class KnowledgeAuthorizationCache {
  private readonly workspaceId: string;
  private readonly userId: string;

  // Page-level decisions: true = readable, false = not readable. Only recorded
  // after all dependency queries for that page succeeded.
  private readonly readableByPageId = new Map<string, boolean>();

  // Space-level readability decisions, reused across calls within the request.
  private readonly readableBySpaceId = new Map<string, boolean>();

  // Memoized current user. Undefined = not loaded yet.
  private userPromise?: Promise<User | undefined>;

  constructor(scope: { workspaceId: string; userId: string }) {
    this.workspaceId = scope.workspaceId;
    this.userId = scope.userId;
  }

  /**
   * Guards against a cache instance being reused for a different workspace/user.
   * Throws (fail-closed) on mismatch — callers run this inside their try block so
   * a mismatch degrades to "nothing readable" rather than leaking a cached true.
   */
  assertScope(workspaceId: string, userId: string): void {
    if (workspaceId !== this.workspaceId || userId !== this.userId) {
      throw new KnowledgeAuthorizationCacheScopeError(
        `Authorization cache scope mismatch: bound to ${this.workspaceId}/${this.userId}, used with ${workspaceId}/${userId}`,
      );
    }
  }

  /**
   * Memoizes the current-user lookup for the request. On rejection the cached
   * promise is cleared so a transient failure does not permanently poison the
   * cache — the next call retries.
   */
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

  /**
   * Splits requested page ids into those already known readable (from cache) and
   * those still unknown. Ids known to be unreadable are dropped. `unknown` is
   * de-duplicated so the same page is never queried twice in one pass.
   */
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

  /**
   * Records the readability decision for every queried page id. Must only be
   * called once all dependency queries for these ids have succeeded, so a
   * partial/failed computation never writes results.
   */
  recordPages(
    queriedPageIds: Iterable<string>,
    readablePageIds: Set<string>,
  ): void {
    for (const pageId of queriedPageIds) {
      this.readableByPageId.set(pageId, readablePageIds.has(pageId));
    }
  }

  /**
   * Splits requested space ids into those already known readable and those still
   * unknown (de-duplicated). Ids known to be unreadable are dropped.
   */
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

  /** Records the readability decision for every queried space id. */
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
