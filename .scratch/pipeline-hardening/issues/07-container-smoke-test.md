# 07: Container smoke test

**What to build:** The built image is actually started, against a real Postgres, and must answer `/health` reporting the database reachable.

This is the only check in the entire pipeline that runs the real process. The test suite drives the application through Fastify's `inject`, which never binds a socket and never executes the entrypoint, and every scanner inspects a filesystem without running anything. So a broken entrypoint, a production dependency that was left in `devDependencies`, or a migration that fails on boot would currently pass everything and surface only on a real deployment.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] A job starts a Postgres service container and runs the built image against it.
- [ ] The job polls `/health` until it returns 200 with the database reported reachable.
- [ ] The job fails on timeout rather than hanging.
- [ ] Migrations are confirmed to have been applied by the container on startup, not by a separate step.
- [ ] The container's logs are surfaced on failure, so a failure is diagnosable from the run alone.
- [ ] The test is demonstrated failing against an image with a deliberately broken entrypoint; evidence recorded here and the change reverted.
