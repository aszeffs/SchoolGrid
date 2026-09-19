import { describe, expect, it } from "vitest";
import {
  observable,
  useTestServer,
  type Method,
  type TestClient,
  type TestResponse,
} from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const PAT = { username: "pat", password: "platform staple, long enough" };

/** What a browser sends when it navigates to a page. */
const NAVIGATION = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/**
 * The `cache-control` each kind of path gets. Written out here rather than
 * imported, like the headers below.
 */
const NO_STORE = "no-store";
const NO_CACHE = "no-cache";
const IMMUTABLE = "max-age=31536000, immutable";

/**
 * Written out here rather than imported, so a weakened value in the source
 * fails this test instead of moving it along. `cache-control` depends on the
 * path, so it is passed to `missingOrWeakened` instead.
 */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

/**
 * The security headers a response is missing, or carries with another value.
 * `cacheControl` is the value its path gets, `no-store` for any under `/api`.
 */
function missingOrWeakened({ headers }: TestResponse, cacheControl: string = NO_STORE): string[] {
  return Object.entries({ ...SECURITY_HEADERS, "cache-control": cacheControl })
    .filter(([name, value]) => headers[name] !== value)
    .map(([name]) => `${name}: ${String(headers[name])}`);
}

describe("security headers", () => {
  describe("on every kind of response", () => {
    const server = useTestServer();

    it("are on a successful response", async () => {
      const response = await server().client.get("/api/health");

      expect(response.status).toBe(200);
      expect(missingOrWeakened(response)).toEqual([]);
    });

    it("are on every refusal, which stays byte-identical to the others", async () => {
      // ADR-0002: the headers are the same on every refusal, so they cannot
      // tell one refusal from another.
      const { school } = await server().provisionSchool({
        name: "Northside",
        administrator: await server().createAccount(ALICE),
      });

      const routed = await server().client.inSchool(school.id).get("/persons");
      const unrouted = await server().client.get("/api/no-such-route");
      const unparsable = await server().client.get("/api/schools/%E0%A4%A/persons");

      expect(routed.body).toEqual({ status: "refused" });
      expect(missingOrWeakened(routed)).toEqual([]);
      expect(observable(unrouted)).toEqual(observable(routed));
      expect(observable(unparsable)).toEqual(observable(routed));
    });

    // Answered outside every route, so the enumeration below never sees them.
    it("are on the web app and its static assets", async () => {
      const page = await server().client.withAccept("text/html").get("/schools");
      const asset = await server().client.get("/assets/app.js");

      expect([page.status, asset.status]).toEqual([200, 200]);
      expect(missingOrWeakened(page, NO_CACHE)).toEqual([]);
      expect(missingOrWeakened(asset, IMMUTABLE)).toEqual([]);
    });

    it("are on a malformed-request rejection", async () => {
      await server().createPlatformAdministrator({ account: await server().createAccount(PAT) });
      const pat = await server().signIn(PAT);

      const response = await pat.post("/api/platform/schools", {});

      expect(response.body).toEqual({ status: "invalid_request" });
      expect(missingOrWeakened(response)).toEqual([]);
    });

    it("are on a server error", async () => {
      await server().createAccount(ALICE);
      await server().ownerDatabase.query("REVOKE INSERT ON app.audit_record FROM schoolgrid_app");

      const response = await server().client.withOrigin(server().publicOrigin).post("/api/session", ALICE);

      expect(response.status).toBe(500);
      expect(missingOrWeakened(response)).toEqual([]);
    });

    /**
     * Each route is requested as a School Administrator against records that
     * exist, with an empty body. Whatever it answers — an answer, a refusal,
     * a rejection — must carry every header, so a route added later cannot
     * leave them off by accident.
     */
    it("are on the response of every registered route", async () => {
      const { school, schoolAdministrator } = await server().provisionSchool({
        name: "Northside",
        administrator: await server().createAccount(ALICE),
      });
      const alice = await server().signIn(ALICE);

      expect(server().routes.length).toBeGreaterThan(0);
      const lacking: string[] = [];
      for (const { method, url } of server().routes) {
        const path = url.replace(/:(\w+)/g, (_parameter, name: string) =>
          name === "schoolId" ? school.id : schoolAdministrator.id,
        );
        const body = method === "GET" || method === "HEAD" ? undefined : {};

        for (const caller of [alice, server().client]) {
          const response = await caller.request(method as Method, path, body);
          const missing = missingOrWeakened(response);
          if (missing.length > 0) {
            lacking.push(`${method} ${url} (${response.status}) lacks ${missing.join(", ")}`);
          }
        }
      }

      expect(lacking).toEqual([]);
    });
  });

  describe("when rate limited", () => {
    const server = useTestServer({ rateLimit: { max: 1, windowMs: 60_000 } });

    it("are on a rate-limited response", async () => {
      await server().client.get("/api/health");

      const response = await server().client.get("/api/health");

      expect(response.status).toBe(429);
      expect(missingOrWeakened(response)).toEqual([]);
    });
  });

  describe("cache-control", () => {
    const server = useTestServer({
      addRoutes: (app) => {
        for (const path of ["/api/test/weakens-caching", "/test/weakens-caching"]) {
          app.get(path, async (_request, reply) =>
            reply.header("cache-control", "public, max-age=86400").send({ status: "ok" }),
          );
        }
      },
    });

    function navigating(client: TestClient): TestClient {
      return client.withAccept(NAVIGATION);
    }

    // `index.html` is the one file whose name stays the same while its contents
    // change with every deploy, so a browser may keep it but must revalidate it.
    it("is no-cache on the app's page, however it is reached", async () => {
      const responses = [
        ...(await Promise.all(
          ["/", "/schools", "/sign-in?next=%2Fschools", "/assets/app.js", "/index.html"].map((path) =>
            navigating(server().client).get(path),
          ),
        )),
        await server().client.get("/index.html"),
      ];

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(response.headers["cache-control"]).toBe(NO_CACHE);
      }
    });

    // The build fingerprints every file under /assets, so what a name holds
    // never changes and a browser need never ask again.
    it("is long-lived and immutable on a fingerprinted asset", async () => {
      for (const path of ["/assets/app.js", "/assets/app.css"]) {
        const response = await server().client.get(path);

        expect(response.status, path).toBe(200);
        expect(response.headers["cache-control"], path).toBe(IMMUTABLE);
      }
    });

    // A file copied into the build as it is keeps its name from one deploy to
    // the next, so it is revalidated like the page.
    it("is no-cache on a file the build does not fingerprint", async () => {
      const response = await server().client.get("/favicon.svg");

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe(NO_CACHE);
    });

    // ADR-0002: a refusal outside /api must not tell a path the app has no file
    // for from one it has, so its cache-control depends on the path alone.
    it("is the same on a refusal outside /api as on the app's page", async () => {
      const page = await navigating(server().client).get("/schools");

      for (const response of [
        await server().client.get("/assets/missing.js"),
        await server().client.get("/"),
        await server().client.request("POST", "/assets/app.js", {}),
        await navigating(server().client).request("POST", "/schools", {}),
      ]) {
        expect(response.body).toEqual({ status: "refused" });
        expect(response.headers["cache-control"]).toBe(page.headers["cache-control"]);
      }
    });

    it("is no-store under an escaped /api prefix", async () => {
      for (const path of ["/%61pi/health", "/%61pi/no-such-route", "/%61%70%69/schools/unknown/persons"]) {
        const response = await navigating(server().client).get(path);

        expect(response.headers["content-type"], path).not.toBe("text/html; charset=utf-8");
        expect(response.headers["cache-control"], path).toBe(NO_STORE);
      }
    });

    it("cannot be weakened by a route", async () => {
      const api = await server().client.get("/api/test/weakens-caching");
      const outside = await server().client.get("/test/weakens-caching");

      expect([api.status, outside.status]).toEqual([200, 200]);
      expect(api.headers["cache-control"]).toBe(NO_STORE);
      expect(outside.headers["cache-control"]).toBe(NO_CACHE);
    });
  });
});
