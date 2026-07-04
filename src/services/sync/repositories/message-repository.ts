import type { SupabaseClient } from '@supabase/supabase-js';

import { logger } from '../../../config/logger';
import { SUPABASE_SYNC_TABLES } from '../../../config/supabase';
import type { SyncContext, SyncMessageLike } from '../types';
import { ensureConversationRowDefaults, type ConversationRecord, type ConversationSummaryInput } from './conversation-repository';
import type { BulkUpsertResult } from './types';
import { dedupeByKey, nowIso, normalizeJid, normalizeKey } from './utils';

export interface MessageRecord {
  id: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  sender_jid: string | null;
  recipient_jid: string | null;
  direction: 'inbound' | 'outbound';
  message_type: string;
  text: string | null;
  media_url: string | null;
  status: string;
  timestamp: string;
  created_at: string;
}

export interface MessageStatusUpdateInput {
  chatJid: string;
  messageId: string;
  status: string;
  timestamp?: string | null;
}

interface MessageRow {
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  sender_jid: string | null;
  recipient_jid: string | null;
  direction: 'inbound' | 'outbound';
  message_type: string;
  text: string | null;
  media_url: string | null;
  status: string;
  timestamp: string;
  created_at: string;
}

function now(): string {
  return nowIso();
}

function createRepoLogger(context: SyncContext) {
  return logger.child({
    module: 'message-repository',
    syncId: context.syncId ?? 'unknown',
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
    connectionId: context.connectionId
  });
}

function buildMessageKey(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
}

function getMessageId(message: SyncMessageLike): string | null {
  return normalizeKey(message.key?.id);
}

function getChatJid(message: SyncMessageLike): string | null {
  return normalizeJid(message.key?.remoteJid);
}

function getSenderJid(context: SyncContext, message: SyncMessageLike, chatJid: string): string | null {
  if (message.key?.fromMe) {
    return normalizeJid(context.phone ?? null);
  }

  return normalizeJid(message.key?.participant ?? chatJid);
}

function getMessageText(message: SyncMessageLike): string | null {
  if (typeof message.message?.conversation === 'string' && message.message.conversation.trim().length > 0) {
    return message.message.conversation.trim();
  }

  if (typeof message.message?.extendedTextMessage?.text === 'string' && message.message.extendedTextMessage.text.trim().length > 0) {
    return message.message.extendedTextMessage.text.trim();
  }

  return null;
}

function getMessageType(message: SyncMessageLike): string {
  const payload = message.message as Record<string, unknown> | undefined;

  if (typeof message.message?.conversation === 'string' && message.message.conversation.trim().length > 0) {
    return 'conversation';
  }

  if (typeof message.message?.extendedTextMessage?.text === 'string' && message.message.extendedTextMessage.text.trim().length > 0) {
    return 'extendedTextMessage';
  }

  if (payload?.imageMessage) {
    return 'imageMessage';
  }

  if (payload?.videoMessage) {
    return 'videoMessage';
  }

  if (payload?.audioMessage || payload?.pttMessage) {
    return 'voiceMessage';
  }

  if (payload?.documentMessage) {
    return 'documentMessage';
  }

  if (payload?.stickerMessage) {
    return 'stickerMessage';
  }

  if (payload?.locationMessage) {
    return 'locationMessage';
  }

  if (payload?.contactMessage) {
    return 'contactMessage';
  }

  if (payload?.reactionMessage) {
    return 'reactionMessage';
  }

  return 'unknown';
}

function getMediaUrl(message: SyncMessageLike): string | null {
  const payload = message.message as Record<string, unknown> | undefined;

  if (!payload) {
    return null;
  }

  const possibleKeys = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

  for (const key of possibleKeys) {
    const value = payload[key] as Record<string, unknown> | undefined;

    if (!value) {
      continue;
    }

    const directUrl = value.url;
    const directPath = value.directPath;

    if (typeof directUrl === 'string' && directUrl.trim().length > 0) {
      return directUrl.trim();
    }

    if (typeof directPath === 'string' && directPath.trim().length > 0) {
      return directPath.trim();
    }
  }

  return null;
}

function toIsoTimestamp(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return now();
  }

  return new Date(value * 1000).toISOString();
}

