# Production runs the image CI verified

SchoolGrid is deployed to Vercel, and production runs the exact container image `main` published: its provenance is verified in CI, and it is deployed by digest, never by tag and never rebuilt. We rejected letting Vercel build the service from Git, the obvious path on Vercel, because the distroless image, the Trivy scan, the smoke test, and the signed provenance would all describe an artifact production does not run. The value of those controls is the claim "what runs is what was checked", and a rebuild breaks it silently.

## Consequences

- Deploys come only from the container workflow on `main`, after verification. Vercel's Git integration deploys nothing, and there are no preview deployments.
- If Vercel's Hobby plan cannot run container images, the fallback is to build the Vercel output in GitHub Actions, attest that output, and deploy it prebuilt. That keeps "built and attested in CI" but gives up the image scan and smoke test describing production. It is a fallback, not an equal: it is taken only if the image path is impossible.
- CI migrates the database, with the same verified image, before it deploys. The running service holds only the least-privilege runtime role and never migrates in production; started without owner credentials it refuses to serve an unmigrated database.
- Production holds invented demo data only, and a scheduled job in the same protected environment resets it by dropping the schema, migrating, and seeding. The reset first reads the digest production runs and re-verifies it, so it never migrates past what is deployed. Dropping the schema deletes Audit records; that exception is confined to the demo database.
- Do not "simplify" the deployment by connecting Vercel to the repository. It works, and it discards the property this record exists for.
