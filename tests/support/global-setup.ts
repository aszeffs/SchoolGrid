import { startEmbeddedPostgres, type PostgresHandle } from "./embedded-postgres.ts";

declare module "vitest" {
  export interface ProvidedContext {
    postgres: PostgresHandle;
  }
}

// Typed structurally rather than against a Vitest export, so a rename in
// Vitest's node types cannot break the build for something this file only
// needs one method from.
interface GlobalSetup {
  provide(key: "postgres", value: PostgresHandle): void;
}

export default async function setup({ provide }: GlobalSetup): Promise<() => Promise<void>> {
  const { handle, stop } = await startEmbeddedPostgres();
  provide("postgres", handle);
  return stop;
}
