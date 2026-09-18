import { randomUUID } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import { afterEach, beforeEach, inject } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { appendAuditRecord, type AuditEntry } from "../../src/audit/index.ts";
import { toConnectionString } from "../../src/db/connection-string.ts";
import { createPool, type Database } from "../../src/db/pool.ts";
import {
  createUserAccount,
  type Credentials,
  type UserAccount,
} from "../../src/authentication/index.ts";
import { grantMembership, recordEnrollment, type Role } from "../../src/access/index.ts";
import {
  createPerson,
  createPlatformAdministrator,
  type Person,
  type PlatformAdministrator,
} from "../../src/identity/index.ts";
import { provisionSchool, type ProvisionedSchool } from "../../src/platform/index.ts";
import { parsePublicOrigin, type PublicOrigin, type RateLimit } from "../../src/config.ts";
import { loadWebApp } from "../../src/http/web-app.ts";
import { buildServer, type RegisteredRoute } from "../../src/server.ts";

/** The origin every test server is configured to be served from. */
const PUBLIC_ORIGIN = parsePublicOrigin("https://schoolgrid.test");

/**
 * A stand-in for the built web app, served by every test server as the image
 * serves the real one. Tests assert on serving, never on what the app does:
 * that is the browser suite's seam.
 */
const WEB_APP_FIXTURE = new URL("./web-app/", import.meta.url);

export type Method = NonNullable<InjectOptions["method"]>;

export interface TestResponse {
  status: number;
  headers: OutgoingHttpHeaders;
  body: unknown;
  raw: string;
}

/**
 * Everything a caller can observe about a response, minus the clock. Two
 * refusals ADR-0002 calls identical must compare equal through this. The order
 * headers are sent in is observable too, and an object comparison ignores it.
 */
export function observable({ status, headers, raw }: TestResponse) {
  const { date: _date, ...rest } = headers;
  return { status, headers: rest, headerOrder: Object.keys(rest), raw };
}

/**
 * The same, minus the one header a caller's own request can cause on an
 * otherwise identical refusal: sign-out expires a session cookie the caller
 * carried from the public origin, whether or not a live Session was behind it,
 * so a caller holding a cookie sees a `Set-Cookie` where a caller holding none
 * sees nothing (#89). Every other byte must still match.
 *
 * Only for comparing responses whose callers presented different cookies. Each
 * use pins the `Set-Cookie` itself with `setCookiesOf` alongside, so nothing
 * about the cookie goes unasserted.
 */
export function observableApartFromOwnCookie(response: TestResponse) {
  const { headers, headerOrder, ...rest } = observable(response);
  const { "set-cookie": _cookie, ...withoutCookie } = headers;
  return { ...rest, headers: withoutCookie, headerOrder: headerOrder.filter((name) => name !== "set-cookie") };
}

/**
 * The same, minus `cache-control`, which is decided by the request's path
 * alone: a refusal outside `/api` carries `no-cache` where one under it carries
 * `no-store`. Every other byte of the two must still match.
 *
 * Only for comparing responses to paths on either side of `/api`. Each use pins
 * the `cache-control` itself alongside, so it never goes unasserted.
 */
export function observableApartFromCacheControl(response: TestResponse) {
  const { headers, headerOrder, ...rest } = observable(response);
  const { "cache-control": _cacheControl, ...withoutCacheControl } = headers;
  return {
    ...rest,
    headers: withoutCacheControl,
    headerOrder: headerOrder.filter((name) => name !== "cache-control"),
  };
}

/** Every `Set-Cookie` header a response carries, attributes and all. */
export function setCookiesOf(response: TestResponse): string[] {
  return [response.headers["set-cookie"] ?? []].flat();
}

/**
 * What a browser sends back for the one cookie a response set: its name and
 * value, without the attributes.
 */
export function cookieSentBackFor(response: TestResponse): string {
  const cookies = setCookiesOf(response);
  if (cookies.length !== 1) {
    throw new Error(`expected one cookie to be set but received ${cookies.length}`);
  }
  return cookies[0]!.split(";")[0]!;
}

