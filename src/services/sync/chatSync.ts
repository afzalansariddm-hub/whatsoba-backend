import type { SupabaseClient } from '@supabase/supabase-js';

import { logger } from '../../config/logger';
import { SUPABASE_SYNC_TABLES } from '../../config/supabase';
import type { SyncChatLike, SyncContext } from './types';
import { ensureConversationRowDefaults } from './repositories/conversation-repository';

interface ChatRow {
  workspace_id: string;
  connection_id: string;
  chat_jid: string;
  contact_id: string | null;
  last_message: string | null;
  last_message_type: string | null;
  last_message_at: string | null;
  unread_count: number | null;
  is_group: boolean | null;
  is_archived: boolean | null;
  is_pinned: boolean | null;
  created_at: string;
  updated_at: string;
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

  const lastMessage = typeof chat.lastMessage === 'object' && chat.lastMessage !== null ? (chat.lastMessage as { conversation?: string; extendedTextMessage?: { text?: string }; messageTimestamp?: number | null }) : null;
  const lastMessageText =
    typeof lastMessage?.conversation === 'string'
      ? lastMessage.conversation
      : typeof lastMessage?.extendedTextMessage?.text === 'string'
        ? lastMessage.extendedTextMessage.text
        : null;
  const lastMessageAt = lastMessage?.messageTimestamp ? new Date(lastMessage.messageTimestamp * 1000).toISOString() : null;
  const currentTime = now();

  return {
    workspace_id: context.workspaceId,
    connection_id: context.connectionId,
    chat_jid: chatId,
    contact_id: null,
    last_message: lastMessageText,
    last_message_type:
      typeof lastMessage?.conversation === 'string'
        ? 'conversation'
        : typeof lastMessage?.extendedTextMessage?.text === 'string'
          ? 'extendedTextMessage'
          : null,
    last_message_at: lastMessageAt,
    unread_count: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
    is_group: typeof chat.isGroup === 'boolean' ? chat.isGroup : false,
    is_archived: typeof chat.archived === 'boolean' ? chat.archived : false,
    is_pinned: typeof chat.pinned === 'boolean' ? chat.pinned : false,
    created_at: currentTime,
    updated_at: currentTime
  };
}

async function upsertChat(supabase: SupabaseClient, row: ChatRow): Promise<void> {
  const { error } = await supabase.from(SUPABASE_SYNC_TABLES.conversations).upsert(ensureConversationRowDefaults(row).row, {
    onConflict: 'workspace_id,connection_id,chat_jid'
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
          chatId: row.chat_jid,
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
