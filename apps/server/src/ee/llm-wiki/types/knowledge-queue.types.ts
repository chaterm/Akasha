export type KnowledgeCompileTrigger =
  | 'manual_compile'
  | 'retry_compile'
  | 'rebuild_embeddings'
  | 'page_update';

export type KnowledgeCompileJobResult = {
  type: 'compile-space' | 'compile-pages';
  status: 'queued' | 'succeeded';
  workspaceId: string;
  spaceId: string;
  compilerRunId: string;
  sourceCount: number;
  importedArtifactCount: number;
  quarantinedArtifactCount: number;
  durationMs: number;
};

export type KnowledgeAdminSpaceAction =
  | 'retry_compile'
  | 'reindex_access'
  | 'mark_stale'
  | 'rebuild_embeddings';
