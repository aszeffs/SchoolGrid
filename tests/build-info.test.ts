import { describe, expect, it } from "vitest";
import { useTestServer, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"ab".repeat(32)}`;

/** Written out here rather than imported, as in the security headers suite. */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

function securityHeadersOf({ headers }: TestResponse) {
  return Object.fromEntries(Object.keys(SECURITY_HEADERS).map((name) => [name, headers[name]]));
}

describe("GET /api/build-info", () => {
  describe("on a server that knows its commit and digest", () => {
    const server = useTestServer({ buildInfo: { commit: COMMIT, digest: DIGEST } });

    it("returns both, and nothing else", async () => {
      const response = await server().client.get("/api/build-info");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ commit: COMMIT, digest: DIGEST });
    });

    it("needs no session, and answers a signed-in caller the same", async () => {
      await server().provisionSchool({ name: "Northside", administrator: await server().createAccount(ALICE) });
      const signedIn = await server().signIn(ALICE);

      const anonymous = await server().client.get("/api/build-info");
      const withSession = await signedIn.get("/api/build-info");

      expect(anonymous.status).toBe(200);
      expect(withSession.raw).toBe(anonymous.raw);
    });

    it("carries the security headers", async () => {
      const response = await server().client.get("/api/build-info");

      expect(response.status).toBe(200);
      expect(securityHeadersOf(response)).toEqual(SECURITY_HEADERS);
    });
  });

  describe("on a server that knows neither, as in local development", () => {
    const server = useTestServer();

    it("omits both rather than inventing placeholders", async () => {
      const response = await server().client.get("/api/build-info");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });
  });

  describe("on a server that knows its commit but was not given a digest", () => {
    const server = useTestServer({ buildInfo: { commit: COMMIT } });

    it("returns the commit alone", async () => {
      const response = await server().client.get("/api/build-info");

      expect(response.body).toEqual({ commit: COMMIT });
    });
  });

  describe("under the rate limit", () => {
    const LIMIT = 2;
    const server = useTestServer({ rateLimit: { max: LIMIT, windowMs: 60_000 } });

    it("is counted and throttled like every route", async () => {
      for (let i = 0; i < LIMIT; i++) {
        expect((await server().client.get("/api/build-info")).status).toBe(200);
      }

      const response = await server().client.get("/api/build-info");

      expect(response.status).toBe(429);
      expect(response.body).toEqual({ status: "rate_limited" });
      expect(securityHeadersOf(response)).toEqual(SECURITY_HEADERS);
    });
  });
});
