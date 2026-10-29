import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  InvalidCursorError,
  NotFoundError,
  TransientDatabaseError,
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import { type LoggerPort, UnauthenticatedError } from '../../application/ports/system';
import { LOGGER } from '../../bootstrap/tokens';
import { correlationIdOf } from './correlation-id.middleware';
import { errorBody, HttpProblem } from './http-error';

interface Mapped {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

/**
 * Single error → HTTP mapping, consistent across endpoints, so a provider can
 * decide on retry from the status alone:
 * 400 invalid payload · 401/403 auth · 404 unknown resource · 409 idempotency
 * or uniqueness conflict · 422 business rejection · 503 transient (retryable,
 * Retry-After) · 500 anything else (no internals leaked).
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: LoggerPort) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const correlationId = correlationIdOf(req);
    const m = this.map(exception);
    if (m.status >= 500 && m.status !== 503) {
      this.logger.error(
        {
          correlationId,
          err:
            exception instanceof Error
              ? { name: exception.name, message: exception.message, stack: exception.stack }
              : String(exception),
        },
        'unhandled error',
      );
    } else if (m.status === 503) {
      this.logger.warn(
        { correlationId, err: exception instanceof Error ? exception.message : String(exception) },
        'transient failure',
      );
    }
    if (m.status === 503) res.setHeader('Retry-After', '1');
    res.status(m.status).json(errorBody(correlationId, m.code, m.message, m.retryable, m.details));
  }

  private map(e: unknown): Mapped {
    if (e instanceof HttpProblem)
      return { status: e.status, code: e.code, message: e.message, retryable: e.retryable, details: e.details };
    if (e instanceof ValidationError)
      return { status: 400, code: 'VALIDATION_ERROR', message: e.message, retryable: false, details: e.details };
    if (e instanceof InvalidCursorError) return { status: 400, code: e.code, message: e.message, retryable: false };
    if (e instanceof UnauthenticatedError)
      return { status: 401, code: 'UNAUTHORIZED', message: e.message, retryable: false };
    if (e instanceof NotFoundError) return { status: 404, code: e.code, message: e.message, retryable: false };
    if (e instanceof WalletAlreadyExistsError)
      return { status: 409, code: e.code, message: e.message, retryable: false };
    if (e instanceof TransientInfrastructureError || e instanceof TransientDatabaseError) {
      return {
        status: 503,
        code: 'TRANSIENT_FAILURE',
        message: 'Temporary infrastructure failure, retry later',
        retryable: true,
      };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      if (status === 404) return { status, code: 'ROUTE_NOT_FOUND', message: 'Route not found', retryable: false };
      if (status === 400 || status === 413 || status === 415) {
        return {
          status: status === 400 ? 400 : status,
          code: 'VALIDATION_ERROR',
          message: 'Malformed request body',
          retryable: false,
        };
      }
      if (status < 500) return { status, code: 'HTTP_ERROR', message: e.message, retryable: false };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error', retryable: false };
  }
}
