import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { observable, useTestServer, type Method, type TestResponse } from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };

describe("the API is served under /api", () => {
  // The route enumeration below makes more requests than the default limit allows.
  const server = useTestServer({ rateLimit: { max: 10_000, windowMs: 60_000 } });

  // Every other path on the origin belongs to the web app.
  it("registers every route under /api", () => {
    const outside = server()
      .routes.filter(({ url }) => !url.startsWith("/api/"))
      .map(({ method, url }) => `${method} ${url}`);

    expect(server().routes.length).toBeGreaterThan(0);
    expect(outside).toEqual([]);
  });

  /**
   * Each route is requested at the path it had before it moved, by a School
   * Administrator against records that exist. Nothing answers there, and a
   * path that once named a School is no longer a refusal in that School.
   */
  it("answers nothing at a route's old path, and records nothing there", async () => {
    const { school, schoolAdministrator } = await server().provisionSchool({
      name: "Northside",
      administrator: await server().createAccount(ALICE),
    });
    const alice = await server().signIn(ALICE);

    const answered: string[] = [];
    for (const { method, url } of server().routes) {
      // Any existing record will do for the other parameters: nothing is
      // routed at an old path, so which record a parameter names never matters.
      const path = url
        .replace(/^\/api/, "")
        .replace(/:(\w+)/g, (_parameter, name: string) =>
          name === "schoolId" ? school.id : schoolAdministrator.id,
        );
      const body = method === "GET" || method === "HEAD" ? undefined : {};

      const atOldPath = await alice.request(method as Method, path, body);
      const nonexistent = await alice.request(method as Method, "/no-such-route", body);

      // `inject` hands back the body of a HEAD response that the wire would drop.
      const sent = (response: TestResponse) =>
        method === "HEAD" ? { ...observable(response), raw: "" } : observable(response);
      if (!isDeepStrictEqual(sent(atOldPath), sent(nonexistent))) {
        answered.push(`${method} ${path} answered ${atOldPath.status}`);
      }
    }

    expect(answered).toEqual([]);
    const { rows } = await server().ownerDatabase.query<{ refusals: number }>(
      "SELECT count(*)::int AS refusals FROM app.audit_record WHERE action = 'access.refused'",
    );
    expect(rows).toEqual([{ refusals: 0 }]);
  });
});
