import type { FastifyInstance } from "fastify";
import type { BuildInfo } from "../config.ts";

/**
 * Serves what the running service was built from, for the web app's "How this
 * was built" page and for anyone checking the image a deployment runs.
 *
 * It needs no session: the commit and digest are public, and name nothing in
 * any School. A value the service was not given is left out, never filled in,
 * so a caller cannot mistake a placeholder for something to verify.
 */
export function registerBuildInfoRoute(api: FastifyInstance, { commit, digest }: BuildInfo): void {
  const body = {
    ...(commit === undefined ? {} : { commit }),
    ...(digest === undefined ? {} : { digest }),
  };
  api.get("/build-info", async (_request, reply) => reply.status(200).send(body));
}
