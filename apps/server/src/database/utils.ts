import { KyselyDB, KyselyTransaction } from './types/kysely.types';

export async function executeTx<T>(
  db: KyselyDB,
  callback: (trx: KyselyTransaction) => Promise<T>,
  existingTrx?: KyselyTransaction,
): Promise<T> {
  if (existingTrx) {
    return await callback(existingTrx);
  } else {
    return await db.transaction().execute((trx) => callback(trx));
  }
}

export function dbOrTx(
  db: KyselyDB,
  existingTrx?: KyselyTransaction,
): KyselyDB | KyselyTransaction {
  if (existingTrx) {
    return existingTrx;
  } else {
    return db;
  }
}
