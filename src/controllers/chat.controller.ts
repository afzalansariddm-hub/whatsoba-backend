import type { Request, Response } from 'express';

import { AppError } from '../utils/app-error';
import { sendSuccess } from '../utils/api-response';
import { chatService } from '../services/api';
import { parseApiContext, parseChatJid, parseChatListFilters, parseChatMessageFilters, parseConnectionId } from '../services/api/query';

export async function listChats(request: Request, response: Response): Promise<void> {
  const data = await chatService.listChats(parseChatListFilters(request));
  sendSuccess(response, 200, data);
}

export async function getChat(request: Request, response: Response): Promise<void> {
  const { workspaceId } = parseApiContext(request);
  const data = await chatService.getChat(workspaceId, parseConnectionId(request), parseChatJid(request));

  if (!data) {
    throw new AppError('Chat not found', 404);
  }

  sendSuccess(response, 200, data);
}

export async function getChatMessages(request: Request, response: Response): Promise<void> {
  const data = await chatService.listMessages(parseChatMessageFilters(request));
  sendSuccess(response, 200, data);
}
