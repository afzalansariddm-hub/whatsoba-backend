import type { SupabaseClient } from '@supabase/supabase-js';

import { logger } from '../../config/logger';
import { SUPABASE_SYNC_TABLES } from '../../config/supabase';
import type { SyncContext, SyncMessageLike } from './types';

interface MessageRow {
  session_id: string;
  workspace_id: string;
  connection_id: string;
  message_id: string;
  chat_id: string;
  sender_id: string | null;
  timestamp: string;
  message_type: string;
  text: string | null;
  from_me: boolean | null;
  direction: 'inbound' | 'outbound';
  status: string;
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

function getMessageId(message: SyncMessageLike): string | null {
  return message.key?.id ?? null;
}

function getChatId(message: SyncMessageLike): string | null {
  return message.key?.remoteJid ?? null;
}

function getSenderId(message: SyncMessageLike): string | null {
  return message.key?.participant ?? null;
}

function getMessageText(message: SyncMessageLike): string | null {
  if (typeof message.message?.conversation === 'string' && message.message.conversation.length > 0) {
    return message.message.conversation;
  }

  const extendedText = message.message?.extendedTextMessage?.text;

  if (typeof extendedText === 'string' && extendedText.length > 0) {
    return extendedText;
  }

  return null;
}

function getMessageType(message: SyncMessageLike): string {
  if (typeof message.message?.conversation === 'string' && message.message.conversation.length > 0) {
    return 'conversation';
  }

  if (typeof message.message?.extendedTextMessage?.text === 'string' && message.message.extendedTextMessage.text.length > 0) {
    return 'extendedTextMessage';
  }

  return 'unknown';
}

function normalizeTimestamp(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return now();
  }

  return new Date(value * 1000).toISOString();
}

function toMessageRow(context: SyncContext, message: SyncMessageLike): MessageRow | null {
  const messageId = getMessageId(message);
  const chatId = getChatId(message);

  if (!messageId || !chatId) {
    return null;
  }

  const fromMe = typeof message.key?.fromMe === 'boolean' ? message.key.fromMe : null;
  const direction: 'inbound' | 'outbound' = fromMe ? 'outbound' : 'inbound';
  const metadata = { ...message };

  return {
    session_id: context.sessionId,
    workspace_id: context.workspaceId,
    connection_id: context.connectionId,
    message_id: messageId,
    chat_id: chatId,
    sender_id: getSenderId(message),
    timestamp: normalizeTimestamp(message.messageTimestamp),
    message_type: getMessageType(message),
    text: getMessageText(message),
    from_me: fromMe,
    direction,
    status: direction === 'outbound' ? 'SENT' : 'RECEIVED',
    metadata,
    synced_at: now()
  };
}

async function upsertMessage(supabase: SupabaseClient, row: MessageRow): Promise<void> {
  const { error } = await supabase.from(SUPABASE_SYNC_TABLES.messages).upsert(row, {
    onConflict: 'session_id,message_id'
  });

  if (error) {
    throw error;
  }
}

export async function syncRecentMessages(
  supabase: SupabaseClient,
  context: SyncContext,
  messages: SyncMessageLike[]
): Promise<SyncResult> {
  let successCount = 0;
  let failureCount = 0;

  for (const message of messages) {
    const row = toMessageRow(context, message);

    if (!row) {
      failureCount += 1;
      continue;
    }

    try {
      await upsertMessage(supabase, row);
      successCount += 1;
    } catch (error) {
      failureCount += 1;
      logger.warn(
        {
          sessionId: context.sessionId,
          chatId: row.chat_id,
          messageId: row.message_id,
          err: error
        },
        'message sync failed'
      );
    }
  }

  return {
    successCount,
    failureCount
  };
}
