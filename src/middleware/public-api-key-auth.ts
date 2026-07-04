import type { NextFunction, Request, Response } from 'express';

import { apiKeyService, type ApiKeyRecord } from '../services/public/api-key-service';
import { sendPublicError } from '../utils/public-api-response';

export interface PublicApiKeyContext {
  apiKey: ApiKeyRecord;
  workspaceId: string;
}

function readBearerToken(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return readBearerToken(value[0]);
  }

  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function requirePublicApiKeyAuth(request: Request, response: Response, next: NextFunction): Promise<void> {
  const rawKey = readBearerToken(request.header('authorization'));

  if (!rawKey) {
    void sendPublicError(response, 401, 'Missing API key');
    return;
  }

  try {
    const apiKey = await apiKeyService.validateKey(rawKey);

    if (!apiKey) {
      void sendPublicError(response, 401, 'Invalid or disabled API key');
      return;
    }

    response.locals.publicApiKey = {
      apiKey,
      workspaceId: apiKey.workspace_id
    } satisfies PublicApiKeyContext;

    next();
  } catch (error) {
    void sendPublicError(response, 401, 'Invalid or disabled API key');
  }
}
