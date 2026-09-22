import { createContext, useContext, type ReactNode } from "react";

/**
 * What the shell strikes onto every sheet shown inside it: who is signed in,
 * and within a School, which School and the way around it. `Sheet` reads it,
 * so a screen renders its own sheet and gets the shell without asking for it.
 */
export interface ShellChrome {
  head: ReactNode;
  nav?: ReactNode;
  /**
   * The head as it stands outside any School: who is signed in, and the way
   * out. The one "not available" sheet carries this and nothing more, so it is
   * the same sheet wherever it is shown (ADR-0002).
   */
  account: ReactNode;
}

export const ShellContext = createContext<ShellChrome | null>(null);

/** The shell's chrome for the sheet being rendered, or null outside the shell. */
export function useShell(): ShellChrome | null {
  return useContext(ShellContext);
}
