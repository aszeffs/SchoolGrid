import { useEffect, useState } from "react";
import { href, parse, type Route } from "./routes.ts";

const NAVIGATED = "schoolgrid:navigated";

/** Moves to another page of the app without reloading it. */
export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}): void {
  if (replace) {
    history.replaceState(null, "", href(route));
  } else {
    history.pushState(null, "", href(route));
  }
  dispatchEvent(new Event(NAVIGATED));
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
