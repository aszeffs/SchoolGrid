import { randomUUID } from "node:crypto";
import type { OutgoingHttpHeaders } from "node:http";
import { afterEach, beforeEach, inject } from "vitest";
import type { FastifyInstance } from "fastify";
import { toConnectionString } from "../../src/db/connection-string.ts";
import { createPool, type Database } from "../../src/db/pool.ts";
import { createUserAccount, type Credentials } from "../../src/authentication/index.ts";
import type { RateLimit } from "../../src/config.ts";
import { buildServer } from "../../src/server.ts";

export interface TestResponse {
  status: number;
  headers: OutgoingHttpHeaders;
  body: unknown;
  raw: string;
}

export interface TestClient {
  get(path: string): Promise<TestResponse>;
  post(path: string, body?: unknown): Promise<TestResponse>;
  delete(path: string): Promise<TestResponse>;
  /** Sends a body exactly as given, for requests JSON serialization cannot express. */
  postRaw(path: string, payload: string, contentType: string): Promise<TestResponse>;
  /** A client presenting this session token on every request. */
  withSession(token: string): TestClient;
  /** A client sending this exact `Authorization` header on every request. */
  withAuthorization(value: string): TestClient;
  /** A client whose requests arrive from this remote address. */
  fromAddress(address: string): TestClient;
}

export interface TestServer {
  /** The only supported way to exercise the system in a test. */
  client: TestClient;
  /** For arranging fixtures and asserting on database-level guarantees. */
  database: Database;
  /** Arranges a User account. Accounts are provisioned, never self-registered. */
  createAccount(credentials: Credentials): Promise<void>;
  /** Authenticates through the API and returns a client carrying the session. */
  signIn(credentials: Credentials): Promise<TestClient>;
}

function connectionString(database: string): string {
  const { host, port, user, password } = inject("postgres");
  return toConnectionString({ host, port, user, password, database });
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
}

function buildClient(app: FastifyInstance, identity: ClientIdentity = { headers: {} }): TestClient {
  const { headers, remoteAddress } = identity;
  const request = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    payload?: Payload,
  ): Promise<TestResponse> => {
    const response = await app.inject({
      method,
      url: path,
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
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body === undefined ? undefined : { json: body }),
    delete: (path) => request("DELETE", path),
    postRaw: (path, raw, contentType) => request("POST", path, { raw, contentType }),
    withSession: (token) =>
      buildClient(app, { ...identity, headers: { ...headers, authorization: `Bearer ${token}` } }),
    withAuthorization: (value) =>
      buildClient(app, { ...identity, headers: { ...headers, authorization: value } }),
    fromAddress: (address) => buildClient(app, { ...identity, remoteAddress: address }),
  };
}

export interface TestServerOptions {
  /** Replaces the default limit so a test can exceed it in a few requests. */
  rateLimit?: RateLimit;
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
export function useTestServer({ rateLimit }: TestServerOptions = {}): () => TestServer {
  let context: TestServer;
  let app: FastifyInstance;
  let pool: Database;
  let databaseName: string;

  beforeEach(async () => {
    const { templateDatabase } = inject("postgres");
    databaseName = `test_${randomUUID().replaceAll("-", "")}`;

    await withAdminConnection(async (admin) => {
      await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE "${templateDatabase}"`);
    });

    pool = createPool(connectionString(databaseName));
    app = buildServer({
      database: pool,
      logLevel: "silent",
      ...(rateLimit === undefined ? {} : { rateLimit }),
    });
    await app.ready();

    const client = buildClient(app);
    context = {
      client,
      database: pool,
      createAccount: async (credentials) => {
        await createUserAccount(pool, credentials);
      },
      signIn: async (credentials) => {
        const response = await client.post("/session", credentials);
        const token = (response.body as { token?: unknown } | undefined)?.token;
        if (response.status !== 201 || typeof token !== "string") {
          throw new Error(`signIn expected a session but received status ${response.status}`);
        }
        return client.withSession(token);
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

    await withAdminConnection(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    });
  });

  return () => context;
}
