import type { Request, Response } from 'express';

import { AppError } from '../utils/app-error';
import { sendSuccess } from '../utils/api-response';
import { contactService } from '../services/api';
import { parseApiContext, parseContactConversationsFilters, parseContactId, parseContactListFilters, parseContactMessagesFilters } from '../services/api/query';

export async function listContacts(request: Request, response: Response): Promise<void> {
  const data = await contactService.listContacts(parseContactListFilters(request));
  sendSuccess(response, 200, data);
}

export async function getContact(request: Request, response: Response): Promise<void> {
  const { workspaceId } = parseApiContext(request);
  const contact = await contactService.getContact(workspaceId, parseContactId(request));

  if (!contact) {
    throw new AppError('Contact not found', 404);
  }

  sendSuccess(response, 200, contact);
}

export async function listContactConversations(request: Request, response: Response): Promise<void> {
  const data = await contactService.listContactConversations(parseContactConversationsFilters(request));
  sendSuccess(response, 200, data);
}

export async function listContactMessages(request: Request, response: Response): Promise<void> {
  const data = await contactService.listContactMessages(parseContactMessagesFilters(request));
  sendSuccess(response, 200, data);
}
