import { describe, expect, it } from "vitest";
import { observable, useTestServer, type Method, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };
const PAT = { username: "pat", password: "platform staple, long enough" };

/**
 * Written out here rather than imported, so a weakened value in the source
 * fails this test instead of moving it along.
 */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

/** The security headers a response is missing, or carries with another value. */
function missingOrWeakened({ headers }: TestResponse): string[] {
  return Object.entries(SECURITY_HEADERS)
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
      expect(missingOrWeakened(page)).toEqual([]);
      expect(missingOrWeakened(asset)).toEqual([]);
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
});
