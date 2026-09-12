/**
 * Errors that carry an intended HTTP status. Services throw these; the error
 * middleware is the only place that turns them into a response, so no route
 * handler has to know about status codes.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message, "NOT_FOUND");
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message, "BAD_REQUEST");
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message, "CONFLICT");
  }
}