export interface TestClient {
  /** Sends any method, with a JSON body if one is given. */
  request(method: Method, path: string, body?: unknown): Promise<TestResponse>;
  get(path: string): Promise<TestResponse>;
  post(path: string, body?: unknown): Promise<TestResponse>;
  patch(path: string, body?: unknown): Promise<TestResponse>;
  delete(path: string, body?: unknown): Promise<TestResponse>;
  /** Sends a body exactly as given, for requests JSON serialization cannot express. */
  postRaw(path: string, payload: string, contentType: string): Promise<TestResponse>;
  /** A client presenting this session token as a Bearer token on every request. */
  withBearer(token: string): TestClient;
  /** A client sending this exact `Cookie` header on every request, as a browser would. */
  withCookie(value: string): TestClient;
  /** A client sending this exact `Origin` header on every request, as a browser would. */
  withOrigin(origin: string): TestClient;
  /** A client sending this exact `Accept` header on every request, as a browser would. */
  withAccept(value: string): TestClient;
  /** A client sending this exact `Authorization` header on every request. */
  withAuthorization(value: string): TestClient;
  /** A client sending this header, as a proxy in front of the server might add it. */
  withHeader(name: string, value: string): TestClient;
  /** A client whose requests arrive from this remote address. */
  fromAddress(address: string): TestClient;
  /** A client acting within this School: `/persons` addresses `/api/schools/<id>/persons`. */
  inSchool(schoolId: string): TestClient;
}

export interface TestServer {
  /** The only supported way to exercise the system in a test. */
  client: TestClient;
  /**
   * Every route the server registered, as Fastify registered it, with its
   * parameters unfilled: `/api/schools/:schoolId/persons`.
   */
  routes: readonly RegisteredRoute[];
  /**
   * The application's own connection, logged in as its least-privilege role.
   * For arranging fixtures and asserting on database-level guarantees: what
   * this connection is refused, the running application is refused.
   */
  database: Database;
  /** A connection as the schema owner, for what only a migration may do. */
  ownerDatabase: Database;
  /** Arranges a User account. Accounts are provisioned, never self-registered. */
  createAccount(credentials: Credentials): Promise<UserAccount>;
  /**
   * Arranges a Platform Administrator, made as a deployment makes one: by the
   * schema owner, from outside the running service. Named after the account
   * unless a display name is given.
   */
  createPlatformAdministrator(platformAdministrator: {
    account: UserAccount;
    displayName?: string;
  }): Promise<PlatformAdministrator>;
  /** Arranges a School together with its first School Administrator. */
  provisionSchool(school: { name: string; administrator: UserAccount }): Promise<ProvisionedSchool>;
  /**
   * Arranges a Person in a School, optionally one a User account resolves to,
   * holding a membership with this role from now on. A Person with no
   * membership has no access to the School at all.
   */
  createPerson(person: {
    schoolId: string;
    displayName: string;
    account?: UserAccount;
    role?: Role;
  }): Promise<Person>;
  /**
   * Arranges a membership with any bounds, past ones included, and no Audit
   * record. A test of granting grants through the client instead.
   */
  grantMembership(membership: {
    person: Person;
    role: Role;
    startsAt?: Date;
    endsAt?: Date | null;
  }): Promise<void>;
  /**
   * Arranges an open Enrollment for a Student, with no Audit record. A test of
   * enrolling enrolls through the client instead.
   */
  enroll(student: Person): Promise<void>;
  /**
   * Arranges an Invitation as if it had been issued more than 7 days ago, so it
   * has expired. Its issuing moves back with its expiry, as the database
   * requires; nothing about it is written to say it expired.
   */
  expireInvitation(invitationId: string): Promise<void>;
  /**
   * Arranges an Invitation as redeemed by this account, with no Audit record
   * and without attaching the Person. A test of redeeming redeems through the
   * client instead.
   */
  markInvitationRedeemed(invitationId: string, account: UserAccount): Promise<void>;
  /** Arranges an Audit record, appended exactly as the application appends one. */
  appendAuditRecord(entry: AuditEntry): Promise<void>;
  /** The origin the server is configured to be served from. */
  publicOrigin: PublicOrigin;
  /**
   * Authenticates through the API, asking for a Bearer token, and returns a
   * client presenting it.
   */
  signIn(credentials: Credentials): Promise<TestClient>;
  /**
   * Authenticates through the API as a browser on the public origin does, and
   * returns a client sending back the cookie it was given. That client sends
   * no `Origin`: give it one with `withOrigin`.
   */
  signInWithCookie(credentials: Credentials): Promise<TestClient>;
}

