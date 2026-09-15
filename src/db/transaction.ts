import type pg from "pg";
import type { Database } from "./pool.ts";

/** Anything a query can be sent through: the pool, or a client inside a transaction. */
export type Queryable = Pick<pg.PoolClient, "query">;

/** When this transaction is taking place, by the database's clock. */
export async function transactionTime(transaction: Queryable): Promise<Date> {
  const { rows } = await transaction.query<{ now: Date }>("SELECT now()");
  return rows[0]!.now;
}

/** Runs `work` in one transaction, committing only if it resolves. */
export async function withTransaction<T>(
  database: Database,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
