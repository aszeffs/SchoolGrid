import { describe, expect, it } from "vitest";
import { createUserAccount } from "../src/authentication/index.ts";
import {
  cookieSentBackFor,
  observable,
  useTestServer,
  type TestClient,
  type TestResponse,
} from "./support/harness.ts";

const ALICE = { username: "alice", password: "correct horse battery staple" };

describe("User account authentication", () => {
  const server = useTestServer();

  it("gives a caller with valid credentials a session that identifies their account", async () => {
    await server().createAccount(ALICE);

    const caller = await server().signIn(ALICE);
    const response = await caller.get("/api/session");

    expect(response.status).toBe(200);
    // The Schools, Persons and roles it also names are tests/session.test.ts's.
    expect(response.body).toEqual({ account: { id: expect.any(String), username: "alice" }, schools: [] });
  });

  it("keeps identifying the caller across requests without re-authenticating", async () => {
    await server().createAccount(ALICE);
    const caller = await server().signIn(ALICE);

    const first = await caller.get("/api/session");
    const second = await caller.get("/api/session");

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it("lets a caller end their session, after which it grants nothing", async () => {
    await server().createAccount(ALICE);
    const caller = await server().signIn(ALICE);

    const ended = await caller.delete("/api/session");
    const afterwards = await caller.get("/api/session");
    const anonymous = await server().client.get("/api/session");

    expect(ended.status).toBe(204);
    expect(afterwards.status).toBe(anonymous.status);
    expect(afterwards.raw).toBe(anonymous.raw);
  });

  it("accepts the Bearer scheme in any letter case", async () => {
    await server().createAccount(ALICE);
    const response = await server().client.post("/api/session", { ...ALICE, session: "bearer" });
    const { token } = response.body as { token: string };

    const identify = await server().client.withAuthorization(`bearer ${token}`).get("/api/session");

    expect(identify.status).toBe(200);
  });

  it("treats usernames that differ only by case as the same account", async () => {
    await server().createAccount(ALICE);

    const caller = await server().signIn({ ...ALICE, username: "ALICE" });
    const response = await caller.get("/api/session");

    expect(response.body).toMatchObject({ account: { username: "alice" } });
    await expect(server().createAccount({ ...ALICE, username: "Alice" })).rejects.toThrow();
  });

  // Usernames a person would read as the same are one username: equal after
  // NFKC and case-folding, not merely after lower-casing.
  describe.each([
    ["a precomposed and a combining accent", "rené", "rené"],
    ["a ligature and its letters", "ﬁona", "fiona"],
    ["full-width and ASCII letters", "ａｌｉｃｅ", "alice"],
    ["upper- and lower-case accented letters", "Élodie", "élodie"],
    ["a sharp s and its full case-folding", "straße", "STRASSE"],
  ])("usernames spelled with %s", (_case, stored, lookAlike) => {
    it("cannot be two User accounts", async () => {
      await server().createAccount({ ...ALICE, username: stored });

      await expect(
        server().createAccount({ username: lookAlike, password: "another password entirely" }),
      ).rejects.toThrow();
    });

    it("sign in to the same account whichever spelling is used", async () => {
      const account = await server().createAccount({ ...ALICE, username: stored });

      const caller = await server().signIn({ ...ALICE, username: lookAlike });
      const response = await caller.get("/api/session");

      expect(response.body).toEqual({ account: { id: account.id, username: stored }, schools: [] });
    });
  });

  it("holds credentials and authentication state only: no School, Person, role, or permission", async () => {
    const { rows: columns } = await server().database.query<{ table: string; column: string }>(
      `SELECT table_name AS table, column_name AS column
       FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name IN ('user_account', 'user_session')
       ORDER BY table_name, ordinal_position`,
    );
    const { rows: references } = await server().database.query<{ referenced: string }>(
      `SELECT DISTINCT confrelid::regclass::text AS referenced
       FROM pg_constraint
       WHERE contype = 'f' AND conrelid IN ('app.user_account'::regclass, 'app.user_session'::regclass)`,
    );

    expect(columns).toEqual([
      { table: "user_account", column: "id" },
      { table: "user_account", column: "username" },
      { table: "user_account", column: "password_hash" },
      { table: "user_account", column: "created_at" },
      // Where an account was created and, for a Trial School's role account,
      // which role's it is: provenance, so a Trial School's deletion takes the
      // accounts made in it, and never authorization, which a membership alone
      // grants (ADR-0012).
      { table: "user_account", column: "created_in_school_id" },
      { table: "user_account", column: "trial_role" },
      { table: "user_session", column: "token_hash" },
      { table: "user_session", column: "user_account_id" },
      { table: "user_session", column: "created_at" },
      { table: "user_session", column: "expires_at" },
    ]);
    expect(references.map(({ referenced }) => referenced).sort()).toEqual(["app.school", "app.user_account"]);
  });

  describe("reading the database yields no credentials", () => {
    /** Every row of every table in the app schema, as text. */
    async function dumpAppSchema(): Promise<string> {
      const { database } = server();
      const { rows: tables } = await database.query<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'app'",
      );
      const dumps = await Promise.all(
        tables.map(async ({ name }) => {
          const { rows } = await database.query(
            `SELECT row_to_json(t)::text AS row FROM app."${name}" t`,
          );
          return rows.map((row) => row.row as string).join("\n");
        }),
      );
      return dumps.join("\n");
    }

    /** The ways a secret could be written down without being hashed. */
    function encodings(secret: string): string[] {
      const bytes = Buffer.from(secret);
      return [secret, bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")];
    }

    it("stores neither the password nor a session token, in either form", async () => {
      await server().createAccount(ALICE);
      const bearer = await server().client.post("/api/session", { ...ALICE, session: "bearer" });
      const token = (bearer.body as { token: string }).token;
      const browser = await server().client.withOrigin(server().publicOrigin).post("/api/session", ALICE);
      const cookieToken = cookieSentBackFor(browser).split("=")[1]!;

      const dump = await dumpAppSchema();

      expect(dump).toContain("alice");
      expect(cookieToken).not.toBe("");
      for (const encoded of [...encodings(ALICE.password), ...encodings(token), ...encodings(cookieToken)]) {
        expect(dump).not.toContain(encoded);
      }
    });

    // The harness shares one hash between accounts arranged with the same
    // password, so the two tests below create theirs as the application does.
    it("stores the same password differently for two accounts", async () => {
      await createUserAccount(server().database, ALICE);
      await createUserAccount(server().database, { username: "bob", password: ALICE.password });

      const { rows } = await server().database.query<{ password_hash: string }>(
        "SELECT password_hash FROM app.user_account",
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]!.password_hash).not.toBe(rows[1]!.password_hash);
    });

    it("hashes a password with scrypt at OWASP's cost: N=2^15, r=8, p=3", async () => {
      await createUserAccount(server().database, ALICE);

      const { rows } = await server().database.query<{ password_hash: string }>(
        "SELECT password_hash FROM app.user_account",
      );

      expect(rows[0]!.password_hash).toMatch(/^scrypt\$32768\$8\$3\$[^$]+\$[^$]+$/);
    });
  });

  describe("a session that is not live is treated exactly as no session", () => {
    async function expiredSessionClient(): Promise<TestClient> {
      await server().createAccount(ALICE);
      const caller = await server().signIn(ALICE);
      // Arranging the passage of time: the session's lifetime has run out.
      await server().database.query(
        "UPDATE app.user_session SET expires_at = now() - interval '1 second'",
      );
      return caller;
    }

    it.each([
      ["an expired session", () => expiredSessionClient()],
      ["an unrecognised token", async () => server().client.withBearer("dGhpcyBpcyBpbnZlbnRlZA")],
      ["a malformed token", async () => server().client.withBearer("not a token!")],
      ["a non-bearer scheme", async () => server().client.withAuthorization("Basic YWxpY2U6cHc=")],
    ])("for %s", async (_case, arrange) => {
      const caller = await arrange();

      const anonymous = await server().client.get("/api/session");
      const identify = await caller.get("/api/session");
      const end = await caller.delete("/api/session");
      const anonymousEnd = await server().client.delete("/api/session");

      expect(anonymous.status).not.toBe(200);
      expect(observable(identify)).toEqual(observable(anonymous));
      expect(observable(end)).toEqual(observable(anonymousEnd));
      expect(observable(end)).toEqual(observable(anonymous));
    });

    it("does not revive when its own token is presented again after ending", async () => {
      await server().createAccount(ALICE);
      const caller = await server().signIn(ALICE);
      await caller.delete("/api/session");

      const endedAgain = await caller.delete("/api/session");
      const anonymousEnd = await server().client.delete("/api/session");

      expect(observable(endedAgain)).toEqual(observable(anonymousEnd));
    });
  });

  describe("a failed attempt reveals nothing about why it failed", () => {
    it("answers a wrong password and an unknown account identically", async () => {
      await server().createAccount(ALICE);

      const wrongPassword = await server().client.post("/api/session", {
        username: "alice",
        password: "not the password",
      });
      const unknownAccount = await server().client.post("/api/session", {
        username: "mallory",
        password: "not the password",
      });

      expect(wrongPassword.status).not.toBe(201);
      expect(observable(unknownAccount)).toEqual(observable(wrongPassword));
      expect(wrongPassword.raw).not.toMatch(/token|password|username|account/i);
    });

    it("answers an unknown username that normalisation changes identically to a wrong password", async () => {
      await server().createAccount(ALICE);

      const wrongPassword = await server().client.post("/api/session", {
        username: "alice",
        password: "not the password",
      });
      const unknownLookAlike = await server().client.post("/api/session", {
        // Full-width "Mallory": normalised, it names no account either.
        username: "Ｍａｌｌｏｒｙ",
        password: "not the password",
      });

      expect(observable(unknownLookAlike)).toEqual(observable(wrongPassword));
    });

    it.each([
      ["no body", (c: TestClient) => c.post("/api/session")],
      ["an empty object", (c: TestClient) => c.post("/api/session", {})],
      ["a missing password", (c: TestClient) => c.post("/api/session", { username: "alice" })],
      [
        "a non-string password",
        (c: TestClient) => c.post("/api/session", { username: "alice", password: 1 }),
      ],
      [
        "an empty password",
        (c: TestClient) => c.post("/api/session", { username: "alice", password: "" }),
      ],
      ["an array body", (c: TestClient) => c.post("/api/session", ["alice", "password"])],
      [
        "an oversized password",
        (c: TestClient) => c.post("/api/session", { username: "alice", password: "x".repeat(5000) }),
      ],
      [
        "invalid JSON",
        (c: TestClient) => c.postRaw("/api/session", '{"username": "alice",', "application/json"),
      ],
      [
        "valid credentials under a non-JSON content type",
        (c: TestClient) => c.postRaw("/api/session", JSON.stringify(ALICE), "text/plain"),
      ],
      [
        "form-encoded credentials",
        (c: TestClient) =>
          c.postRaw(
            "/api/session",
            `username=alice&password=${encodeURIComponent(ALICE.password)}`,
            "application/x-www-form-urlencoded",
          ),
      ],
    ])("answers %s identically to a wrong password", async (_case, attempt) => {
      await server().createAccount(ALICE);

      const wrongPassword = await server().client.post("/api/session", {
        username: "alice",
        password: "not the password",
      });
      const malformed = await attempt(server().client);

      expect(observable(malformed)).toEqual(observable(wrongPassword));
    });

    // ADR-0002 addendum: the connection is closed because the unread body cannot
    // stay on the socket. That header reflects only the caller's own request.
    it("answers a body over the server's size limit identically apart from closing the connection", async () => {
      await server().createAccount(ALICE);

      const wrongPassword = await server().client.post("/api/session", {
        username: "alice",
        password: "not the password",
      });
      const oversized = await server().client.postRaw(
        "/api/session",
        JSON.stringify({ username: "alice", password: "x".repeat(2 * 1024 * 1024) }),
        "application/json",
      );

      const apartFromConnection = (response: TestResponse) => {
        const { connection: _connection, ...headers } = observable(response).headers;
        const headerOrder = observable(response).headerOrder.filter((name) => name !== "connection");
        return { ...observable(response), headers, headerOrder };
      };
      expect(oversized.headers.connection).toBe("close");
      expect(apartFromConnection(oversized)).toEqual(apartFromConnection(wrongPassword));
    });
  });
});
