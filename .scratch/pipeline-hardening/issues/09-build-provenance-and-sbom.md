# 09: Build provenance and SBOM attestation

**What to build:** Every published image carries a signed SLSA build provenance statement and an SBOM attestation, both verifiable by anyone.

This is the part that separates DevSecOps from running scanners. Scanning tells you an artifact looked clean at some moment. Provenance proves *which commit and which workflow produced this exact image*, so a consumer can tell a legitimate build from one an attacker pushed to the same registry. The SBOM attestation lets them determine what is inside without pulling and unpacking it.

Signing is keyless, using the workflow's OIDC identity. There is no private key to store, leak, or rotate — the identity is the workflow itself.

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] Each published image has a build provenance attestation generated from the workflow's OIDC identity.
- [ ] Each published image has an SBOM attestation describing its contents.
- [ ] `id-token: write` and `attestations: write` are granted to the attesting job only, never at workflow level.
- [ ] No signing key is stored in the repository or in repository secrets.
- [ ] `gh attestation verify` is run against a published image and confirmed to report the expected workflow and commit; the output is recorded here.
- [ ] Verification is confirmed to work for a user who is not the repository owner.
- [ ] The README documents how a consumer verifies an image.
