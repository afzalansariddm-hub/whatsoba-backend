import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { logger } from '../config/logger';

export function requestLogger(request: Request, response: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const startedAt = Date.now();

  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);

  const childLogger = logger.child({
    requestId,
    method: request.method,
    path: request.originalUrl
  });

  childLogger.info('request started');

  response.on('finish', () => {
    childLogger.info({
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt
    }, 'request completed');
  });

  next();
}
