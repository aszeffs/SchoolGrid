import { useEffect, useState } from "react";

const NAVIGATED = "schoolgrid:navigated";

/** Moves to another page of the app without reloading it. */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
  if (replace) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  dispatchEvent(new Event(NAVIGATED));
}

/** The path the app is showing, kept current across navigation and history. */
export function usePath(): string {
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
