import { NotFoundException } from '@nestjs/common';
import { QueueJob } from '../../integrations/queue/constants';
import { HistorySnapshotService } from './history-snapshot.service';

jest.mock('../collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

const liveContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'live' }] }],
};
const staleContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'stale' }] }],
};

const user = { id: 'user-1' } as any;

function createSubject(opts: {
  lastHistory?: any;
  pendingContributors?: string[];
  saveHistoryError?: Error;
  page?: any;
}) {
  const page =
    'page' in opts
      ? opts.page
      : {
          id: 'page-1',
          slugId: 'slug-1',
          title: 'Title',
          content: staleContent,
          spaceId: 'space-1',
          workspaceId: 'workspace-1',
          creatorId: 'creator-1',
          lastUpdatedById: 'user-2',
        };

  const pageHistoryRepo = {
    findPageLastHistory: jest.fn().mockResolvedValue(opts.lastHistory),
    saveHistory: opts.saveHistoryError
      ? jest.fn().mockRejectedValue(opts.saveHistoryError)
      : jest.fn().mockResolvedValue({
          id: 'history-new',
          pageId: 'page-1',
          content: liveContent,
        }),
    createPendingDiff: jest.fn().mockResolvedValue(undefined),
  };
  const pageRepo = { findById: jest.fn().mockResolvedValue(page) };
  const collabHistory = {
    popContributors: jest
      .fn()
      .mockResolvedValue(opts.pendingContributors ?? []),
    addContributors: jest.fn().mockResolvedValue(undefined),
  };
  const watcherService = {
    addPageWatchers: jest.fn().mockResolvedValue(undefined),
  };
  const gateway = {
    getDocumentJson: jest.fn().mockResolvedValue(liveContent),
  };
  const notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const generalQueue = { add: jest.fn().mockResolvedValue(undefined) };
  const historyDiffQueue = { add: jest.fn().mockResolvedValue(undefined) };

  const service = new HistorySnapshotService(
    pageHistoryRepo as any,
    pageRepo as any,
    collabHistory as any,
    watcherService as any,
    gateway as any,
    notificationQueue as any,
    generalQueue as any,
    historyDiffQueue as any,
  );

  return {
    service,
    pageHistoryRepo,
    collabHistory,
    gateway,
    notificationQueue,
    generalQueue,
    historyDiffQueue,
  };
}

describe('HistorySnapshotService.createSnapshot', () => {
  it('returns the last history without saving when nothing changed', async () => {
    const subject = createSubject({
      lastHistory: {
        id: 'history-old',
        title: 'Title',
        content: liveContent,
      },
      pendingContributors: ['user-2'],
    });

    const result = await subject.service.createSnapshot('page-1', user);

    expect(subject.gateway.getDocumentJson).toHaveBeenCalledWith(
      'page.page-1',
      user,
    );
    expect(subject.pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
    expect(subject.collabHistory.popContributors).not.toHaveBeenCalled();
    expect(subject.historyDiffQueue.add).not.toHaveBeenCalled();
    expect(subject.generalQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: 'history-old',
      title: 'Title',
      created: false,
    });
  });

  it('saves a version when only the title changed', async () => {
    const subject = createSubject({
      lastHistory: {
        id: 'history-old',
        title: 'Old title',
        content: liveContent,
      },
    });

    const result = await subject.service.createSnapshot('page-1', user);

    expect(subject.pageHistoryRepo.saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Title', content: liveContent }),
      { contributorIds: ['user-1'] },
    );
    expect(subject.historyDiffQueue.add).toHaveBeenCalledWith(
      QueueJob.PAGE_HISTORY_DIFF,
      expect.objectContaining({
        fromHistoryId: 'history-old',
        toHistoryId: 'history-new',
      }),
      expect.anything(),
    );
    expect(subject.generalQueue.add).not.toHaveBeenCalled();
    expect(subject.notificationQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: 'history-new',
      pageId: 'page-1',
      created: true,
    });
  });

  it('runs backlink and notification jobs when content changed', async () => {
    const subject = createSubject({
      lastHistory: {
        id: 'history-old',
        title: 'Title',
        content: staleContent,
      },
      pendingContributors: ['user-2'],
    });

    await subject.service.createSnapshot('page-1', user);

    expect(subject.pageHistoryRepo.saveHistory).toHaveBeenCalledWith(
      expect.anything(),
      { contributorIds: ['user-2', 'user-1'] },
    );
    expect(subject.generalQueue.add).toHaveBeenCalledWith(
      QueueJob.PAGE_BACKLINKS,
      expect.objectContaining({ pageId: 'page-1' }),
    );
    expect(subject.notificationQueue.add).toHaveBeenCalledWith(
      QueueJob.PAGE_UPDATED,
      expect.objectContaining({ pageId: 'page-1', actorIds: ['user-2'] }),
    );
  });

  it('skips the diff for the first history entry', async () => {
    const subject = createSubject({ lastHistory: undefined });

    await subject.service.createSnapshot('page-1', user);

    expect(subject.pageHistoryRepo.saveHistory).toHaveBeenCalled();
    expect(subject.historyDiffQueue.add).not.toHaveBeenCalled();
    expect(subject.notificationQueue.add).not.toHaveBeenCalled();
  });

  it('restores pending contributors when saving fails', async () => {
    const subject = createSubject({
      lastHistory: {
        id: 'history-old',
        title: 'Title',
        content: staleContent,
      },
      pendingContributors: ['user-2'],
      saveHistoryError: new Error('db down'),
    });

    await expect(
      subject.service.createSnapshot('page-1', user),
    ).rejects.toThrow('db down');
    expect(subject.collabHistory.addContributors).toHaveBeenCalledWith(
      'page-1',
      ['user-2'],
    );
  });

  it('throws when the page no longer exists', async () => {
    const subject = createSubject({ page: undefined });

    await expect(
      subject.service.createSnapshot('page-1', user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(subject.pageHistoryRepo.saveHistory).not.toHaveBeenCalled();
  });
});
