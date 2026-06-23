import { StructuredWiki, WikiDocument, WikiFolder } from './structured-wiki';

export interface WikiSource {
  load(): Promise<StructuredWiki>;
  getDocument(id: string): Promise<WikiDocument | null>;
  listFolders(): Promise<WikiFolder[]>;
}
