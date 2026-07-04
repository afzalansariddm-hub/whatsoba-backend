import type { Request } from 'express';

import { AppError } from '../../utils/app-error';
import type {
  ApiContext,
  ChatListFilters,
  ChatMessageFilters,
  ContactConversationsFilters,
  ContactListFilters,
  ContactMessagesFilters,
  SortDirection
} from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;

function readRaw(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value) && value.length > 0) {
    return readRaw(value[0]);
  }

  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  const raw = readRaw(value);

  if (!raw) {
    return undefined;
  }

  if (['true', '1', 'yes'].includes(raw.toLowerCase())) {
    return true;
  }

  if (['false', '0', 'no'].includes(raw.toLowerCase())) {
    return false;
  }

  throw new AppError(`Invalid boolean value: ${raw}`, 400);
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const raw = readRaw(value);

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError('limit must be a positive integer', 400);
  }

  return Math.min(parsed, max);
}

function parseOffset(value: unknown): number {
  const raw = readRaw(value);

  if (!raw) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError('offset must be a non-negative integer', 400);
  }

  return parsed;
}

function parseSortDirection(value: unknown, fallback: SortDirection): SortDirection {
  const raw = readRaw(value)?.toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (raw === 'asc' || raw === 'oldest') {
    return 'asc';
  }

  if (raw === 'desc' || raw === 'latest') {
    return 'desc';
  }

  throw new AppError('sort must be one of asc, desc, latest, or oldest', 400);
}

function readWorkspaceId(request: Request): string {
  const raw = readRaw(request.query.workspaceId) ?? readRaw(request.headers['x-workspace-id']);

  if (!raw) {
    throw new AppError('workspaceId is required', 400);
  }

  return raw;
}

function readConnectionId(request: Request): string | undefined {
  return readRaw(request.query.connectionId);
}

function readSearch(request: Request): string | undefined {
  return readRaw(request.query.search);
}

function readJid(request: Request): string {
  const raw = readRaw(request.params.jid);

  if (!raw) {
    throw new AppError('jid is required', 400);
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function readId(request: Request): string {
  const raw = readRaw(request.params.id);

  if (!raw) {
    throw new AppError('id is required', 400);
  }

  return raw;
}

function readCursor(value: unknown): string | undefined {
  const raw = readRaw(value);

  if (!raw) {
    return undefined;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`Invalid cursor timestamp: ${raw}`, 400);
  }

  return parsed.toISOString();
}

export function parseApiContext(request: Request): ApiContext {
  return {
    workspaceId: readWorkspaceId(request)
  };
}

export function parseChatListFilters(request: Request): ChatListFilters {
  const context = parseApiContext(request);
  const latest = parseBoolean(request.query.latest);
  const oldest = parseBoolean(request.query.oldest);
  const sort = parseSortDirection(request.query.sort, latest ? 'desc' : oldest ? 'asc' : 'desc');

  return {
    ...context,
    connectionId: readConnectionId(request),
    search: readSearch(request),
    limit: parseLimit(request.query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    offset: parseOffset(request.query.offset),
    sort,
    unread: parseBoolean(request.query.unread),
    groups: parseBoolean(request.query.groups),
    archived: parseBoolean(request.query.archived),
    pinned: parseBoolean(request.query.pinned)
  };
}

export function parseChatMessageFilters(request: Request): ChatMessageFilters {
  const context = parseApiContext(request);

  const before = readCursor(request.query.before);
  const after = readCursor(request.query.after);

  if (before && after) {
    throw new AppError('before and after cannot be used together', 400);
  }

  return {
    ...context,
    connectionId: readConnectionId(request),
    jid: readJid(request),
    limit: parseLimit(request.query.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT),
    before,
    after
  };
}

export function parseContactListFilters(request: Request): ContactListFilters {
  const context = parseApiContext(request);
  const sort = parseSortDirection(request.query.sort, 'asc');

  return {
    ...context,
    search: readSearch(request),
    limit: parseLimit(request.query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    offset: parseOffset(request.query.offset),
    sort
  };
}

export function parseContactId(request: Request): string {
  return readId(request);
}

export function parseChatJid(request: Request): string {
  return readJid(request);
}

export function parseConnectionId(request: Request): string | undefined {
  return readConnectionId(request);
}

export function parseContactConversationsFilters(request: Request): ContactConversationsFilters {
  const context = parseApiContext(request);
  const sort = parseSortDirection(request.query.sort, 'desc');

  return {
    ...context,
    contactId: parseContactId(request),
    limit: parseLimit(request.query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    offset: parseOffset(request.query.offset),
    sort
  };
}

export function parseContactMessagesFilters(request: Request): ContactMessagesFilters {
  const context = parseApiContext(request);
  const sort = parseSortDirection(request.query.sort, 'desc');

  return {
    ...context,
    contactId: parseContactId(request),
    limit: parseLimit(request.query.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT),
    offset: parseOffset(request.query.offset),
    sort
  };
}
