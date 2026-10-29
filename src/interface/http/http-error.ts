/** Standard error body for every endpoint (one shape, stable codes). */
export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; details?: unknown };
  correlationId: string;
}

/**
 * An HTTP-level outcome raised by controllers (e.g. 409 idempotency conflict,
 * 403 provider mismatch). Rendered by the exception filter.
 */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function errorBody(
  correlationId: string,
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
): ErrorBody {
  return {
    error: details === undefined ? { code, message, retryable } : { code, message, retryable, details },
    correlationId,
  };
}
