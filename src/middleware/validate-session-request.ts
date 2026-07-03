import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../utils/app-error';

const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }

  return value.trim();
}

export function validateCreateSession(request: Request, _response: Response, next: NextFunction): void {
  try {
    const workspaceId = requireString(request.body.workspaceId, 'workspaceId');
    const connectionId = requireString(request.body.connectionId, 'connectionId');

    if (!CONNECTION_ID_PATTERN.test(connectionId)) {
      throw new AppError('connectionId must be 3-128 characters and contain only letters, numbers, hyphens, or underscores', 400);
    }

    request.body.workspaceId = workspaceId;
    request.body.connectionId = connectionId;
    next();
  } catch (error) {
    next(error);
  }
}

export function validateSessionIdParam(request: Request, _response: Response, next: NextFunction): void {
  try {
    const sessionId = requireString(request.params.id, 'id');

    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new AppError('id must be a valid UUID', 400);
    }

    request.params.id = sessionId;
    next();
  } catch (error) {
    next(error);
  }
}
