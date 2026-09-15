/**
 * Thrown by a handler whose caller was authorized but sent a request that
 * cannot be carried out: a missing field, a value of the wrong kind, bounds in
 * the wrong order. The server-wide error handler answers it `invalid_request`.
 *
 * Only ever thrown after the Access decision, never before it. A body is the
 * caller's own, so saying it was wrong reveals nothing to them; but answering
 * it ahead of the decision would give a caller who may not act at all a
 * response different from the refusal, and confirm that the route exists.
 */
export class InvalidRequest extends Error {
  readonly statusCode = 400;

  constructor(detail: string) {
    super(`invalid request: ${detail}`);
  }
}
