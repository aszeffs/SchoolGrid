# 02: User account authentication

**What to build:** A caller can authenticate with credentials, carry the resulting session across subsequent requests, and end it explicitly. A caller who fails to authenticate learns nothing from the attempt — a wrong password, an account that does not exist, and a malformed attempt are indistinguishable from one another.

A User account holds credentials and authentication state and nothing else: no roles, no permissions, no academic data, and no reference to any School. Resolving an account to a Person is a later ticket's job; this one stops at "which account, if any, is this request from".

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] A caller can authenticate with valid credentials and receives a session.
- [ ] A session identifies the caller across subsequent requests without re-authenticating.
- [ ] A caller can end their session explicitly, and the ended session grants nothing thereafter.
- [ ] Authenticating with a wrong password, with an unknown account, and with a malformed request produce identical responses, revealing nothing about whether the account exists.
- [ ] An expired or unrecognised session is treated exactly as no session at all.
- [ ] Credentials are stored such that reading the database does not yield them.
- [ ] The account module exposes no operation that returns a role, permission, or School.

---

**Migrated to GitHub issue #4** (https://github.com/aszeffs/SchoolGrid/issues/4). That issue is the source of truth; this file is kept as a record.
