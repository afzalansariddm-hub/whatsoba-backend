import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../utils/app-error';

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }

  return value.trim();
}

export function validateSendTextMessage(request: Request, _response: Response, next: NextFunction): void {
  try {
    const connectionId = requireString(request.body.connectionId, 'connectionId');
    const chatId = requireString(request.body.chatId, 'chatId');
    const text = requireString(request.body.text, 'text');

    request.body.connectionId = connectionId;
    request.body.chatId = chatId;
    request.body.text = text;
    next();
  } catch (error) {
    next(error);
  }
}
