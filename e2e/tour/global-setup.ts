import { startShowcase } from "./stack.ts";

/** Boots the showcase the tour is shot in, and returns what stops it. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const showcase = await startShowcase({ port: Number(process.env["TOUR_PORT"] ?? 3100) });
  return () => showcase.close();
}
