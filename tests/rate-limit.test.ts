import { describe, expect, it } from "vitest";
import { useTestServer } from "./support/harness.ts";

const LIMIT = 3;

describe("rate limiting", () => {
  const server = useTestServer({ rateLimit: { max: LIMIT, windowMs: 60_000 } });

  it("throttles a request over the limit before it reaches the route", async () => {
    for (let i = 0; i < LIMIT; i++) {
      expect((await server().client.get("/api/health")).status).toBe(200);
    }

    // With the database gone, a request that reached the route would answer
    // 503. A 429 shows the limit stopped it before any query was attempted.
    await server().database.end();
    const response = await server().client.get("/api/health");

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ status: "rate_limited" });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("counts requests for routes that do not exist", async () => {
    // Otherwise probing for routes would be free, and the limit would reveal
    // which paths exist by applying to some and not others.
    for (let i = 0; i < LIMIT; i++) {
      await server().client.get("/api/does-not-exist");
    }

    const unknown = await server().client.get("/api/does-not-exist");
    const known = await server().client.get("/api/health");

    expect(unknown.status).toBe(429);
    expect(known.status).toBe(unknown.status);
    expect(known.raw).toBe(unknown.raw);
  });

  describe("the web app's page and static assets", () => {
    const navigation = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    it("are not counted, so loading pages does not use up the API's allowance", async () => {
      // Served from memory, they cost nothing a flood could exhaust, and one
      // page load fetches several of them.
      for (let i = 0; i <= LIMIT * 3; i++) {
        expect((await server().client.withAccept(navigation).get(`/schools/${i}`)).status).toBe(200);
        expect((await server().client.get("/assets/app.js")).status).toBe(200);
      }

      for (let i = 0; i < LIMIT; i++) {
        expect((await server().client.get("/api/health")).status).toBe(200);
      }
      expect((await server().client.get("/api/health")).status).toBe(429);
    });

    it("are still served to a client over the limit", async () => {
      for (let i = 0; i <= LIMIT; i++) {
        await server().client.get("/api/health");
      }

      expect((await server().client.get("/api/health")).status).toBe(429);
      expect((await server().client.withAccept(navigation).get("/")).status).toBe(200);
      expect((await server().client.get("/assets/app.css")).status).toBe(200);
    });

    it("do not exempt a request outside /api that the web app does not answer", async () => {
      // Refused like an unknown route, and it costs what one costs.
      const unanswered = [
        () => server().client.get("/assets/missing.js"),
        () => server().client.withAccept(navigation).request("POST", "/schools", {}),
        () => server().client.withAccept(navigation).get("/api/no-such-route"),
      ];
      for (const send of unanswered) {
        await send();
      }

      const throttled = await server().client.get("/api/health");
      expect(throttled.status).toBe(429);
      for (const send of unanswered) {
        expect((await send()).status).toBe(429);
      }
    });
    it("do not exempt a request for /api, however its path is encoded", async () => {
      // The router decodes a path before matching it, so each of these reaches
      // an /api route or its refusal, and must cost what that costs.
      const encoded = [
        () => server().client.withAccept(navigation).get("/%61pi/health"),
        () => server().client.withAccept(navigation).get("/%61%70%69/no-such-route"),
        () => server().client.withAccept(navigation).get("/%61pi"),
      ];
      for (const send of encoded) {
        await send();
      }

      expect((await server().client.get("/api/health")).status).toBe(429);
      for (const send of encoded) {
        expect((await send()).status).toBe(429);
      }
    });
  });

  it("limits each client address separately", async () => {
    const flooding = server().client.fromAddress("203.0.113.7");
    for (let i = 0; i <= LIMIT; i++) {
      await flooding.get("/api/health");
    }

    const other = await server().client.fromAddress("198.51.100.20").get("/api/health");

    expect((await flooding.get("/api/health")).status).toBe(429);
    expect(other.status).toBe(200);
  });

  it("does not expose the client's remaining allowance on ordinary responses", async () => {
    // A counter on every response would make two otherwise identical refusals
    // differ, which ADR-0002 forbids.
    const first = await server().client.get("/api/session");
    const second = await server().client.get("/api/session");

    expect(Object.keys(first.headers).filter((name) => name.startsWith("x-ratelimit"))).toEqual([]);
    expect(first.raw).toBe(second.raw);
    expect(first.headers["retry-after"]).toBeUndefined();
  });

  it("limits sign-in attempts the same way, rather than refusing them", async () => {
    // A refusal would tell a client guessing passwords to keep going; being
    // throttled has to be visible for the limit to slow guessing at all.
    const attempt = { username: "alice", password: "wrong" };
    for (let i = 0; i < LIMIT; i++) {
      await server().client.post("/api/session", attempt);
    }

    const response = await server().client.post("/api/session", attempt);

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ status: "rate_limited" });
  });
});
