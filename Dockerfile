# syntax=docker/dockerfile:1

# Base images are pinned by digest for the same reason actions are pinned by
# commit SHA: a tag is a mutable pointer, and `node:24-bookworm` tomorrow is
# not the image that was reviewed today. Dependabot's docker ecosystem keeps
# these current so pinning does not decay into shipping something ancient.

# ---- the build toolchain ---------------------------------------------------
# Named once so the two stages that use it share a digest. Written twice, a
# Dependabot bump would have to change both and could change one.
#
# The Node major here must match the distroless runtime below. Compiled output
# and installed dependencies built on one major and run on another work until a
# dependency or a language feature depends on the difference.
FROM node:24-bookworm@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0 AS node-base

# ---- build -----------------------------------------------------------------
# A full Node image, because compiling needs the toolchain. Nothing from this
# stage reaches the runtime image except the contents of `dist` and the web
# app's `web/dist`: the service compiled, and the web app bundled into static
# files that the service serves.
FROM node-base AS build

WORKDIR /app

# Manifests first, source second. Dependencies change far less often than
# code, so this ordering lets an unchanged lockfile reuse the install layer
# instead of reinstalling on every commit. The web workspace's manifest is part
# of the lockfile's tree, so `npm ci` refuses to install without it.
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# ---- production dependencies -----------------------------------------------
# A second install rather than pruning the first. `npm ci --omit=dev` resolves
# strictly from the lockfile and never sees a dev dependency at all, so the
# tree that ships is derived from the manifest rather than from whatever
# survived a prune.
#
# The web workspace is left out. Everything it is built from is a dev
# dependency, since the bundle already holds what the page runs, and
# `--workspaces=false` keeps npm from linking the workspace itself into
# `node_modules`, where it would point at sources this image does not have.
FROM node-base AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspaces=false

# ---- runtime ---------------------------------------------------------------
# Distroless: no shell, no package manager, nothing to pivot with. The
# `nonroot` tag is load-bearing — the default distroless tag still runs as
# root, so dropping the suffix would silently give away the property this
# stage exists for. It is asserted in CI rather than trusted.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The build output alone, never the workspace: served from memory, resolved
# relative to the compiled entrypoint, which puts it here.
COPY --from=build /app/web/dist ./web/dist
# Resolved at runtime relative to the compiled migrate module, which puts them
# here. The entrypoint applies them on start, so an image without this
# directory boots and then fails at the first query.
COPY migrations ./migrations
# `"type": "module"` lives here. Without it Node reads the compiled output as
# CommonJS and the service does not start.
COPY package.json ./

# Said out loud rather than inherited. The `nonroot` base tag already sets
# this, so the line changes nothing about the image that ships today; what it
# changes is what happens when the base is swapped. A tag edited to a root
# variant would silently give the property away, and this overrides it. It is
# also what Trivy's DS-0002 asks for, and the check is right to ask.
USER nonroot

ENV NODE_ENV=production

EXPOSE 3000

# The distroless entrypoint is already `/nodejs/bin/node`, so this is the
# script it runs, not a command line of its own.
CMD ["dist/index.js"]