function toMessageRow(
  context: SyncContext,
  message: SyncMessageLike,
  conversation: ConversationRecord | undefined
): MessageRow | null {
  const messageId = getMessageId(message);
  const chatJid = getChatJid(message);

  if (!messageId || !chatJid || !conversation) {
    return null;
  }

  const fromMe = Boolean(message.key?.fromMe);
  const direction: 'inbound' | 'outbound' = fromMe ? 'outbound' : 'inbound';
  const timestamp = toIsoTimestamp(message.messageTimestamp);

  return {
    workspace_id: context.workspaceId,
    conversation_id: conversation.id,
    message_id: messageId,
    sender_jid: getSenderJid(context, message, chatJid),
    recipient_jid: chatJid,
    direction,
    message_type: getMessageType(message),
    text: getMessageText(message),
    media_url: getMediaUrl(message),
    status: direction === 'outbound' ? 'SENT' : 'RECEIVED',
    timestamp,
    created_at: timestamp
  };
}

async function fetchExistingMessages(
  supabase: SupabaseClient,
  context: SyncContext,
  rows: Array<Pick<MessageRow, 'conversation_id' | 'message_id'>>
): Promise<Map<string, { created_at: string }>> {
  if (rows.length === 0) {
    return new Map();
  }

  const conversationIds = Array.from(new Set(rows.map((row) => row.conversation_id)));
  const messageIds = Array.from(new Set(rows.map((row) => row.message_id)));
  const expectedKeys = new Set(rows.map((row) => buildMessageKey(row.conversation_id, row.message_id)));
  const { data, error } = await supabase
    .from(SUPABASE_SYNC_TABLES.messages)
    .select('conversation_id,message_id,created_at')
    .eq('workspace_id', context.workspaceId)
    .in('conversation_id', conversationIds)
    .in('message_id', messageIds);

  if (error) {
    throw error;
  }

  return new Map(
    (data ?? []).flatMap((row) => {
      const conversationId = String((row as { conversation_id?: string | null }).conversation_id ?? '');
      const messageId = normalizeKey((row as { message_id?: string | null }).message_id);
      const key = conversationId && messageId ? buildMessageKey(conversationId, messageId) : null;

      if (!key || !expectedKeys.has(key)) {
        return [];
      }

      return [[key, { created_at: String((row as { created_at?: string }).created_at ?? now()) }]];
    })
  );
}

