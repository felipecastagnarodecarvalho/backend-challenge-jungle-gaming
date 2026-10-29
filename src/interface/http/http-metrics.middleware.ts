import type { NextFunction, Request, Response } from 'express';
import type { Histogram } from 'prom-client';

/** Records `wagering_http_request_duration_seconds` labelled by route template (not raw URL: bounded cardinality). */
export function httpMetricsMiddleware(histogram: Histogram<'method' | 'route' | 'status_code'>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    res.on('finish', () => {
      const routePath = (req.route as { path?: string } | undefined)?.path;
      const route = routePath ? `${req.baseUrl ?? ''}${routePath}` : 'unmatched';
      histogram.observe(
        { method: req.method, route, status_code: String(res.statusCode) },
        (performance.now() - started) / 1000,
      );
    });
    next();
  };
}
