import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';
import {
  InsertableKnowledgeSourceAccessPrincipal,
  InsertableKnowledgeSourceAccessRequirement,
  InsertableKnowledgeSourceAccessPolicy,
  KnowledgeSourceAccessPrincipal,
  KnowledgeSourceAccessPolicy,
  KnowledgeSourceAccessRequirement,
} from '@akasha/db/types/entity.types';

type UpsertPolicyInput = Pick<
  InsertableKnowledgeSourceAccessPolicy,
  | 'workspaceId'
  | 'sourcePageId'
  | 'sourceSpaceId'
  | 'policyHash'
  | 'restrictedAncestorCount'
>;

type ReplacePolicySnapshotInput = UpsertPolicyInput & {
  requirements: Array<{
    requirementId: string;
    restrictedPageId: string;
    depth: number;
    principals: Array<{
      principalType: string;
      principalId: string;
      role: string;
    }>;
  }>;
};

export type KnowledgeAccessPrincipalInput = {
  principalType: 'user' | 'group';
  principalId: string;
};

export type KnowledgeSidecarEligibilityStatus =
  | 'eligible'
  | 'missing_policy'
  | 'stale_policy'
  | 'denied_by_restricted_ancestor'
  | 'empty_restricted_ancestor';

export type KnowledgeSidecarSourceEligibility = {
  sourcePageId: string;
  sourceSpaceId: string | null;
  status: KnowledgeSidecarEligibilityStatus;
  policyHash?: string | null;
  staleAt?: Date | null;
  updatedAt?: Date | null;
};