async function fetchConversations(
  supabase: SupabaseClient,
  context: SyncContext,
  chatJids: string[]
): Promise<Map<string, ConversationRecord>> {
  if (chatJids.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from(SUPABASE_SYNC_TABLES.conversations)
    .select('id,workspace_id,connection_id,chat_jid,contact_id,last_message,last_message_type,last_message_at,unread_count,is_group,is_archived,is_pinned,created_at,updated_at')
    .eq('workspace_id', context.workspaceId)
    .eq('connection_id', context.connectionId)
    .in('chat_jid', chatJids);

  if (error) {
    throw error;
  }

  return new Map(
    (data ?? []).flatMap((row) => {
      const conversation = row as ConversationRecord;
      const chatJid = normalizeJid(conversation.chat_jid);

      return chatJid ? [[chatJid, conversation]] : [];
    })
  );
}

export class MessageRepository {
  public constructor(private readonly supabaseClient: SupabaseClient) {}

  public async updateStatuses(
    context: SyncContext,
    updates: MessageStatusUpdateInput[]
  ): Promise<BulkUpsertResult<MessageRecord>> {
    const repoLogger = createRepoLogger(context);
    const dedupedUpdates = uniqueStatuses(updates);
    const chatJids = dedupedUpdates.map((update) => normalizeJid(update.chatJid)).filter((value): value is string => value !== null);
    const conversations = await fetchConversations(this.supabaseClient, context, chatJids);
    const now = nowIso();
    const records: MessageRecord[] = [];
    let updatedCount = 0;

    for (const update of dedupedUpdates) {
      const chatJid = normalizeJid(update.chatJid);
      const conversation = chatJid ? conversations.get(chatJid) : undefined;

      if (!chatJid || !conversation) {
        continue;
      }

      const { data, error } = await this.supabaseClient
        .from(SUPABASE_SYNC_TABLES.messages)
        .update({
          status: update.status,
          updated_at: now
        })
        .eq('workspace_id', context.workspaceId)
        .eq('conversation_id', conversation.id)
        .eq('message_id', normalizeKey(update.messageId))
        .select('id,workspace_id,conversation_id,message_id,sender_jid,recipient_jid,direction,message_type,text,media_url,status,timestamp,created_at');

      if (error) {
        repoLogger.error(
          {
            err: error,
            status: update.status,
            chatJid,
            messageId: update.messageId
          },
          'MessageRepository Supabase errors'
        );
        throw error;
      }

      const rows = (data ?? []).map((row) => row as MessageRecord);
      records.push(...rows);
      updatedCount += rows.length;
    }

    return {
      stats: {
        inputCount: updates.length,
        validCount: dedupedUpdates.length,
        duplicateCount: updates.length - dedupedUpdates.length,
        existingCount: records.length,
        persistedCount: updatedCount,
        invalidCount: 0
      },
      records,
      byKey: new Map(records.map((record) => [record.message_id, record]))
    };
  }

  public async bulkUpsert(
    context: SyncContext,
    messages: SyncMessageLike[],
    conversationByChatJid: Map<string, ConversationRecord> = new Map()
  ): Promise<BulkUpsertResult<MessageRecord> & { conversationSummaries: ConversationSummaryInput[]; conversationCreations: number }> {
    const repoLogger = createRepoLogger(context);
    const { records: dedupedMessages, duplicateCount } = dedupeByKey(messages, (message) => {
      const messageId = normalizeKey(message.key?.id);
      const chatJid = normalizeJid(message.key?.remoteJid);

      if (!messageId || !chatJid) {
        return null;
      }

      return `${chatJid}:${messageId}`;
    });

    const chatJids = dedupedMessages
      .map((message) => normalizeJid(message.key?.remoteJid))
      .filter((value): value is string => value !== null);
    const missingChatJids = chatJids.filter((jid) => !conversationByChatJid.has(jid));
    const fetchedConversations = await fetchConversations(this.supabaseClient, context, missingChatJids);
    const resolvedConversations = new Map<string, ConversationRecord>([
      ...Array.from(conversationByChatJid.entries()),
      ...Array.from(fetchedConversations.entries())
    ]);
    const unresolvedChatJids = chatJids.filter((jid) => !resolvedConversations.has(jid));
    let conversationCreations = 0;

    if (unresolvedChatJids.length > 0) {
      const now = nowIso();
      const placeholders = unresolvedChatJids.map((chatJid) => ({
        workspace_id: context.workspaceId,
        connection_id: context.connectionId,
        chat_jid: chatJid,
        contact_id: null,
        last_message: null,
        last_message_type: null,
        last_message_at: null,
        unread_count: 0,
        is_group: false,
        is_archived: false,
        is_pinned: false,
        created_at: now,
        updated_at: now
      }));
      const normalizedPlaceholders = placeholders.map((row) => ensureConversationRowDefaults(row, now).row);

      const { error } = await this.supabaseClient.from(SUPABASE_SYNC_TABLES.conversations).upsert(normalizedPlaceholders, {
        onConflict: 'workspace_id,connection_id,chat_jid'
      });

      if (error) {
        throw error;
      }

      const createdConversations = await fetchConversations(this.supabaseClient, context, unresolvedChatJids);

      for (const [chatJid, conversation] of createdConversations.entries()) {
        resolvedConversations.set(chatJid, conversation);
      }

      conversationCreations = unresolvedChatJids.length;
    }

    const rows = dedupedMessages
      .map((message) => {
        const chatJid = getChatJid(message);
        const conversation = chatJid ? resolvedConversations.get(chatJid) : undefined;

        return toMessageRow(context, message, conversation);
      })
      .filter((row): row is MessageRow => row !== null);
    const invalidCount = dedupedMessages.length - rows.length;
    const existingByMessageId = await fetchExistingMessages(this.supabaseClient, context, rows);
    const rowsSkipped = duplicateCount + invalidCount;

    repoLogger.info(
      {
        rowsReceived: messages.length,
        rowsDeduped: dedupedMessages.length,
        rowsValid: rows.length,
        rowsSkipped,
        rowsExisting: existingByMessageId.size,
        placeholderConversationCreated: conversationCreations > 0,
        conversationCreations
      },
      'MessageRepository rows received'
    );

    const payload = rows.map((row) => ({
      ...row,
      created_at: existingByMessageId.get(buildMessageKey(row.conversation_id, row.message_id))?.created_at ?? row.created_at
    }));

    if (payload.length === 0) {
      repoLogger.info(
        {
          rowsInserted: 0,
          rowsUpdated: 0,
          rowsSkipped,
          persistedCount: 0,
          placeholderConversationCreated: conversationCreations > 0,
          conversationCreations
        },
        'MessageRepository Supabase result'
      );
      return {
        stats: {
          inputCount: messages.length,
          validCount: 0,
          duplicateCount,
          existingCount: 0,
          persistedCount: 0,
          invalidCount
        },
        records: [],
        byKey: new Map(),
        conversationSummaries: [],
        conversationCreations
      };
    }

    const { data, error } = await this.supabaseClient
      .from(SUPABASE_SYNC_TABLES.messages)
      .upsert(payload, {
        onConflict: 'workspace_id,conversation_id,message_id'
      })
      .select('id,workspace_id,conversation_id,message_id,sender_jid,recipient_jid,direction,message_type,text,media_url,status,timestamp,created_at');

    if (error) {
      repoLogger.error(
        {
          err: error,
          rowsReceived: messages.length,
          rowsValid: rows.length,
          rowsSkipped,
          placeholderConversationCreated: conversationCreations > 0,
          conversationCreations
        },
        'MessageRepository Supabase errors'
      );
      throw error;
    }

    const records = (data ?? []).map((row) => row as MessageRecord);
    const existingCount = existingByMessageId.size;
    const insertedCount = Math.max(rows.length - existingCount, 0);
    const updatedCount = Math.min(existingCount, rows.length);
    repoLogger.info(
      {
        rowsInserted: insertedCount,
        rowsUpdated: updatedCount,
        rowsSkipped,
        persistedCount: records.length,
        placeholderConversationCreated: conversationCreations > 0,
        conversationCreations
      },
      'MessageRepository Supabase result'
    );
    const latestByConversation = new Map<string, MessageRecord>();

    for (const record of records) {
      const current = latestByConversation.get(record.conversation_id);

      if (!current || current.timestamp.localeCompare(record.timestamp) < 0) {
        latestByConversation.set(record.conversation_id, record);
      }
    }

    const conversationSummaries = Array.from(latestByConversation.values()).map((record) => {
      const conversation = Array.from(resolvedConversations.values()).find((item) => item.id === record.conversation_id);
      const chatJid = conversation?.chat_jid ?? record.recipient_jid ?? '';

      return {
        chat_jid: chatJid,
        last_message: record.text ?? record.message_type,
        last_message_type: record.message_type,
        last_message_at: record.timestamp,
        unread_count: conversation?.unread_count ?? null,
        is_group: conversation?.is_group ?? null,
        is_archived: conversation?.is_archived ?? null,
        is_pinned: conversation?.is_pinned ?? null
      } satisfies ConversationSummaryInput;
    });

    return {
      stats: {
        inputCount: messages.length,
        validCount: rows.length,
        duplicateCount,
        existingCount,
        persistedCount: records.length,
        invalidCount
      },
      records,
      byKey: new Map(records.map((record) => [record.message_id, record])),
      conversationSummaries,
      conversationCreations
    };
  }
}

function uniqueStatuses(updates: MessageStatusUpdateInput[]): MessageStatusUpdateInput[] {
  const seen = new Set<string>();

  return updates.filter((update) => {
    const chatJid = normalizeJid(update.chatJid);
    const messageId = normalizeKey(update.messageId);
    const key = chatJid && messageId ? `${chatJid}:${messageId}:${update.status}` : null;

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function createMessageRepository(supabaseClient: SupabaseClient): MessageRepository {
  return new MessageRepository(supabaseClient);
}
