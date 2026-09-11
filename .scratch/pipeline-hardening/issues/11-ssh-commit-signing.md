# 11: SSH commit signing

**What to build:** Commits are cryptographically signed with an SSH key and show as Verified on GitHub, with signing confirmed working locally **before** ticket 12 makes it mandatory.

Anyone can set any name and email in git config, so on a public repository an unsigned commit proves nothing about who wrote it. Signing closes that gap and completes the chain the rest of this effort builds: a signed commit, on a protected branch, producing an attested build.

SSH signing rather than GPG — an existing SSH key, three config values, one key registered on the account. No keyring, no expiry, no subkey confusion.

**This ticket has a step only the repository owner can perform:** generating or nominating a key and registering it on their GitHub account. Do not attempt to work around it.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] A signing key exists locally and is registered on the GitHub account with **signing** scope (a key registered only for authentication does not count).
- [x] Git is configured with `gpg.format=ssh`, `user.signingkey`, and `commit.gpgsign=true`.
- [x] A test commit is pushed and confirmed to display as Verified on GitHub.
- [x] The setup is documented so it can be reproduced on another machine.
- [x] Confirmed working before ticket 12 begins — this is the ordering that prevents a lockout.

---

**Note:** the failure mode here is specific. Enable the protection rule before signing works and the next push is rejected, with no remedy except turning the rule back off. Verify first.

## Comments

**2026-09-11 — local half done; one owner-only step remains.**

Local configuration is complete and every commit on this branch is signed.

No SSH key existed on this machine, so a dedicated one was generated rather than an existing key being reused:

```
~/.ssh/id_ed25519_signing
SHA256:RJFsjTIpmSca/YW7bJiYWkJ7CkiajoRmiiWznFGuYMI (ED25519)
```

It has no passphrase, so signing never prompts. That is the usual trade for commit signing — a passphrase means either a prompt per commit or an agent to hold the key — but it does mean the private key protects only as well as the filesystem does. Adding a passphrase later is `ssh-keygen -p -f ~/.ssh/id_ed25519_signing` and does not invalidate anything already signed.

Git config, set `--local` so signing here does not change how unrelated repositories behave:

```
gpg.format = ssh
user.signingkey = C:/Users/Ashley/.ssh/id_ed25519_signing.pub
commit.gpgsign = true
tag.gpgsign = true
gpg.ssh.allowedSignersFile = C:/Users/Ashley/.ssh/allowed_signers
```

`allowedSignersFile` is beyond the ticket's three values and worth having: GitHub verifies against keys it knows, but git verifies against that file, and without it `git log --show-signature` reports every signature as being from an unknown signer even when GitHub shows Verified.

Reproduction instructions are in `docs/commit-signing.md`, including the authentication-versus-signing scope distinction that is the most common way this silently fails.

**Remaining, and only the repository owner can do it.** Register the public key at <https://github.com/settings/ssh/new> with **Key type** set to **Signing Key**:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC/gMN6dCangbxmMB1oDDTtLgFdKoCiRl7KLPx7I7jud rndn.shly@gmail.com (schoolgrid signing)
```

An Authentication Key registration does not count; commits signed by an auth-only key show as Unverified. Then push and confirm the Verified badge. The `gh` token in use holds `gist`, `read:org`, `repo` and `workflow`, not `admin:ssh_signing_key`, so this cannot be automated from here without widening the token — which would be the wrong trade for a one-time action.

**Ticket 12 must not begin until that badge is confirmed.** This is the ordering the ticket warns about: require signed commits before signing verifies, and the next push is rejected with no remedy but disabling the rule.

**2026-09-11 — key registered; signing verified end to end.**

The owner-only step is done, and the whole chain now checks out.

The key is registered on the account with **signing** scope. Confirmed through the
public signing-keys endpoint rather than by eye, because that endpoint lists
signing keys only — an authentication-scope registration would not appear there,
which settles the distinction this ticket warns about:

```
$ gh api users/aszeffs/ssh_signing_keys
[{"id":1170083,"key":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC/gMN6dCangbxmMB1oDDTtLgFdKoCiRl7KLPx7I7jud","title":"SchoolGrid"}]
```

GitHub reports the pushed commits as verified:

```
958edb2  verified=true  reason=valid
04dcfe9  verified=true  reason=valid
cec05da  verified=true  reason=valid
```

No separate test commit was needed. The branch's existing commits were already
signed by this key, so registering it verified them retroactively — GitHub
evaluates the signature against the key at read time, not at push time.

Locally, `git log --show-signature` reports a good signature against the
allowed-signers file for every commit on the branch, so both verifiers agree.

**Ticket 12 is unblocked on this axis.** The ordering hazard is cleared: signing
verifies before any rule requires it, so enabling the signed-commits rule cannot
lock the repository out.

---

**Migrated to GitHub issue #21** (https://github.com/aszeffs/SchoolGrid/issues/21). That issue is the source of truth; this file is kept as a record.
