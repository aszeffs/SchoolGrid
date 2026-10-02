import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TrialProvider } from "../../src/config.ts";

/**
 * A stand-in for GitHub's and Google's OAuth, for the tests alone: the
 * authorization code flow with PKCE, speaking just enough of both that
 * SchoolGrid signs a Trial visitor in through it exactly as through either
 * (ADR-0013). The app has no test-only branch: a test points a provider's
 * endpoints here.
 *
 * Its authorize step is a page, as a provider's consent screen is, with the
 * subject to sign in as, a fresh one unless changed, and Approve and Cancel.
 * It checks the PKCE verifier, the client and the redirect, so a flow that
 * gets them wrong fails here as it would at the real provider.
 */
export interface FakeOAuthProvider {
  /** Where it listens, as `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string;
  close(): Promise<void>;
}

export interface FakeOAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Defaults to loopback only. */
  host?: string;
  /** Defaults to any free port. */
  port?: number;
}

/**
 * Where each provider names who signed in, and in which field: GitHub's `id`
 * at its user endpoint, Google's `sub` at its userinfo endpoint.
 */
export const USER_ENDPOINTS: Record<TrialProvider, { path: string; field: string }> = {
  github: { path: "/user", field: "id" },
  google: { path: "/userinfo", field: "sub" },
};

interface Grant {
  subject: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
}

export async function startFakeOAuthProvider({
  clientId,
  clientSecret,
  host = "127.0.0.1",
  port = 0,
}: FakeOAuthProviderOptions): Promise<FakeOAuthProvider> {
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, string>();

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => send(response, 500, { error: "server_error" }));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake");
    if (url.pathname === "/authorize" && request.method === "GET") {
      return consentPage(response, url.searchParams);
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      return decide(response, await formOf(request));
    }
    if (url.pathname === "/token" && request.method === "POST") {
      return exchange(request, response, await formOf(request));
    }
    // Each field is answered only where its provider answers it, so a
    // provider read through the other's field finds no subject.
    const field =
      request.method === "GET" ? Object.values(USER_ENDPOINTS).find(({ path }) => path === url.pathname)?.field : undefined;
    if (field !== undefined) {
      const token = /^Bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1];
      const subject = token === undefined ? undefined : tokens.get(token);
      return subject === undefined ? send(response, 401, { error: "invalid_token" }) : send(response, 200, { [field]: subject });
    }
    send(response, 404, { error: "not_found" });
  }

  function consentPage(response: ServerResponse, query: URLSearchParams): void {
    const missing = ["client_id", "redirect_uri", "state", "code_challenge"].find((name) => !query.get(name));
    if (
      missing !== undefined ||
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256" ||
      query.get("client_id") !== clientId
    ) {
      return send(response, 400, { error: "invalid_request" });
    }
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge"]
      .map((name) => `<input type="hidden" name="${name}" value="${escape(query.get(name)!)}">`)
      .join("");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fake provider</title></head>
<body><main><h1>Sign in to SchoolGrid</h1>
<form method="post" action="/authorize">${hidden}
<label>Subject <input name="subject" value="${randomUUID()}"></label>
<button name="decision" value="approve">Approve</button>
<button name="decision" value="cancel">Cancel</button>
</form></main></body></html>`);
  }

  function decide(response: ServerResponse, form: URLSearchParams): void {
    const redirectUri = form.get("redirect_uri");
    const state = form.get("state") ?? "";
    if (redirectUri === null) {
      return send(response, 400, { error: "invalid_request" });
    }
    const back = new URL(redirectUri);
    if (form.get("decision") !== "approve") {
      back.searchParams.set("error", "access_denied");
    } else {
      const code = randomBytes(16).toString("base64url");
      grants.set(code, {
        subject: form.get("subject") || randomUUID(),
        clientId: form.get("client_id") ?? "",
        redirectUri,
        challenge: form.get("code_challenge") ?? "",
      });
      back.searchParams.set("code", code);
    }
    back.searchParams.set("state", state);
    response.writeHead(303, { location: back.href });
    response.end();
  }

  function exchange(request: IncomingMessage, response: ServerResponse, form: URLSearchParams): void {
    const code = form.get("code") ?? "";
    const grant = grants.get(code);
    // A code is good once, as at a real provider.
    grants.delete(code);
    const verifier = form.get("code_verifier") ?? "";
    const accepted =
      grant !== undefined &&
      form.get("client_id") === clientId &&
      form.get("client_secret") === clientSecret &&
      grant.clientId === clientId &&
      form.get("redirect_uri") === grant.redirectUri &&
      createHash("sha256").update(verifier).digest("base64url") === grant.challenge &&
      (request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded");
    if (!accepted) {
      return send(response, 400, { error: "invalid_grant" });
    }
    const token = randomBytes(16).toString("base64url");
    tokens.set(token, grant.subject);
    send(response, 200, { access_token: token, token_type: "bearer", scope: "" });
  }

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function formOf(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