@Injectable()
export class KnowledgeAccessPolicyRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async upsertPolicy(
    input: UpsertPolicyInput,
    trx?: KyselyTransaction,
  ): Promise<KnowledgeSourceAccessPolicy> {
    return dbOrTx(this.db, trx)
      .insertInto('knowledgeSourceAccessPolicy')
      .values({ ...input, staleAt: null })
      .onConflict((oc) =>
        oc.columns(['workspaceId', 'sourcePageId']).doUpdateSet({
          sourceSpaceId: input.sourceSpaceId,
          policyHash: input.policyHash,
          restrictedAncestorCount: input.restrictedAncestorCount,
          staleAt: null,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findPoliciesForSources(
    input: { workspaceId: string; sourcePageIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeSourceAccessPolicy[]> {
    if (input.sourcePageIds.length === 0) return [];

    return dbOrTx(this.db, trx)
      .selectFrom('knowledgeSourceAccessPolicy')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', 'in', input.sourcePageIds)
      .execute();
  }

  async evaluateSourceEligibilityForPrincipals(
    input: {
      workspaceId: string;
      sourcePageIds: string[];
      principals: KnowledgeAccessPrincipalInput[];
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeSidecarSourceEligibility[]> {
    if (input.sourcePageIds.length === 0) return [];

    const db = dbOrTx(this.db, trx);
    const [policies, requirements, principals] = await Promise.all([
      this.findPoliciesForSources(
        {
          workspaceId: input.workspaceId,
          sourcePageIds: input.sourcePageIds,
        },
        trx,
      ),
      db
        .selectFrom('knowledgeSourceAccessRequirements')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('sourcePageId', 'in', input.sourcePageIds)
        .execute(),
      db
        .selectFrom('knowledgeSourceAccessPrincipals')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('sourcePageId', 'in', input.sourcePageIds)
        .execute(),
    ]);

    return evaluateEligibility({
      sourcePageIds: input.sourcePageIds,
      policies,
      requirements,
      principals,
      requestedPrincipals: input.principals,
    });
  }

  async markScopeStale(
    input: { workspaceId: string; spaceId: string },
    trx?: KyselyTransaction,
  ): Promise<void> {
    await dbOrTx(this.db, trx)
      .updateTable('knowledgeSourceAccessPolicy')
      .set({ staleAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('sourceSpaceId', '=', input.spaceId)
      .execute();
  }

  async replacePolicySnapshot(
    input: ReplacePolicySnapshotInput,
    trx?: KyselyTransaction,
  ): Promise<KnowledgeSourceAccessPolicy> {
    const db = dbOrTx(this.db, trx);

    await db
      .deleteFrom('knowledgeSourceAccessPrincipals')
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .execute();

    await db
      .deleteFrom('knowledgeSourceAccessRequirements')
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', '=', input.sourcePageId)
      .execute();

    const policy = await this.upsertPolicy(
      {
        workspaceId: input.workspaceId,
        sourcePageId: input.sourcePageId,
        sourceSpaceId: input.sourceSpaceId,
        policyHash: input.policyHash,
        restrictedAncestorCount: input.restrictedAncestorCount,
      },
      trx,
    );

    const requirementRows: InsertableKnowledgeSourceAccessRequirement[] =
      input.requirements.map((requirement) => ({
        workspaceId: input.workspaceId,
        sourcePageId: input.sourcePageId,
        requirementId: requirement.requirementId,
        restrictedPageId: requirement.restrictedPageId,
        depth: requirement.depth,
      }));

    if (requirementRows.length > 0) {
      await db
        .insertInto('knowledgeSourceAccessRequirements')
        .values(requirementRows)
        .execute();
    }

    const principalRows: InsertableKnowledgeSourceAccessPrincipal[] =
      input.requirements.flatMap((requirement) =>
        requirement.principals.map((principal) => ({
          workspaceId: input.workspaceId,
          sourcePageId: input.sourcePageId,
          requirementId: requirement.requirementId,
          principalType: principal.principalType,
          principalId: principal.principalId,
          role: principal.role,
        })),
      );

    if (principalRows.length > 0) {
      await db
        .insertInto('knowledgeSourceAccessPrincipals')
        .values(principalRows)
        .execute();
    }

    return policy;
  }
}

function evaluateEligibility(input: {
  sourcePageIds: string[];
  policies: KnowledgeSourceAccessPolicy[];
  requirements: KnowledgeSourceAccessRequirement[];
  principals: KnowledgeSourceAccessPrincipal[];
  requestedPrincipals: KnowledgeAccessPrincipalInput[];
}): KnowledgeSidecarSourceEligibility[] {
  const policiesBySource = new Map(
    input.policies.map((policy) => [policy.sourcePageId, policy]),
  );
  const requirementsBySource = groupBy(
    input.requirements,
    (requirement) => requirement.sourcePageId,
  );
  const principalsByRequirement = groupBy(
    input.principals,
    (principal) => `${principal.sourcePageId}:${principal.requirementId}`,
  );
  const requestedPrincipalKeys = new Set(
    input.requestedPrincipals.map(
      (principal) => `${principal.principalType}:${principal.principalId}`,
    ),
  );

  return input.sourcePageIds.map((sourcePageId) => {
    const policy = policiesBySource.get(sourcePageId);
    if (!policy) {
      return {
        sourcePageId,
        sourceSpaceId: null,
        status: 'missing_policy',
      };
    }

    const base = {
      sourcePageId,
      sourceSpaceId: policy.sourceSpaceId,
      policyHash: policy.policyHash,
      staleAt: policy.staleAt,
      updatedAt: policy.updatedAt,
    };

    if (policy.staleAt) {
      return { ...base, status: 'stale_policy' as const };
    }

    if (policy.restrictedAncestorCount === 0) {
      return { ...base, status: 'eligible' as const };
    }

    const requirements = requirementsBySource.get(sourcePageId) ?? [];
    if (requirements.length === 0) {
      return { ...base, status: 'empty_restricted_ancestor' as const };
    }

    for (const requirement of requirements) {
      const allowedPrincipals =
        principalsByRequirement.get(
          `${sourcePageId}:${requirement.requirementId}`,
        ) ?? [];

      if (allowedPrincipals.length === 0) {
        return { ...base, status: 'empty_restricted_ancestor' as const };
      }

      const hasMatchingPrincipal = allowedPrincipals.some((principal) =>
        requestedPrincipalKeys.has(
          `${principal.principalType}:${principal.principalId}`,
        ),
      );
      if (!hasMatchingPrincipal) {
        return {
          ...base,
          status: 'denied_by_restricted_ancestor' as const,
        };
      }
    }

    return { ...base, status: 'eligible' as const };
  });
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}
