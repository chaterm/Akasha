import { z } from 'zod';

export const sourceRefSchema = z.object({
  origin: z.string(),
  locator: z.string().optional(),
  quote: z.string().optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const claimSchema = z.object({
  id: z.string(),
  statement: z.string(),
  sources: z.array(sourceRefSchema).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type Claim = z.infer<typeof claimSchema>;

export const outLinkSchema = z.object({
  targetDocId: z.string(),
  type: z
    .enum(['related', 'elaborates', 'contradicts', 'supports'])
    .default('related'),
  reason: z.string().optional(),
});
export type OutLink = z.infer<typeof outLinkSchema>;

export const docStatusSchema = z.enum([
  'draft',
  'reviewed',
  'merged',
  'archived',
]);
export type DocStatus = z.infer<typeof docStatusSchema>;

export const wikiFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable().default(null),
});
export type WikiFolder = z.infer<typeof wikiFolderSchema>;

export const wikiDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  folderId: z.string().nullable().default(null),
  body: z.string(),
  claims: z.array(claimSchema).default([]),
  links: z.array(outLinkSchema).default([]),
  tags: z.array(z.string()).default([]),
  status: docStatusSchema.default('draft'),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type WikiDocument = z.infer<typeof wikiDocumentSchema>;

export const structuredWikiSchema = z.object({
  version: z.literal('1').default('1'),
  folders: z.array(wikiFolderSchema).default([]),
  documents: z.array(wikiDocumentSchema).default([]),
});
export type StructuredWiki = z.infer<typeof structuredWikiSchema>;

export function parseStructuredWiki(input: unknown): StructuredWiki {
  return structuredWikiSchema.parse(input);
}
