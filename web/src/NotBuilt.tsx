import { Sheet } from "./Sheet.tsx";

/**
 * A page the navigation already lists whose screen is still to be built. It
 * says so plainly rather than looking broken, and asks the API for nothing, so
 * it can show nothing the actor may not read.
 */
export function NotBuilt({ name, note }: { name: string; note?: string }) {
  return (
    <Sheet stock="canary" name={name}>
      <h1>{name}</h1>
      <p>This screen is not built yet.</p>
      {note !== undefined && <p className="muted">{note}</p>}
    </Sheet>
  );
}
