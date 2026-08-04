import { User } from '@akasha/db/types/entity.types';
import {
  KnowledgeAuthorizationCache,
  KnowledgeAuthorizationCacheScopeError,
} from './knowledge-source-authorization.cache';

const SCOPE = { workspaceId: 'workspace-1', userId: 'user-1' };

describe('KnowledgeAuthorizationCache', () => {
  it('accepts matching scope and rejects mismatched scope', () => {
    const cache = new KnowledgeAuthorizationCache(SCOPE);

    expect(() => cache.assertScope('workspace-1', 'user-1')).not.toThrow();
    expect(() => cache.assertScope('workspace-2', 'user-1')).toThrow(
      KnowledgeAuthorizationCacheScopeError,
    );
    expect(() => cache.assertScope('workspace-1', 'user-2')).toThrow(
      KnowledgeAuthorizationCacheScopeError,
    );
  });

  it('memoizes the user load and only calls the loader once', async () => {
    const cache = new KnowledgeAuthorizationCache(SCOPE);
    const loader = jest.fn().mockResolvedValue({ id: 'user-1' } as User);

    const [first, second] = await Promise.all([
      cache.getUser(loader),
      cache.getUser(loader),
    ]);

    expect(first).toEqual({ id: 'user-1' });
    expect(second).toEqual({ id: 'user-1' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('clears the memoized user on rejection so the next call retries', async () => {
    const cache = new KnowledgeAuthorizationCache(SCOPE);
    const loader = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ id: 'user-1' } as User);

    await expect(cache.getUser(loader)).rejects.toThrow('db down');
    // Retry must actually re-invoke the loader (no poisoned rejected promise).
    await expect(cache.getUser(loader)).resolves.toEqual({ id: 'user-1' });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('partitions pages into known-readable and de-duplicated unknown', () => {
    const cache = new KnowledgeAuthorizationCache(SCOPE);
    cache.recordPages(['a', 'b', 'c'], new Set(['a']));

    const { knownReadable, unknown } = cache.partitionPages([
      'a', // known readable
      'b', // known NOT readable -> dropped
      'c', // known NOT readable -> dropped
      'd', // unknown
      'd', // duplicate unknown -> collapsed
    ]);

    expect([...knownReadable]).toEqual(['a']);
    expect(unknown).toEqual(['d']);
  });

  it('partitions spaces the same way', () => {
    const cache = new KnowledgeAuthorizationCache(SCOPE);
    cache.recordSpaces(['s1', 's2'], new Set(['s1']));

    const { knownReadable, unknown } = cache.partitionSpaces([
      's1',
      's2',
      's3',
      's3',
    ]);

    expect([...knownReadable]).toEqual(['s1']);
    expect(unknown).toEqual(['s3']);
  });
});
