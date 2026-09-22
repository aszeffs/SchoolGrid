import { createContext, useContext, type ReactNode } from "react";

/**
 * What the shell strikes onto every sheet shown inside it: who is signed in,
 * and within a School, which School and the way around it. `Sheet` reads it,
 * so a screen renders its own sheet and gets the shell without asking for it.
 */
export interface ShellChrome {
  head: ReactNode;
  nav?: ReactNode;
}

export const ShellContext = createContext<ShellChrome | null>(null);

/** The shell's chrome for the sheet being rendered, or null outside the shell. */
export function useShell(): ShellChrome | null {
  return useContext(ShellContext);
}
