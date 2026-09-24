import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  observable,
  observableApartFromCacheControl,
  useTestServer,
  type TestClient,
} from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };

/** What a browser sends when it navigates to a page. */
const NAVIGATION = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

const FIXTURE = new URL("./support/web-app/", import.meta.url);

async function fixture(path: string): Promise<string> {
  return readFile(new URL(path, FIXTURE), "utf8");
}

function navigating(client: TestClient): TestClient {
  return client.withAccept(NAVIGATION);
}

describe("the web app", () => {
  const server = useTestServer();

  describe("a navigation outside /api", () => {
    it("is answered with the app", async () => {
      const response = await navigating(server().client).get("/");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.raw).toBe(await fixture("index.html"));
    });

    it("is answered identically whatever the path, so a deep link opens the app", async () => {
      const root = await navigating(server().client).get("/");

      for (const path of [
        "/schools",
        "/schools/5f0c1c1e-0000-4000-8000-000000000000/persons",
        "/sign-in?next=%2Fschools",
        "/no/such/page",
        "/assets/app.js",
        "/API/health",
      ]) {
        expect(observable(await navigating(server().client).get(path)), path).toEqual(observable(root));
      }
    });

    it("is answered identically whoever asks, so it reveals nothing about the caller", async () => {
      const account = await server().createAccount(ALICE);
      const { school } = await server().provisionSchool({ name: "Northside", administrator: account });
      const anonymous = await navigating(server().client).get(`/schools/${school.id}`);

      for (const caller of [await server().sessionFor(account), await server().cookieSessionFor(account)]) {
        expect(observable(await navigating(caller).get(`/schools/${school.id}`))).toEqual(
          observable(anonymous),
        );
      }
    });

    // `inject` hands back the body of a HEAD response that the wire would drop,
    // so only what a HEAD request does observe is compared.
    it("is answered to a HEAD request as to a GET", async () => {
      const head = await navigating(server().client).request("HEAD", "/schools");
      const get = await navigating(server().client).get("/schools");

      expect(head.status).toBe(200);
      expect(observable(head).headers).toEqual(observable(get).headers);
    });

    // Outside /api a refusal is revalidated like the app's page rather than
    // never stored, which its path alone decides; every other byte matches.
    it("is refused for a method other than GET or HEAD", async () => {
      const refusal = await server().client.get("/api/no-such-route");

      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await navigating(server().client).request(method, "/schools", {});
        expect(observableApartFromCacheControl(response), method).toEqual(
          observableApartFromCacheControl(refusal),
        );
        expect(response.headers["cache-control"], method).toBe("no-cache");
      }
    });
  });

  describe("a static asset", () => {
    it("is served with its content type", async () => {
      const script = await server().client.get("/assets/app.js");
      const stylesheet = await server().client.get("/assets/app.css");

      expect(script.status).toBe(200);
      expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(script.raw).toBe(await fixture("assets/app.js"));
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers["content-type"]).toBe("text/css; charset=utf-8");
      expect(stylesheet.raw).toBe(await fixture("assets/app.css"));
    });

    it("is refused, like any unrouted path, when the build holds no such file", async () => {
      const refusal = await server().client.get("/api/no-such-route");

      for (const path of [
        "/assets/missing.js",
        "/assets/app.js/",
        "/assets/../../package.json",
        "/assets/%2e%2e/%2e%2e/package.json",
        "/web-app.test.ts",
        "/",
      ]) {
        const response = await server().client.get(path);
        expect(observableApartFromCacheControl(response), path).toEqual(
          observableApartFromCacheControl(refusal),
        );
        expect(response.headers["cache-control"], path).toBe("no-cache");
      }
    });
  });

  describe("under /api", () => {
    it("never answers a navigation with the app, and refuses it exactly as before", async () => {
      const refusal = await server().client.get("/api/no-such-route");

      for (const path of [
        "/api",
        "/api/",
        "/api/no-such-route",
        "/api/schools/unknown/persons",
        // The router decodes a path before matching it, so these are under
        // /api too. Answered with the app, they would tell a route that exists
        // from one that does not.
        "/%61pi",
        "/%61pi/no-such-route",
        "/%61%70%69/schools/unknown/persons",
        "/api%2Fno-such-route",
      ]) {
        expect(observable(await navigating(server().client).get(path)), path).toEqual(observable(refusal));
      }
    });

    it("still answers a route that exists, however its path is encoded", async () => {
      for (const path of ["/api/health", "/%61pi/health"]) {
        const response = await navigating(server().client).get(path);

        expect(response.status, path).toBe(200);
        expect(response.body, path).toEqual({ status: "ok", database: "reachable" });
      }
    });

    it("still records a navigation refused within a School in that School's Audit records", async () => {
      const account = await server().createAccount(ALICE);
      const { school } = await server().provisionSchool({ name: "Northside", administrator: account });
      const alice = await server().sessionFor(account);

      await navigating(alice).get(`/api/schools/${school.id}/no-such-route`);

      const { body } = await alice.inSchool(school.id).get("/audit-records");
      expect((body as { auditRecords: unknown[] }).auditRecords).toContainEqual(
        expect.objectContaining({
          action: "access.refused",
          reason: "no-such-route",
          target: { type: "request", id: `GET /api/schools/${school.id}/no-such-route` },
        }),
      );
    });
  });
});
