import type { Request, Response } from 'express';

import { AppError } from '../utils/app-error';
import { sendSuccess } from '../utils/api-response';
import { apiKeyService } from '../services/public/api-key-service';

type WorkspaceSource = {
  workspaceId?: string | null;
  workspace_id?: string | null;
};

type AuthenticatedRequest = Request & {
  user?: WorkspaceSource;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return parsed;
  } catch {
    return null;
  }
}

function readWorkspaceIdFromJwt(request: Request): string | undefined {
  const authorization = request.header('authorization');

  if (!authorization) {
    return undefined;
  }

  const token = authorization.trim().startsWith('Bearer ') ? authorization.trim().slice(7).trim() : authorization.trim();

  if (!token || token.startsWith('sk_live_')) {
    return undefined;
  }

  const parts = token.split('.');

  if (parts.length < 2) {
    return undefined;
  }

  const payload = decodeBase64UrlJson(parts[1]);

  if (!payload) {
    return undefined;
  }

  const direct =
    readString(payload.workspaceId) ??
    readString(payload.workspace_id) ??
    readString(payload.workspace) ??
    readString(payload.wid);

  if (direct) {
    return direct;
  }

  const appMetadata = payload.app_metadata as Record<string, unknown> | undefined;
  const userMetadata = payload.user_metadata as Record<string, unknown> | undefined;

  return (
    readString(appMetadata?.workspaceId) ??
    readString(appMetadata?.workspace_id) ??
    readString(appMetadata?.workspace) ??
    readString(userMetadata?.workspaceId) ??
    readString(userMetadata?.workspace_id) ??
    readString(userMetadata?.workspace)
  );
}

function readWorkspaceId(request: Request): string {
  const authenticatedRequest = request as AuthenticatedRequest;
  const body = request.body as WorkspaceSource | undefined;
  const user = authenticatedRequest.user;
  const localsUser = (request.res?.locals?.user as WorkspaceSource | undefined) ?? undefined;
  const localsAuth = (request.res?.locals?.auth as WorkspaceSource | undefined) ?? undefined;

  const workspaceId =
    readString(user?.workspaceId) ??
    readString(user?.workspace_id) ??
    readString(localsUser?.workspaceId) ??
    readString(localsUser?.workspace_id) ??
    readString(localsAuth?.workspaceId) ??
    readString(localsAuth?.workspace_id) ??
    readWorkspaceIdFromJwt(request) ??
    readString(body?.workspaceId) ??
    readString(body?.workspace_id) ??
    readString(request.query.workspaceId) ??
    readString(request.headers['x-workspace-id']);

  if (!workspaceId) {
    throw new AppError('workspaceId is required', 401);
  }

  return workspaceId;
}

function formatApiKeyResponse(record: {
  name: string;
  prefix: string;
  status: 'active' | 'disabled';
  created_at: string;
  last_used_at: string | null;
}) {
  return {
    name: record.name,
    prefix: 'sk_live_',
    maskedKey: 'sk_live_************************',
    status: record.status,
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at
  };
}

export async function getApiKey(request: Request, response: Response): Promise<void> {
  const workspaceId = readWorkspaceId(request);
  const record = await apiKeyService.getMetadataByWorkspace(workspaceId);

  if (!record) {
    throw new AppError('API key not found', 404);
  }

  sendSuccess(response, 200, formatApiKeyResponse({
    name: record.name,
    prefix: record.prefix,
    status: record.status,
    created_at: record.createdAt,
    last_used_at: record.lastUsedAt
  }));
}

export async function upsertApiKey(request: Request, response: Response): Promise<void> {
  const workspaceId = readWorkspaceId(request);
  const name = readString(request.body?.name);
  const createdBy = readString(request.body?.createdBy) ?? readString(request.header('x-user-id'));

  const result = await apiKeyService.generateKey({
    workspaceId,
    name,
    createdBy
  });

  if (result.created && result.apiKey) {
    sendSuccess(response, 201, {
      apiKey: result.apiKey
    });
    return;
  }

  sendSuccess(response, 200, formatApiKeyResponse({
    name: result.record.name,
    prefix: result.record.prefix,
    status: result.record.status,
    created_at: result.record.created_at,
    last_used_at: result.record.last_used_at
  }));
}
