import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import { API_PREFIX } from "./api.ts";
import { IMMUTABLE, type CacheControl } from "./security-headers.ts";

/**
 * The built web app, held in memory. It is read once at startup, so serving it
 * never touches the filesystem: no request path is ever joined onto a directory,
 * and no file added after startup, or outside the build, can be served.
 */
export interface WebApp {
  /** The page every navigation outside `/api` is answered with. */
  index: Asset;
  /** Every servable file, by the exact path it is requested at. */
  assets: ReadonlyMap<string, Asset>;
}

interface Asset {
  body: Buffer;
  contentType: string;
  /** How long a browser may keep it, decided once as the build is read. */
  cacheControl: CacheControl;
}

/**
 * What a Vite build emits. A file of any other type is left unserved rather
 * than guessed at: sent as the wrong type, `nosniff` would make a browser
 * refuse it anyway.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const INDEX = "/index.html";

/**
 * Where the build puts the files it fingerprints: Vite names each one after a
 * hash of its contents. Everything else in the build, such as `index.html` and
 * a file copied from `public/`, keeps its name from one deploy to the next.
 */
const FINGERPRINTED = "/assets/";

/** Reads a build from `directory`. Fails if it holds no `index.html`. */
export async function loadWebApp(directory: URL): Promise<WebApp> {
  const root = fileURLToPath(directory);
  const assets = new Map<string, Asset>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const contentType = CONTENT_TYPES[path.extname(entry.name)];
    if (!entry.isFile() || contentType === undefined) {
      continue;
    }
    const file = path.join(entry.parentPath, entry.name);
    const requestPath = `/${path.relative(root, file).split(path.sep).join("/")}`;
    const cacheControl = requestPath.startsWith(FINGERPRINTED) ? IMMUTABLE : "no-cache";
    assets.set(requestPath, { body: await readFile(file), contentType, cacheControl });
  }
  const index = assets.get(INDEX);
  if (index === undefined) {
    throw new Error(`The web app at ${root} has no index.html`);
  }
  return { index, assets };
}

/**
 * The file the web app answers a request with, or null if it does not answer
 * it and the request is the caller's to refuse.
 *
 * A navigation outside `/api` gets `index.html` whatever its path, and the app
 * decides what the path shows. That answer depends only on the request, never
 * on which records, Schools or pages exist, so it cannot confirm that anything
 * does (ADR-0002). Only a static asset depends on what exists, and the build is
 * public. Under `/api` nothing is ever answered here, so every refusal there
 * stays exactly as it was.
 *
 * A request a route matched is never the web app's, and neither is one whose
 * decoded path is under `/api`: the router decodes a path before matching it,
 * so `/%61pi/health` reaches `/api/health`. Judged on the raw path, it would be
 * exempt from the rate limit, and an unmatched one would get the app where a
 * matched one gets its route, telling the two apart.
 */
export function webAppFileFor(webApp: WebApp, request: FastifyRequest): Asset | null {
  const requestPath = decodedPath(request);
  if (
    request.routeOptions.url !== undefined ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    requestPath === null ||
    isUnderApi(requestPath)
  ) {
    return null;
  }
  if (acceptsHtml(request)) {
    return webApp.index;
  }
  return webApp.assets.get(requestPath) ?? null;
}

/**
 * The `cache-control` a response to the request carries, whatever answers it.
 *
 * Under `/api`, judged on the decoded path as `webAppFileFor` judges it, it is
 * always `no-store`. So it is for a path that does not decode: only ever
 * refused, it cannot be placed on either side. Outside `/api`, a file the web
 * app answers with carries its own, and anything else, a refusal included,
 * carries `no-cache` like the app's page. A refusal's therefore depends on its
 * path alone, never on which files exist (ADR-0002). Only a file served with
 * a 200, which the public build already tells apart, carries anything else.
 */
export function cacheControlFor(webApp: WebApp | undefined, request: FastifyRequest): CacheControl {
  const requestPath = decodedPath(request);
  if (requestPath === null || isUnderApi(requestPath)) {
    return "no-store";
  }
  return (webApp === undefined ? null : webAppFileFor(webApp, request))?.cacheControl ?? "no-cache";
}

/** Whether a decoded path is under `/api`. */
function isUnderApi(requestPath: string): boolean {
  return requestPath === API_PREFIX || requestPath.startsWith(`${API_PREFIX}/`);
}

/**
 * Answers a request no route matched with the web app, if it is one the web
 * app answers (see `webAppFileFor`), and otherwise returns null for the caller
 * to refuse.
 */
export function serveWebApp(
  webApp: WebApp,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | null {
  const file = webAppFileFor(webApp, request);
  if (file === null) {
    return null;
  }
  return reply.status(200).header("content-type", file.contentType).send(file.body);
}

/** The request's path with every escape decoded, or null if it does not decode. */
function decodedPath(request: FastifyRequest): string | null {
  try {
    return decodeURIComponent(request.url.split("?")[0]!);
  } catch {
    return null;
  }
}

/**
 * Whether the request names HTML among the types it accepts, as a browser
 * navigating to a page does. A wildcard does not count: a script, stylesheet
 * or image request sends one, and must get the asset or a refusal.
 */
function acceptsHtml(request: FastifyRequest): boolean {
  return (request.headers.accept ?? "")
    .split(",")
    .some((range) => range.split(";")[0]!.trim().toLowerCase() === "text/html");
}