function connectionString(database: string): string {
  const { host, port, user, password } = inject("postgres");
  return toConnectionString({ host, port, user, password, database });
}

function applicationConnectionString(database: string): string {
  const { host, port, appUser, appPassword } = inject("postgres");
  return toConnectionString({ host, port, user: appUser, password: appPassword, database });
}

/**
 * Creating and dropping a database cannot be done from a connection to that
 * database, so both need a short-lived connection to `postgres` instead.
 */
async function withAdminConnection(work: (admin: Database) => Promise<void>): Promise<void> {
  const admin = createPool(connectionString("postgres"));
  try {
    await work(admin);
  } finally {
    await admin.end();
  }
}

type Payload = { json: unknown } | { raw: string; contentType: string };

interface ClientIdentity {
  headers: Record<string, string>;
  remoteAddress?: string;
  prefix?: string;
}

function buildClient(app: FastifyInstance, identity: ClientIdentity = { headers: {} }): TestClient {
  const { headers, remoteAddress, prefix = "" } = identity;
  const request = async (
    method: Method,
    path: string,
    payload?: Payload,
  ): Promise<TestResponse> => {
    const response = await app.inject({
      method,
      url: `${prefix}${path}`,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
      headers:
        payload !== undefined && "raw" in payload
          ? { ...headers, "content-type": payload.contentType }
          : headers,
      ...(payload === undefined
        ? {}
        : { payload: "raw" in payload ? payload.raw : (payload.json as object) }),
    });

    let parsed: unknown;
    try {
      parsed = response.body === "" ? undefined : JSON.parse(response.body);
    } catch {
      parsed = response.body;
    }

    return {
      status: response.statusCode,
      headers: response.headers,
      body: parsed,
      raw: response.body,
    };
  };

  return {
    request: (method, path, body) =>
      request(method, path, body === undefined ? undefined : { json: body }),
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body === undefined ? undefined : { json: body }),
    patch: (path, body) => request("PATCH", path, body === undefined ? undefined : { json: body }),
    delete: (path, body) =>
      request("DELETE", path, body === undefined ? undefined : { json: body }),
    postRaw: (path, raw, contentType) => request("POST", path, { raw, contentType }),
    withBearer: (token) =>
      buildClient(app, { ...identity, headers: { ...headers, authorization: `Bearer ${token}` } }),
    withCookie: (value) => buildClient(app, { ...identity, headers: { ...headers, cookie: value } }),
    withOrigin: (origin) => buildClient(app, { ...identity, headers: { ...headers, origin } }),
    withAccept: (accept) => buildClient(app, { ...identity, headers: { ...headers, accept } }),
    withAuthorization: (value) =>
      buildClient(app, { ...identity, headers: { ...headers, authorization: value } }),
    withHeader: (name, value) => buildClient(app, { ...identity, headers: { ...headers, [name]: value } }),
    fromAddress: (address) => buildClient(app, { ...identity, remoteAddress: address }),
    inSchool: (schoolId) => buildClient(app, { ...identity, prefix: `/api/schools/${schoolId}` }),
  };
}

export interface TestServerOptions {
  /** Replaces the default limit so a test can exceed it in a few requests. */
  rateLimit?: RateLimit;
  /**
   * Adds routes to the built server before it starts, for a test of what the
   * server does to any route's response, whatever the route does itself.
   */
  addRoutes?: (app: FastifyInstance) => void;
}

/**
 * Gives each test its own database, copied from the migrated template, and a
 * client that drives a server bound to it.
 *
 * Tests go through the returned client. Reaching past it into a route handler
 * would create a second seam, and the guarantee in ADR-0002 is only assertable
 * at the boundary where a caller actually stands.
 *
 * The client uses Fastify's `inject`, which runs the complete request lifecycle
 * — routing, hooks, serialization, status and headers — without binding a
 * socket. That covers everything the refusal guarantees are made of. It does
 * not cover the transport itself (keep-alive, body limits, malformed HTTP
 * framing); if those ever need asserting, they need a listening server, not a
 * second seam through the application.
 */
