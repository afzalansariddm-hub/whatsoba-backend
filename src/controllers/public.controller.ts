import type { Request, Response } from 'express';

import { messageService } from '../services/message.service';
import { apiKeyService } from '../services/public/api-key-service';
import { sessionManager } from '../sessions';
import { AppError } from '../utils/app-error';
import { sendPublicError, sendPublicSuccess } from '../utils/public-api-response';

function normalizePhoneToJid(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  if (!digits) {
    throw new AppError('phone is required', 400);
  }

  return `${digits}@s.whatsapp.net`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readWorkspaceIdFromRequest(request: Request): string {
  const body = request.body as Record<string, unknown> | undefined;
  const workspaceId =
    readString(body?.workspaceId) ??
    readString(body?.workspace_id) ??
    readString(request.query.workspaceId);

  if (!workspaceId) {
    throw new AppError('workspaceId is required', 400);
  }

  return workspaceId;
}

function toStatusCode(error: unknown): number {
  if (error instanceof AppError) {
    return error.statusCode;
  }

  return 500;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Internal server error';
}

export async function createApiKey(request: Request, response: Response): Promise<void> {
  try {
    const workspaceId = readWorkspaceIdFromRequest(request);
    const name = readString(request.body?.name);
    const createdBy = readString(request.body?.createdBy) ?? readString(request.header('x-user-id'));

    const result = await apiKeyService.generateKey({
      workspaceId,
      name,
      createdBy
    });

    if (result.created && result.apiKey) {
      sendPublicSuccess(response, 201, 'API key generated successfully.', {
        apiKey: result.apiKey
      });
      return;
    }

    sendPublicSuccess(response, 200, 'API key already exists.', {
      key: {
        id: result.record.id,
        workspaceId: result.record.workspace_id,
        name: result.record.name,
        prefix: result.record.prefix,
        status: result.record.status,
        createdAt: result.record.created_at,
        lastUsedAt: result.record.last_used_at,
        createdBy: result.record.created_by
      }
    });
  } catch (error) {
    sendPublicError(response, toStatusCode(error), toErrorMessage(error));
  }
}

export async function sendTextMessage(request: Request, response: Response): Promise<void> {
  try {
    const auth = response.locals.publicApiKey as { workspaceId?: string } | undefined;
    const workspaceId = auth?.workspaceId;
    const phone = readString(request.body?.phone);
    const message = readString(request.body?.message);

    if (!workspaceId) {
      throw new AppError('Workspace context is missing', 401);
    }

    if (!phone) {
      throw new AppError('phone is required', 400);
    }

    if (!message) {
      throw new AppError('message is required', 400);
    }

    const session = sessionManager
      .list(workspaceId)
      .find((item) => item.status === 'CONNECTED');

    if (!session) {
      throw new AppError('No connected WhatsApp session found for this workspace', 409);
    }

    const chatId = normalizePhoneToJid(phone);
    const result = await messageService.sendText({
      connectionId: session.connectionId,
      chatId,
      text: message
    });

    sendPublicSuccess(response, 200, 'Message queued successfully.', {
      messageId: result.messageId
    });
  } catch (error) {
    sendPublicError(response, toStatusCode(error), toErrorMessage(error));
  }
}
