# 05: Distroless image and pull request build

**What to build:** A multi-stage Dockerfile producing a runtime image with no shell and no package manager, and a workflow that builds it on every pull request without publishing anything.

The base image choice drives most of the container's CVE count and most of what an attacker can do after achieving code execution. Distroless has no shell to spawn, no package manager to install tooling with, and runs as a non-root user by default. The build stage compiles TypeScript and installs production dependencies; only the compiled output and those dependencies are copied forward, so build tooling and dev dependencies never ship.

Building on pull requests without pushing means a vulnerable image is caught before it exists anywhere.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A multi-stage Dockerfile builds on a full Node image and produces a runtime stage on distroless Node.
- [ ] Only production dependencies and compiled output are present in the runtime stage.
- [ ] The runtime image contains no shell and no package manager, verified rather than assumed.
- [ ] The image runs as a non-root user.
- [ ] The entrypoint runs the compiled service, which applies migrations on start.
- [ ] A `.dockerignore` keeps `node_modules`, `.git`, `.env` and test files out of the build context.
- [ ] A workflow builds the image on pull requests to `dev` and `main` and does not push it.
- [ ] Layer caching is configured so repeat builds do not reinstall unchanged dependencies.
