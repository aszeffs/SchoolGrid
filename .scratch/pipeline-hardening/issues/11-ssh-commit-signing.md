# 11: SSH commit signing

**What to build:** Commits are cryptographically signed with an SSH key and show as Verified on GitHub, with signing confirmed working locally **before** ticket 12 makes it mandatory.

Anyone can set any name and email in git config, so on a public repository an unsigned commit proves nothing about who wrote it. Signing closes that gap and completes the chain the rest of this effort builds: a signed commit, on a protected branch, producing an attested build.

SSH signing rather than GPG — an existing SSH key, three config values, one key registered on the account. No keyring, no expiry, no subkey confusion.

**This ticket has a step only the repository owner can perform:** generating or nominating a key and registering it on their GitHub account. Do not attempt to work around it.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A signing key exists locally and is registered on the GitHub account with **signing** scope (a key registered only for authentication does not count).
- [ ] Git is configured with `gpg.format=ssh`, `user.signingkey`, and `commit.gpgsign=true`.
- [ ] A test commit is pushed and confirmed to display as Verified on GitHub.
- [ ] The setup is documented so it can be reproduced on another machine.
- [ ] Confirmed working before ticket 12 begins — this is the ordering that prevents a lockout.

---

**Note:** the failure mode here is specific. Enable the protection rule before signing works and the next push is rejected, with no remedy except turning the rule back off. Verify first.
