import pg from "pg";

export type Database = pg.Pool;

export function createPool(connectionString: string): Database {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}
