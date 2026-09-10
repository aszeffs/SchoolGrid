# Commit signing

Every commit on this repository is signed with an SSH key and shows as Verified
on GitHub. Branch protection on `main` and `dev` requires it, so an unsigned
commit cannot be pushed or merged.

Anyone can set any name and email in `git config`. On a public repository an
unsigned commit therefore proves nothing about who wrote it. Signing closes
that gap, and completes the chain the rest of the pipeline builds: a signed
commit, on a protected branch, producing an attested build.

SSH rather than GPG: one existing key, three config values, one registration.
No keyring, no expiry, no subkeys.

## Setting this up on a new machine

### 1. Nominate or generate a signing key

Reuse an existing SSH key, or generate one dedicated to signing:

```bash
ssh-keygen -t ed25519 -C "you@example.com (schoolgrid signing)" -f ~/.ssh/id_ed25519_signing
```

A passphrase is optional. Without one, signing never prompts; with one, add the
key to `ssh-agent` so it prompts once per session rather than once per commit.

### 2. Register the key on GitHub with signing scope

Go to <https://github.com/settings/ssh/new>, set **Key type** to
**Signing Key**, and paste the contents of `~/.ssh/id_ed25519_signing.pub`.

A key registered only as an Authentication Key does not count. GitHub keeps the
two scopes separate, and a commit signed by an authentication-only key shows as
Unverified. If the same key is used for both, register it twice, once under
each type.

### 3. Point git at the key

```bash
git config --local gpg.format ssh
git config --local user.signingkey ~/.ssh/id_ed25519_signing.pub
git config --local commit.gpgsign true
git config --local tag.gpgsign true
```

These are set per repository rather than globally, so signing here does not
change how you commit to unrelated repositories. Use `--global` instead if you
want it everywhere.

### 4. Allow local verification

GitHub verifies signatures from the keys it knows about. Git verifies against a
local allowed-signers file, which is what makes `git log --show-signature`
useful offline:

```bash
printf '%s %s\n' "you@example.com" "$(cat ~/.ssh/id_ed25519_signing.pub)" \
  >> ~/.ssh/allowed_signers
git config --local gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
```

The email on the left must match `user.email` for the commit, or git reports
the signature as being from an unknown signer.

## Verifying it works

Locally, `Good "git" signature` is the string to look for:

```bash
git log --show-signature -1
```

On GitHub, push the commit and look for the **Verified** badge next to it.

Verify signing works **before** branch protection requires it. Enabling the
rule first means the next push is rejected, with no remedy except turning the
rule back off.

## Troubleshooting

**Unverified on GitHub, good signature locally.** The key is registered for
authentication but not signing, or the commit's email is not one of the
verified addresses on the account.

**`gpg failed to sign the data`.** `gpg.format` is not set to `ssh`, so git is
looking for GPG. Check with `git config --get gpg.format`.

**`No principal matched`.** The allowed-signers file has no entry for the
commit's email address. This affects local verification only, never GitHub's.