export function useTestServer({ rateLimit, addRoutes }: TestServerOptions = {}): () => TestServer {
  let context: TestServer;
  let app: FastifyInstance;
  let pool: Database;
  let ownerPool: Database;
  let databaseName: string;

  beforeEach(async () => {
    const { templateDatabase } = inject("postgres");
    databaseName = `test_${randomUUID().replaceAll("-", "")}`;

    await withAdminConnection(async (admin) => {
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${templateDatabase}"`);
    });

    pool = createPool(applicationConnectionString(databaseName));
    ownerPool = createPool(connectionString(databaseName));
    const routes: RegisteredRoute[] = [];
    app = buildServer({
      database: pool,
      logLevel: "silent",
      publicOrigin: PUBLIC_ORIGIN,
      webApp: await loadWebApp(WEB_APP_FIXTURE),
      ...(rateLimit === undefined ? {} : { rateLimit }),
      onRoute: (route) => routes.push(route),
    });
    addRoutes?.(app);
    await app.ready();

    const client = buildClient(app);
    context = {
      client,
      routes,
      database: pool,
      ownerDatabase: ownerPool,
      createAccount: (credentials) => createUserAccount(pool, credentials),
      createPlatformAdministrator: ({ account, displayName }) =>
        createPlatformAdministrator(ownerPool, {
          userAccountId: account.id,
          displayName: displayName ?? account.username,
        }),
      provisionSchool: async ({ name, administrator }) => {
        const provisioned = await provisionSchool(pool, {
          name,
          schoolAdministrator: { account: administrator, displayName: administrator.username },
          platformAdministrator: null,
        });
        if (provisioned === null) {
          throw new Error("provisionSchool was given a Platform Administrator's account");
        }
        return provisioned;
      },
      createPerson: async ({ schoolId, displayName, account, role }) => {
        const person = await createPerson(pool, {
          schoolId,
          displayName,
          ...(account === undefined ? {} : { userAccountId: account.id }),
        });
        if (role !== undefined) {
          await grantMembership(pool, { person, role });
        }
        return person;
      },
      grantMembership: async (membership) => {
        await grantMembership(pool, membership);
      },
      enroll: async (student) => {
        await recordEnrollment(pool, student);
      },
      // As the schema owner: when an Invitation was issued is not the application's to change.
      expireInvitation: async (invitationId) => {
        await ownerPool.query(
          `UPDATE app.invitation
           SET created_at = created_at - interval '8 days', expires_at = expires_at - interval '8 days'
           WHERE id = $1`,
          [invitationId],
        );
      },
      markInvitationRedeemed: async (invitationId, account) => {
        await pool.query(
          `UPDATE app.invitation SET redeemed_at = now(), redeemed_by_user_account_id = $2 WHERE id = $1`,
          [invitationId, account.id],
        );
      },
      appendAuditRecord: (entry) => appendAuditRecord(pool, entry),
      publicOrigin: PUBLIC_ORIGIN,
      signIn: async (credentials) => {
        const response = await client.post("/api/session", { ...credentials, session: "bearer" });
        const token = (response.body as { token?: unknown } | undefined)?.token;
        if (response.status !== 201 || typeof token !== "string") {
          throw new Error(`signIn expected a session but received status ${response.status}`);
        }
        return client.withBearer(token);
      },
      signInWithCookie: async (credentials) => {
        const response = await client.withOrigin(PUBLIC_ORIGIN).post("/api/session", credentials);
        if (response.status !== 201) {
          throw new Error(`signInWithCookie expected a session but received status ${response.status}`);
        }
        return client.withCookie(cookieSentBackFor(response));
      },
    };
  });

  afterEach(async () => {
    await app.close();
    // A test may have ended the pool itself to simulate an unreachable
    // database, so ending it here is conditional rather than unconditional.
    if (!pool.ended && !pool.ending) {
      await pool.end();
    }
    await ownerPool.end();

    await withAdminConnection(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    });
  });

  return () => context;
}
