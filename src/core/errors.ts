/** Errors with a Russian user-facing message and an HTTP status. */
export class ServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export class BadRequestError extends ServiceError {
  constructor(message: string) {
    super(400, message);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends ServiceError {
  constructor(message: string) {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ServiceError {
  constructor(message: string) {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/** Malformed request (wrong types, unknown enum values...). */
export class ValidationError extends ServiceError {
  constructor(message: string) {
    super(422, message);
    this.name = "ValidationError";
  }
}

export class TooManyRequestsError extends ServiceError {
  constructor(message = "Слишком много запросов. Попробуйте через минуту.") {
    super(429, message);
    this.name = "TooManyRequestsError";
  }
}
