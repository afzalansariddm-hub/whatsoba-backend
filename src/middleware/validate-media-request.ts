import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../utils/app-error';

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }

  return value.trim();
}

export function validateSendMediaMessage(request: Request, _response: Response, next: NextFunction): void {
  try {
    const connectionId = requireString(request.body.connectionId, 'connectionId');
    const chatId = requireString(request.body.chatId, 'chatId');

    if (!request.file) {
      throw new AppError('file is required', 400);
    }

    const caption = typeof request.body.caption === 'string' && request.body.caption.trim().length > 0 ? request.body.caption.trim() : undefined;

    request.body.connectionId = connectionId;
    request.body.chatId = chatId;
    request.body.caption = caption;
    next();
  } catch (error) {
    next(error);
  }
}
