import type { MouseEvent, ReactNode } from "react";
import { navigate } from "./navigation.ts";
import { href, type Route } from "./routes.ts";

/**
 * A link to one of the app's own pages, followed without reloading the app.
 * A click that asks for a new tab or window is left to the browser, which
 * opens the same route there by its URL.
 */
export function Link({
  to,
  current = false,
  className,
  children,
}: {
  to: Route;
  /** Marks the link as the page being shown. */
  current?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={href(to)} onClick={follow} className={className} aria-current={current ? "page" : undefined}>
      {children}
    </a>
  );
}
