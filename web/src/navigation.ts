import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { href, parse, type Route } from "./routes.ts";

const NAVIGATED = "schoolgrid:navigated";

/**
 * Moves to another page of the app without reloading it.
 *
 * Where the browser has view transitions and the user has not asked for less
 * motion, the move is one: the page is swapped in place and only the seal on
 * the current section slides to its new tab (styles.css). The new page is
 * rendered synchronously inside the transition, so the transition captures it.
 */
export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}): void {
  if (replace) {
    history.replaceState(null, "", href(route));
  } else {
    history.pushState(null, "", href(route));
  }
  const announce = () => dispatchEvent(new Event(NAVIGATED));
  if (typeof document.startViewTransition === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(() => flushSync(announce));
  } else {
    announce();
  }
}

/** The path the app is showing, kept current across navigation and history. */
function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener(NAVIGATED, update);
    addEventListener("popstate", update);
    return () => {
      removeEventListener(NAVIGATED, update);
      removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

/** The route the app is showing, or null when its path names none. */
export function useRoute(): Route | null {
  return parse(usePath());
}
