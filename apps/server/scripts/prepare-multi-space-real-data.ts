import { NestFactory } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { KyselyDB } from '../src/database/types/kysely.types';
import { PageRepo } from '../src/database/repos/page/page.repo';
import { SpaceRepo } from '../src/database/repos/space/space.repo';
import { UserRepo } from '../src/database/repos/user/user.repo';
import { PageService } from '../src/core/page/services/page.service';
import { SpaceService } from '../src/core/space/services/space.service';
import { EventName } from '../src/common/events/event.contants';
import { loadRuntimeConfiguration } from '../src/integrations/environment/consul-config.loader';

const SOURCE_SPACE_NAME = 'AIM-运维-公共文档';
const TARGET_COUNT = 10;
const TARGET_PREFIX = '多空间编译';
const TARGET_SLUG_PREFIX = 'multispacecompile';

type SourceBranch = {
  id: string;
  title: string;
  position: string;
  pageCount: number;
};

type TargetPlan = {
  index: number;
  name: string;
  slug: string;
  pageCount: number;
  branches: SourceBranch[];
};

async function main(): Promise<void> {
  await loadRuntimeConfiguration();
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: ['error', 'warn'] },
  );
  await app.init();

  try {
    const db = app.get<KyselyDB>(KYSELY_MODULE_CONNECTION_TOKEN());
    const pageRepo = app.get(PageRepo);
    const spaceRepo = app.get(SpaceRepo);
    const userRepo = app.get(UserRepo);
    const pageService = app.get(PageService);
    const spaceService = app.get(SpaceService);

    const sourceSpaces = await db
      .selectFrom('spaces')
      .selectAll()
      .where('name', '=', SOURCE_SPACE_NAME)
      .where('deletedAt', 'is', null)
      .execute();
    if (sourceSpaces.length !== 1) {
      throw new Error(
        `Expected exactly one active source Space named ${SOURCE_SPACE_NAME}; found ${sourceSpaces.length}.`,
      );
    }
    const sourceSpace = sourceSpaces[0];
    const sourcePages = await db
      .selectFrom('pages')
      .select(['id', 'title', 'position', 'parentPageId'])
      .where('spaceId', '=', sourceSpace.id)
      .where('deletedAt', 'is', null)
      .execute();
    const homePages = sourcePages.filter((page) => page.parentPageId === null);
    if (homePages.length !== 1) {
      throw new Error(
        `Expected exactly one active source Home; found ${homePages.length}.`,
      );
    }

    const pageCountByParent = new Map<string, string[]>();
    for (const page of sourcePages) {
      if (!page.parentPageId) continue;
      pageCountByParent.set(page.parentPageId, [
        ...(pageCountByParent.get(page.parentPageId) ?? []),
        page.id,
      ]);
    }
    const countSubtree = (pageId: string): number =>
      1 +
      (pageCountByParent.get(pageId) ?? []).reduce(
        (total, childId) => total + countSubtree(childId),
        0,
      );
    const home = homePages[0];
    const branches = sourcePages
      .filter((page) => page.parentPageId === home.id)
      .map(
        (page): SourceBranch => ({
          id: page.id,
          title: page.title,
          position: page.position,
          pageCount: countSubtree(page.id),
        }),
      );
    const plans = distribute(branches);
    const summary = {
      mode: process.argv.includes('--apply') ? 'apply' : 'dry-run',
      sourceSpace: {
        id: sourceSpace.id,
        name: sourceSpace.name,
        pageCount: sourcePages.length,
        firstLevelBranchCount: branches.length,
      },
      targets: plans.map(toPrintablePlan),
      copiedPageCount: plans.reduce((total, plan) => total + plan.pageCount, 0),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!process.argv.includes('--apply')) return;

    const targetNames = plans.map((plan) => plan.name);
    const targetSlugs = plans.map((plan) => plan.slug);
    const conflicts = await db
      .selectFrom('spaces')
      .select(['id', 'name', 'slug', 'deletedAt'])
      .where('workspaceId', '=', sourceSpace.workspaceId)
      .where((expression) =>
        expression.or([
          expression('name', 'in', targetNames),
          expression('slug', 'in', targetSlugs),
        ]),
      )
      .execute();
    if (conflicts.length > 0) {
      throw new Error(
        `Refusing to modify existing target Spaces: ${conflicts
          .map((space) => `${space.name}/${space.slug}/${space.id}`)
          .join(', ')}`,
      );
    }

    const actor = await userRepo.findById(
      sourceSpace.creatorId,
      sourceSpace.workspaceId,
    );
    if (!actor) throw new Error('Source Space creator is unavailable.');

    // The copied data is staged before the explicit ten-Space compile request.
    // PageService still performs all durable copy work, while local in-process
    // PAGE_CREATED listeners are disabled so they cannot enqueue early Runs.
    const eventEmitter = app.get(EventEmitter2);
    const removedPageCreatedListeners = eventEmitter.listenerCount(
      EventName.PAGE_CREATED,
    );
    eventEmitter.removeAllListeners(EventName.PAGE_CREATED);

    const createdTargets = [];
    for (const plan of plans) {
      const target = await spaceService.createSpace(
        actor,
        sourceSpace.workspaceId,
        {
          name: plan.name,
          slug: plan.slug,
          description: `本地多空间编译演练；源空间：${SOURCE_SPACE_NAME}`,
        },
      );
      createdTargets.push({ plan, target });
    }

    for (const { plan, target } of createdTargets) {
      for (const branch of plan.branches) {
        const rootPage = await pageRepo.findById(branch.id);
        if (!rootPage) {
          throw new Error(`Source branch disappeared: ${branch.id}.`);
        }
        const copied = await pageService.duplicatePage(
          rootPage,
          target.id,
          actor,
        );
        const copiedCount = 1 + copied.childPageIds.length;
        if (copiedCount !== branch.pageCount) {
          throw new Error(
            `Copied ${copiedCount} pages for ${branch.title}; expected ${branch.pageCount}.`,
          );
        }
      }
    }

    const actualCounts = await db
      .selectFrom('spaces as space')
      .leftJoin('pages as page', (join) =>
        join
          .onRef('page.spaceId', '=', 'space.id')
          .on('page.deletedAt', 'is', null),
      )
      .select(['space.id', 'space.name', 'space.slug'])
      .select(({ fn }) => fn.count('page.id').as('pageCount'))
      .where(
        'space.id',
        'in',
        createdTargets.map(({ target }) => target.id),
      )
      .groupBy(['space.id', 'space.name', 'space.slug'])
      .orderBy('space.slug', 'asc')
      .execute();
    for (const row of actualCounts) {
      const plan = plans.find((item) => item.name === row.name)!;
      if (Number(row.pageCount) !== plan.pageCount) {
        throw new Error(
          `${row.name} contains ${row.pageCount} pages; expected ${plan.pageCount}.`,
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          created: true,
          removedPageCreatedListeners,
          targets: actualCounts.map((row) => ({
            id: row.id,
            name: row.name,
            slug: row.slug,
            pageCount: Number(row.pageCount),
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

function distribute(branches: SourceBranch[]): TargetPlan[] {
  const targets = Array.from({ length: TARGET_COUNT }, (_, index) => ({
    index,
    name: `${TARGET_PREFIX}${index}`,
    slug: `${TARGET_SLUG_PREFIX}${index}`,
    pageCount: 0,
    branches: [] as SourceBranch[],
  }));
  const sortedBranches = [...branches].sort(
    (left, right) =>
      right.pageCount - left.pageCount ||
      left.position.localeCompare(right.position) ||
      left.id.localeCompare(right.id),
  );
  for (const branch of sortedBranches) {
    const target = [...targets].sort(
      (left, right) =>
        left.pageCount - right.pageCount || left.index - right.index,
    )[0];
    target.branches.push(branch);
    target.pageCount += branch.pageCount;
  }
  return targets;
}

function toPrintablePlan(plan: TargetPlan) {
  return {
    name: plan.name,
    slug: plan.slug,
    pageCount: plan.pageCount,
    branches: plan.branches.map((branch) => ({
      id: branch.id,
      title: branch.title,
      pageCount: branch.pageCount,
    })),
  };
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
