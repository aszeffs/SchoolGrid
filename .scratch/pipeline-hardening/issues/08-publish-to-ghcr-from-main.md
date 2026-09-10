# 08: Publish to GHCR from main

**What to build:** Images are pushed to GitHub Container Registry on merges to `main`, tagged with the commit SHA and `latest`, and the package is public.

Publishing only from `main` means nothing unreviewed reaches the registry. Tagging by commit SHA is what makes a running image traceable back to the source that produced it — `latest` alone cannot answer "what is actually deployed".

The package is public so that the provenance and SBOM attestations from ticket 09 are verifiable by someone other than the maintainer. A private package makes the entire attestation chain unverifiable by its intended audience, which defeats the purpose. The image is a distroless build of an open-source application and holds no secrets.

**Blocked by:** 06, 07.

**Status:** ready-for-agent

- [ ] Images push to GHCR only on merges to `main`; pull requests still build without pushing.
- [ ] Each image is tagged with the full commit SHA, and `latest` is updated.
- [ ] Publication happens only after the Trivy scan and smoke test have passed.
- [ ] The push job uses the workflow's `GITHUB_TOKEN` with `packages: write` granted to that job alone, not the whole workflow.
- [ ] The package is set to public visibility.
- [ ] The published image is confirmed pullable and runnable by an unauthenticated user.
