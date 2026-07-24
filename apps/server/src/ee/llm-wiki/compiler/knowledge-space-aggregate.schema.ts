import { z } from 'zod';

export const knowledgeSpaceAggregateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    markdown: z.string().trim().min(1),
  })
  .strict();

export type KnowledgeSpaceAggregate = z.infer<
  typeof knowledgeSpaceAggregateSchema
>;
