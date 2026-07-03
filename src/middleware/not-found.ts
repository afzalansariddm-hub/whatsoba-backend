import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../utils/app-error';

export function notFound(_request: Request, _response: Response, next: NextFunction): void {
  next(new AppError('Route not found', 404));
}
