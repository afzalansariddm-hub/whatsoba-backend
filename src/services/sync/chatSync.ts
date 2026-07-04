import type { SupabaseClient } from '@supabase/supabase-js';

import { logger } from '../../config/logger';
import { SUPABASE_SYNC_TABLES } from '../../config/supabase';
import type { SyncChatLike, SyncContext } from './types';

interface ChatRow {
  session_id: string;
  workspace_id: string;
  connection_id: string;
  chat_id: string;
  jid: string;
  name: string | null;
  subject: string | null;
  unread_count: number | null;
  archived: boolean | null;
  pinned: boolean | null;
  read_only: boolean | null;
  is_group: boolean | null;
  mute_end_time: number | null;
  conversation_timestamp: string | null;
  metadata: Record<string, unknown>;
  synced_at: string;
}

interface SyncResult {
  successCount: number;
  failureCount: number;
}

function now(): string {
  return new Date().toISOString();
}

function getChatId(chat: SyncChatLike): string | null {
  return chat.jid ?? chat.id ?? null;
}

function normalizeTimestamp(value: number | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'number') {
    return new Date(value * 1000).toISOString();
  }

  return null;
}

function toChatRow(context: SyncContext, chat: SyncChatLike): ChatRow | null {
  const chatId = getChatId(chat);

  if (!chatId) {
    return null;
  }

  const metadata = { ...chat };

  return {
    session_id: context.sessionId,
    workspace_id: context.workspaceId,
    connection_id: context.connectionId,
    chat_id: chatId,
    jid: chatId,
    name: chat.name ?? chat.subject ?? null,
    subject: chat.subject ?? null,
    unread_count: typeof chat.unreadCount === 'number' ? chat.unreadCount : null,
    archived: typeof chat.archived === 'boolean' ? chat.archived : null,
    pinned: typeof chat.pinned === 'boolean' ? chat.pinned : chat.pinned === undefined ? null : Boolean(chat.pinned),
    read_only: typeof chat.readOnly === 'boolean' ? chat.readOnly : null,
    is_group: typeof chat.isGroup === 'boolean' ? chat.isGroup : null,
    mute_end_time: typeof chat.muteEndTime === 'number' ? chat.muteEndTime : null,
    conversation_timestamp: normalizeTimestamp(chat.conversationTimestamp ?? null),
    metadata,
    synced_at: now()
  };
}

async function upsertChat(supabase: SupabaseClient, row: ChatRow): Promise<void> {
  const { error } = await supabase.from(SUPABASE_SYNC_TABLES.conversations).upsert(row, {
    onConflict: 'session_id,chat_id'
  });

  if (error) {
    throw error;
  }
}

export async function syncChats(
  supabase: SupabaseClient,
  context: SyncContext,
  chats: SyncChatLike[]
): Promise<SyncResult> {
  let successCount = 0;
  let failureCount = 0;

  for (const chat of chats) {
    const row = toChatRow(context, chat);

    if (!row) {
      failureCount += 1;
      continue;
    }

    try {
      await upsertChat(supabase, row);
      successCount += 1;
    } catch (error) {
      failureCount += 1;
      logger.warn(
        {
          sessionId: context.sessionId,
          chatId: row.chat_id,
          err: error
        },
        'chat sync failed'
      );
    }
  }

  return {
    successCount,
    failureCount
  };
}
