import type { Request, Response } from 'express';

import { sessionManager } from '../sessions';
import { AppError } from '../utils/app-error';
import { sendSuccess } from '../utils/api-response';
import { toSessionView } from '../utils/session-view';

function getSessionId(request: Request): string {
  const sessionId = request.params.id;

  return Array.isArray(sessionId) ? sessionId[0] : sessionId;
}

export function createSession(request: Request, response: Response): void {
  const session = sessionManager.create({
    workspaceId: request.body.workspaceId,
    connectionId: request.body.connectionId
  });

  sendSuccess(response, 201, toSessionView(session));
}

export function listSessions(_request: Request, response: Response): void {
  sendSuccess(response, 200, sessionManager.list().map(toSessionView));
}

export function getSession(request: Request, response: Response): void {
  const session = sessionManager.get(getSessionId(request));

  if (!session) {
    throw new AppError('Session not found', 404);
  }

  sendSuccess(response, 200, toSessionView(session));
}

export function getSessionQr(request: Request, response: Response): void {
  const session = sessionManager.get(getSessionId(request));

  if (!session) {
    throw new AppError('Session not found', 404);
  }

  if (!session.qr) {
    throw new AppError('QR not available', 409);
  }

  sendSuccess(response, 200, {
    id: session.id,
    qr: session.qr
  });
}

export async function deleteSession(request: Request, response: Response): Promise<void> {
  const deleted = await sessionManager.delete(getSessionId(request));

  if (!deleted) {
    throw new AppError('Session not found', 404);
  }

  sendSuccess(response, 200, toSessionView(deleted));
}

export async function reconnectSession(request: Request, response: Response): Promise<void> {
  const restarted = await sessionManager.restart(getSessionId(request));

  if (!restarted) {
    throw new AppError('Session not found', 404);
  }

  sendSuccess(response, 200, toSessionView(restarted));
}
