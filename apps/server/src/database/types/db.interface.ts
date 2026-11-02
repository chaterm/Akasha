import { DB } from '@akasha/db/types/db';
import { PageEmbeddings } from '@akasha/db/types/embeddings.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
}
