import { KyselyTransaction } from '@akasha/db/types/kysely.types';
import { PAGE_ATTEMPT_BUDGET } from './knowledge-compilation-budgets';

export async function readRunPipelineWork(
  trx: KyselyTransaction,
  runId: string,
) {
  const run = await trx
    .selectFrom('knowledgeSpaceCompileRuns')
    .select([
      'id',
      'phase',
      'status',
      'expectedPageCount',
      'succeededPageCount',
      'failedPageCount',
      'skippedPageCount',
    ])
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!run) return undefined;
  const text = await trx
    .selectFrom('knowledgeSpaceCompileRunPages')
    .select('id')
    .where('runId', '=', runId)
    .where((eb) =>
      eb.or([
        eb('status', 'in', ['pending', 'queued', 'running']),
        eb.and([
          eb('status', '=', 'failed'),
          eb('attemptCount', '<', PAGE_ATTEMPT_BUDGET),
        ]),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  const image = await trx
    .selectFrom('knowledgeSpaceCompileRunImages')
    .select('id')
    .where('runId', '=', runId)
    .where('status', 'in', ['pending', 'queued', 'processing'])
    .limit(1)
    .executeTakeFirst();
  const pageImage = await trx
    .selectFrom('knowledgeSpaceCompileRunPages')
    .select('id')
    .where('runId', '=', runId)
    .where('imageStatus', 'in', ['pending', 'queued', 'processing'])
    .limit(1)
    .executeTakeFirst();
  const merge = await trx
    .selectFrom('knowledgeSpaceCompileRunPages')
    .select('id')
    .where('runId', '=', runId)
    .where('mergeStatus', 'in', [
      'waiting_images',
      'pending',
      'queued',
      'running',
    ])
    .limit(1)
    .executeTakeFirst();
  return {
    run,
    textOutstanding:
      Boolean(text) ||
      run.succeededPageCount + run.failedPageCount + run.skippedPageCount <
        run.expectedPageCount,
    imageOutstanding: Boolean(image || pageImage),
    mergeOutstanding: Boolean(merge),
  };
}

export async function reconcileRunPipelineInTransaction(
  trx: KyselyTransaction,
  runId: string,
  options: { textBarrierSettled?: boolean } = {},
) {
  const current = await trx
    .selectFrom('knowledgeSpaceCompileRuns')
    .select(['phase', 'status'])
    .where('id', '=', runId)
    .executeTakeFirst();
  if (
    !current ||
    !['queued', 'compiling'].includes(current.status) ||
    !['text', 'images', 'image_merge'].includes(current.phase) ||
    (current.phase === 'text' && !options.textBarrierSettled)
  )
    return undefined;
  const work = await readRunPipelineWork(trx, runId);
  if (!work || !['queued', 'compiling'].includes(work.run.status))
    return undefined;
  if (!['text', 'images', 'image_merge'].includes(work.run.phase))
    return undefined;
  if (work.run.phase === 'text' && !options.textBarrierSettled)
    return undefined;
  if (work.textOutstanding) return undefined;
  const phase = work.imageOutstanding
    ? 'images'
    : work.mergeOutstanding
      ? 'image_merge'
      : 'finalizing';
  const now = new Date();
  const updated = await trx
    .updateTable('knowledgeSpaceCompileRuns')
    .set({
      phase,
      status: phase === 'finalizing' ? 'queued' : 'compiling',
      spaceJobId: null,
      spaceJobDispatchedAt: null,
      spaceJobQueuedAt: phase === 'finalizing' ? now : null,
      executionToken: null,
      executionLeaseExpiresAt: null,
      workerId: null,
      heartbeatAt: null,
      updatedAt: now,
    })
    .where('id', '=', runId)
    .where('phase', '=', work.run.phase)
    .where('status', '=', work.run.status)
    .returning('id')
    .executeTakeFirst();
  return updated
    ? {
        phase,
        imagesRequired: work.imageOutstanding,
        mergeRequired: work.mergeOutstanding,
        readyToFinalize: phase === 'finalizing',
      }
    : undefined;
}
