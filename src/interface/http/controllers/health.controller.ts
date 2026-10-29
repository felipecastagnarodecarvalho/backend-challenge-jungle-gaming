import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ReadinessState } from '../../../bootstrap/readiness-state';
import { HEALTH_CHECKER, READINESS_STATE } from '../../../bootstrap/tokens';
import type { HealthChecker } from '../../../infrastructure/health/health-checker';
import { Public } from '../auth/public.decorator';

/** Liveness (process answers) and readiness (DB + SQS reachable, not shutting down). Always unauthenticated. */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HEALTH_CHECKER) private readonly checker: HealthChecker,
    @Inject(READINESS_STATE) private readonly readiness: ReadinessState,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    if (this.readiness.shuttingDown) {
      res.status(503);
      return { status: 'unavailable', reason: 'shutting_down' };
    }
    const report = await this.checker.readiness();
    res.status(report.ready ? 200 : 503);
    return { status: report.ready ? 'ok' : 'unavailable', checks: report.checks };
  }
}
