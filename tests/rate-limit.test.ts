import { describe, expect, it } from "vitest";
import { useTestServer } from "./support/harness.ts";

const LIMIT = 3;

describe("rate limiting", () => {
  const server = useTestServer({ rateLimit: { max: LIMIT, windowMs: 60_000 } });

  it("throttles a request over the limit before it reaches the route", async () => {
    for (let i = 0; i < LIMIT; i++) {
      expect((await server().client.get("/health")).status).toBe(200);
    }

    // With the database gone, a request that reached the route would answer
    // 503. A 429 shows the limit stopped it before any query was attempted.
    await server().database.end();
    const response = await server().client.get("/health");

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ status: "rate_limited" });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("counts requests for routes that do not exist", async () => {
    // Otherwise probing for routes would be free, and the limit would reveal
    // which paths exist by applying to some and not others.
    for (let i = 0; i < LIMIT; i++) {
      await server().client.get("/does-not-exist");
    }

    const unknown = await server().client.get("/does-not-exist");
    const known = await server().client.get("/health");

    expect(unknown.status).toBe(429);
    expect(known.status).toBe(unknown.status);
    expect(known.raw).toBe(unknown.raw);
  });

  it("limits each client address separately", async () => {
    const flooding = server().client.fromAddress("203.0.113.7");
    for (let i = 0; i <= LIMIT; i++) {
      await flooding.get("/health");
    }

    const other = await server().client.fromAddress("198.51.100.20").get("/health");

    expect((await flooding.get("/health")).status).toBe(429);
    expect(other.status).toBe(200);
  });

  it("does not expose the client's remaining allowance on ordinary responses", async () => {
    // A counter on every response would make two otherwise identical refusals
    // differ, which ADR-0002 forbids.
    const first = await server().client.get("/session");
    const second = await server().client.get("/session");

    expect(Object.keys(first.headers).filter((name) => name.startsWith("x-ratelimit"))).toEqual([]);
    expect(first.raw).toBe(second.raw);
    expect(first.headers["retry-after"]).toBeUndefined();
  });

  it("limits sign-in attempts the same way, rather than refusing them", async () => {
    // A refusal would tell a client guessing passwords to keep going; being
    // throttled has to be visible for the limit to slow guessing at all.
    const attempt = { username: "alice", password: "wrong" };
    for (let i = 0; i < LIMIT; i++) {
      await server().client.post("/session", attempt);
    }

    const response = await server().client.post("/session", attempt);

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ status: "rate_limited" });
  });
});
