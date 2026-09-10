import { describe, expect, it } from "vitest";
import { useTestServer } from "./support/harness.ts";

describe("GET /health", () => {
  const server = useTestServer();

  it("reports the service and its database as reachable", async () => {
    const response = await server().client.get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", database: "reachable" });
  });

  it("requires no authentication", async () => {
    // No credentials are configured anywhere in this test; reaching 200 is
    // itself the assertion that the endpoint is open.
    const response = await server().client.get("/health");

    expect(response.status).toBe(200);
  });

  it("reports unavailable without leaking why when the database is gone", async () => {
    await server().database.end();

    const response = await server().client.get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "unavailable", database: "unreachable" });
    // Operational detail belongs in the log, not the response.
    expect(response.raw).not.toMatch(/postgres|password|ECONNREFUSED|localhost/i);
  });

  it("returns 404 for an unknown route without echoing the path back", async () => {
    const response = await server().client.get("/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ status: "refused" });
    expect(response.raw).not.toContain("does-not-exist");
  });

  it("refuses every unknown route identically", async () => {
    // ADR-0002: refusals must not let a caller tell one case from another.
    // Ticket 03 extends this to records; here it holds for routes.
    const first = await server().client.get("/schools/1/students");
    const second = await server().client.get("/totally-invented");

    expect(first.status).toBe(second.status);
    expect(first.raw).toBe(second.raw);
    // The refusal is named after no particular cause.
    expect(first.raw).not.toMatch(/not_found|forbidden|unauthorized/i);
  });
});
