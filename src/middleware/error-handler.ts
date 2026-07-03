import type { NextFunction, Request, Response } from 'express';

import { logger } from '../config/logger';
import { AppError } from '../utils/app-error';

export function errorHandler(error: unknown, request: Request, response: Response, _next: NextFunction): void {
  const isMulterError = error instanceof Error && error.name === 'MulterError';
  const appError =
    error instanceof AppError
      ? error
      : isMulterError
        ? new AppError(error.message, (error as { code?: string }).code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        : new AppError('Internal server error');
  const statusCode = appError.statusCode;

  if (statusCode >= 500) {
    logger.error(
      {
        err: error,
        requestId: request.requestId,
        method: request.method,
        path: request.originalUrl
      },
      'unhandled request error'
    );
  }

  response.status(statusCode).json({
    success: false,
    error: {
      message: appError.message
    }
  });
}
