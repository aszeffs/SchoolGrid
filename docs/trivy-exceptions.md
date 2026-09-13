# Trivy exceptions

The container workflow fails on HIGH and CRITICAL findings in the built image
and on HIGH and CRITICAL misconfigurations in the `Dockerfile`. Sometimes a
finding cannot be fixed here: the vulnerable package comes from the base image,
no patched version exists yet, and waiting for one means the pipeline is red
until someone else ships a release.

That situation is normal rather than a mistake, and it has three possible
responses. Two of them are wrong.

Lowering the threshold to CRITICAL retires the whole middle band, where most
genuinely exploitable issues live, to get around one finding. Setting
`ignore-unfixed` drops exactly the class of finding this process exists for:
the ones with no fix available. Both trade a permanent loss of coverage for a
temporary inconvenience, and neither leaves a record that a decision was taken.

The third is to record an exception: narrow to one finding, justified in
writing, and dated so it comes back.

## Recording one

Exceptions live in `.trivyignore.yaml` at the repository root. Each entry
carries three fields:

```yaml
vulnerabilities:
  - id: CVE-2025-0001
    statement: >-
      Reachable only through a code path this service does not call. No patched
      version of the distroless base exists; upstream issue #123.
    expired_at: 2026-03-01
```

`id` is the finding exactly as Trivy reports it. Misconfigurations go under a
`misconfigurations:` key using their check id, such as `DS-0002`.

`statement` is why the finding cannot be fixed here. It is read by whoever
picks the exception up at expiry, which will often be you having forgotten the
details. A useful one says what the exposure actually is and what has to happen
elsewhere before the entry can go. `wontfix` and `not exploitable` say neither.

`expired_at` is when the decision is revisited, at most 180 days out. Trivy
stops honouring the entry that day, so the finding reappears and the build goes
red. A forgotten exception therefore reopens the gate rather than quietly
holding it shut, which is the behaviour worth having.

## What enforces this

Trivy itself enforces only the expiry. An entry with no `statement` and no
`expired_at` is honoured indefinitely, and that entry is indistinguishable from
the gate being switched off for one finding, forever, by someone who left no
record of why.

`scripts/check-trivy-exceptions.mjs` is what closes that. It runs in the
container workflow before Trivy does, and fails the build if any entry is
missing a justification, missing an expiry, already expired, or dated further
out than the review horizon. It also refuses any line of the file it does not
recognise, rather than skipping it: a section this check quietly ignored while
Trivy honoured it would be the hole all over again.

Its own tests are in `tests/trivy-exceptions.test.ts`.

## When an exception expires

The build goes red and names the finding. Three honest outcomes:

- **The finding is gone.** Delete the entry.
- **It is fixed upstream.** Bump the base image digest, which Dependabot
  usually has a pull request open for already, and delete the entry.
- **It is still unfixable.** Renew it, with the justification rewritten against
  what is true now rather than copied forward. The rewrite is the review; a
  renewal that only moves the date has skipped it.
