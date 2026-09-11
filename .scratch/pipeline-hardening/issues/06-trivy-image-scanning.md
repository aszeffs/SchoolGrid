# 06: Trivy image scanning

**What to build:** The built image is scanned for known vulnerabilities and the build fails on high or critical findings. Results upload as SARIF so they sit in the Security tab beside the CodeQL findings, rather than being buried in a log.

Trivy also scans the Dockerfile for misconfiguration, which is worth enabling: it catches the hardening mistakes a base-image choice alone does not prevent.

Failing at high rather than critical keeps the middle band — where most genuinely exploitable issues live — inside the gate.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] Trivy scans the image built in ticket 05 on every pull request.
- [ ] The build fails on HIGH and CRITICAL findings.
- [ ] Results upload as SARIF and appear in the Security tab.
- [ ] Dockerfile misconfiguration scanning is enabled.
- [ ] The gate is demonstrated failing against an image with a known high-severity CVE; evidence recorded here and the change reverted.
- [ ] There is a documented way to record an exception for an unfixable finding, with a justification and an expiry date.

---

**Note for the implementer:** a high-severity CVE in a base image with no patched version available is a normal occurrence, not a mistake. Handling it with a justified, expiring exception — rather than lowering the threshold or disabling the gate — is the point of the last criterion.

---

**Migrated to GitHub issue #16** (https://github.com/aszeffs/SchoolGrid/issues/16). That issue is the source of truth; this file is kept as a record.
