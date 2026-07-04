import type { SupabaseClient } from '@supabase/supabase-js';

import { logger } from '../../../config/logger';
import { SUPABASE_SYNC_TABLES } from '../../../config/supabase';
import type { SyncChatLike, SyncContext } from '../types';
import type { BulkUpsertResult } from './types';
import { dedupeByKey, nowIso, normalizeJid } from './utils';

export interface ConversationRecord {
  id: string;
  workspace_id: string;
  connection_id: string;
  chat_jid: string;
  contact_id: string | null;
  last_message: string | null;
  last_message_type: string | null;
  last_message_at: string | null;
  unread_count: number;
  is_group: boolean;
  is_archived: boolean;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConversationSummaryInput {
  chat_jid: string;
  last_message: string | null;
  last_message_type: string | null;
  last_message_at: string | null;
  unread_count?: number | null;
  is_group?: boolean | null;
  is_archived?: boolean | null;
  is_pinned?: boolean | null;
}

export interface ConversationWriteStats {
  inputCount: number;
  validCount: number;
  duplicateCount: number;
  existingCount: number;
  persistedCount: number;
  invalidCount: number;
  createdCount: number;
  updatedCount: number;
}

export interface ConversationWriteResult extends Omit<BulkUpsertResult<ConversationRecord>, 'stats'> {
  stats: ConversationWriteStats;
}

interface ConversationRow {
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

type ConversationInsertRow = Omit<ConversationRow, 'unread_count' | 'is_group' | 'is_archived' | 'is_pinned'> & {
  unread_count: number | null;
  is_group: boolean | null;
  is_archived: boolean | null;
  is_pinned: boolean | null;
};

type ConversationSnapshot = Pick<
  ConversationRecord,
  | 'id'
  | 'chat_jid'
  | 'contact_id'
  | 'last_message'
  | 'last_message_type'
  | 'last_message_at'
  | 'unread_count'
  | 'is_group'
  | 'is_archived'
  | 'is_pinned'
  | 'created_at'
>;

function toIsoDate(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return null;
}

function extractLastMessage(chat: SyncChatLike): { lastMessage: string | null; lastMessageType: string | null; lastMessageAt: string | null } {
  const rawLastMessage = chat.lastMessage as
    | {
        conversation?: string;
        extendedTextMessage?: { text?: string };
        messageTimestamp?: number | null;
        [key: string]: unknown;
      }
    | undefined;

  if (rawLastMessage) {
    if (typeof rawLastMessage.conversation === 'string' && rawLastMessage.conversation.trim().length > 0) {
      return {
        lastMessage: rawLastMessage.conversation.trim(),
        lastMessageType: 'conversation',
        lastMessageAt: toIsoDate(rawLastMessage.messageTimestamp)
      };
    }

    if (typeof rawLastMessage.extendedTextMessage?.text === 'string' && rawLastMessage.extendedTextMessage.text.trim().length > 0) {
      return {
        lastMessage: rawLastMessage.extendedTextMessage.text.trim(),
        lastMessageType: 'extendedTextMessage',
        lastMessageAt: toIsoDate(rawLastMessage.messageTimestamp)
      };
    }
  }

  const fallbackTimestamp = chat.conversationTimestamp ?? null;

  return {
    lastMessage: null,
    lastMessageType: null,
    lastMessageAt: toIsoDate(fallbackTimestamp)
  };
}

export function ensureConversationRowDefaults(
  row: ConversationInsertRow,
  now: string = nowIso()
): { row: ConversationRow; defaultedFields: string[] } {
  const defaultedFields: string[] = [];
  const normalized: ConversationRow = { ...row };

  if (normalized.unread_count === null || normalized.unread_count === undefined) {
    normalized.unread_count = 0;
    defaultedFields.push('unread_count');
  }

  if (normalized.is_group === null || normalized.is_group === undefined) {
    normalized.is_group = false;
    defaultedFields.push('is_group');
  }

  if (normalized.is_archived === null || normalized.is_archived === undefined) {
    normalized.is_archived = false;
    defaultedFields.push('is_archived');
  }

  if (normalized.is_pinned === null || normalized.is_pinned === undefined) {
    normalized.is_pinned = false;
    defaultedFields.push('is_pinned');
  }

  if (!normalized.created_at) {
    normalized.created_at = now;
    defaultedFields.push('created_at');
  }

  if (!normalized.updated_at) {
    normalized.updated_at = now;
    defaultedFields.push('updated_at');
  }

  return {
    row: normalized,
    defaultedFields
  };
}

function toConversationRow(
  context: SyncContext,
  chat: SyncChatLike,
  contactId: string | null,
  now: string
): ConversationRow | null {
  const chatJid = normalizeJid(chat.jid ?? chat.id);

  if (!chatJid) {
    return null;
  }

  const lastMessage = extractLastMessage(chat);

  return {
    workspace_id: context.workspaceId,
    connection_id: context.connectionId,
    chat_jid: chatJid,
    contact_id: contactId,
    last_message: lastMessage.lastMessage,
    last_message_type: lastMessage.lastMessageType,
    last_message_at: lastMessage.lastMessageAt,
    unread_count: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
    is_group: typeof chat.isGroup === 'boolean' ? chat.isGroup : false,
    is_archived: typeof chat.archived === 'boolean' ? chat.archived : false,
    is_pinned: typeof chat.pinned === 'boolean' ? chat.pinned : false,
    created_at: now,
    updated_at: now
  };
}

function createRepoLogger(context: SyncContext) {
  return logger.child({
    module: 'conversation-repository',
    syncId: context.syncId ?? 'unknown',
    sessionId: context.sessionId,
    workspaceId: context.workspaceId,
    connectionId: context.connectionId
  });
}

async function fetchExistingConversations(
  supabase: SupabaseClient,
  context: SyncContext,
  chatJids: string[]
): Promise<Map<string, { id: string; created_at: string }>> {
  if (chatJids.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from(SUPABASE_SYNC_TABLES.conversations)
    .select('id,chat_jid,created_at')
    .eq('workspace_id', context.workspaceId)
    .eq('connection_id', context.connectionId)
    .in('chat_jid', chatJids);

  if (error) {
    throw error;
  }

  return new Map(
    (data ?? []).flatMap((row) => {
      const chatJid = normalizeJid((row as { chat_jid?: string | null }).chat_jid);

      return chatJid ? [[chatJid, { id: String((row as { id?: string | number }).id), created_at: String((row as { created_at?: string }).created_at ?? nowIso()) }]] : [];
    })
  );
}

async function fetchExistingConversationSnapshots(
  supabase: SupabaseClient,
  context: SyncContext,
  chatJids: string[]
): Promise<Map<string, ConversationSnapshot>> {
  if (chatJids.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from(SUPABASE_SYNC_TABLES.conversations)
    .select('id,chat_jid,contact_id,last_message,last_message_type,last_message_at,unread_count,is_group,is_archived,is_pinned,created_at')
    .eq('workspace_id', context.workspaceId)
    .eq('connection_id', context.connectionId)
    .in('chat_jid', chatJids);

  if (error) {
    throw error;
  }

  return new Map(
    (data ?? []).flatMap((row) => {
      const chatJid = normalizeJid((row as { chat_jid?: string | null }).chat_jid);

      if (!chatJid) {
        return [];
      }

      const snapshot: ConversationSnapshot = {
        id: String((row as { id?: string | number }).id),
        chat_jid: chatJid,
        contact_id: (row as { contact_id?: string | null }).contact_id ?? null,
        last_message: (row as { last_message?: string | null }).last_message ?? null,
        last_message_type: (row as { last_message_type?: string | null }).last_message_type ?? null,
        last_message_at: (row as { last_message_at?: string | null }).last_message_at ?? null,
        unread_count: (row as { unread_count?: number | null }).unread_count ?? null,
        is_group: (row as { is_group?: boolean | null }).is_group ?? null,
        is_archived: (row as { is_archived?: boolean | null }).is_archived ?? null,
        is_pinned: (row as { is_pinned?: boolean | null }).is_pinned ?? null,
        created_at: String((row as { created_at?: string }).created_at ?? nowIso())
      };

      return [[chatJid, snapshot]];
    })
  );
}

async function fetchContactIds(
  supabase: SupabaseClient,
  context: SyncContext,
  chatJids: string[]
): Promise<Map<string, string>> {
  if (chatJids.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from(SUPABASE_SYNC_TABLES.contacts)
    .select('jid,id')
    .eq('workspace_id', context.workspaceId)
    .eq('connection_id', context.connectionId)
    .in('jid', chatJids);

  if (error) {
    throw error;
  }

  return new Map(
    (data ?? []).flatMap((row) => {
      const jid = normalizeJid((row as { jid?: string | null }).jid);

      return jid ? [[jid, String((row as { id?: string | number }).id)]] : [];
    })
  );
}

function upsertConversationRows(
  supabase: SupabaseClient,
  rows: ConversationRow[],
  existingByChatJid: Map<string, { id: string; created_at: string }>
): Promise<ConversationWriteResult> {
  if (rows.length === 0) {
    return Promise.resolve({
      stats: {
        inputCount: 0,
        validCount: 0,
        duplicateCount: 0,
        existingCount: existingByChatJid.size,
        persistedCount: 0,
        invalidCount: 0,
        createdCount: 0,
        updatedCount: 0
      },
      records: [],
      byKey: new Map()
    });
  }

  const now = nowIso();
  const payload = rows.map((row) => {
    const existing = existingByChatJid.get(row.chat_jid);

    return {
      ...row,
      created_at: existing?.created_at ?? row.created_at,
      updated_at: now
    };
  });

  return (async () => {
    const { data, error } = await supabase
      .from(SUPABASE_SYNC_TABLES.conversations)
      .upsert(payload, {
        onConflict: 'workspace_id,connection_id,chat_jid'
      })
      .select('id,workspace_id,connection_id,chat_jid,contact_id,last_message,last_message_type,last_message_at,unread_count,is_group,is_archived,is_pinned,created_at,updated_at');

    if (error) {
      throw error;
    }

    const records = (data ?? []).map((row) => row as ConversationRecord);
    const updatedCount = Math.min(existingByChatJid.size, rows.length);
    const createdCount = Math.max(rows.length - updatedCount, 0);

    return {
      stats: {
        inputCount: rows.length,
        validCount: rows.length,
        duplicateCount: 0,
        existingCount: existingByChatJid.size,
        persistedCount: records.length,
        invalidCount: 0,
        createdCount,
        updatedCount
      },
      records,
      byKey: new Map(records.map((record) => [normalizeJid(record.chat_jid) ?? record.chat_jid, record]))
    };
  })();
}

export class ConversationRepository {
  public constructor(private readonly supabaseClient: SupabaseClient) {}

  public async countByScope(workspaceId: string, connectionId?: string): Promise<number> {
    const query = this.supabaseClient
      .from(SUPABASE_SYNC_TABLES.conversations)
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId);

    const scopedQuery = connectionId ? query.eq('connection_id', connectionId) : query;
    const { count, error } = await scopedQuery;

    if (error) {
      throw error;
    }

    return count ?? 0;
  }

  public async bulkUpsert(
    context: SyncContext,
    chats: SyncChatLike[],
    contactIdByJid: Map<string, string> = new Map()
  ): Promise<ConversationWriteResult> {
    const repoLogger = createRepoLogger(context);
    const { records: dedupedChats, duplicateCount } = dedupeByKey(chats, (chat) => normalizeJid(chat.jid ?? chat.id));
    const now = nowIso();
    const chatJids = dedupedChats
      .map((chat) => normalizeJid(chat.jid ?? chat.id))
      .filter((value): value is string => value !== null);
    const missingContactJids = chatJids.filter((jid) => !contactIdByJid.has(jid));
    const fetchedContactIds = await fetchContactIds(this.supabaseClient, context, missingContactJids);
    const resolvedContactIds = new Map<string, string>([
      ...Array.from(contactIdByJid.entries()),
      ...Array.from(fetchedContactIds.entries())
    ]);
    const rows = dedupedChats
      .map((chat) => {
        const chatJid = normalizeJid(chat.jid ?? chat.id);

        if (!chatJid) {
          return null;
        }

        return toConversationRow(context, chat, resolvedContactIds.get(chatJid) ?? null, now);
      })
      .filter((row): row is ConversationRow => row !== null);
    const invalidCount = dedupedChats.length - rows.length;
    const normalizedRows = rows.map((row) => ensureConversationRowDefaults(row, now));
    const rowsFixed = normalizedRows.filter(({ defaultedFields }) => defaultedFields.length > 0).length;
    const fieldsDefaulted = Array.from(new Set(normalizedRows.flatMap(({ defaultedFields }) => defaultedFields)));
    const existingByChatJid = await fetchExistingConversations(
      this.supabaseClient,
      context,
      normalizedRows.map(({ row }) => row.chat_jid)
    );

    repoLogger.info(
      {
        rowsReceived: chats.length,
        rowsDeduped: dedupedChats.length,
        rowsValid: normalizedRows.length,
        rowsSkipped: duplicateCount + invalidCount,
        rowsFixed,
        fieldsDefaulted,
        rowsExisting: existingByChatJid.size
      },
      'ConversationRepository rows received'
    );

    let result: ConversationWriteResult;

    try {
      result = await upsertConversationRows(
        this.supabaseClient,
        normalizedRows.map(({ row }) => row),
        existingByChatJid
      );
    } catch (error) {
      repoLogger.error(
        {
          err: error,
          rowsReceived: chats.length,
          rowsValid: normalizedRows.length,
          rowsSkipped: duplicateCount + invalidCount
        },
        'ConversationRepository Supabase errors'
      );
      throw error;
    }

    repoLogger.info(
      {
        rowsInserted: result.stats.createdCount,
        rowsUpdated: result.stats.updatedCount,
        rowsSkipped: duplicateCount + invalidCount,
        persistedCount: result.stats.persistedCount
      },
      'ConversationRepository Supabase result'
    );

    return {
      stats: {
        inputCount: chats.length,
        validCount: normalizedRows.length,
        duplicateCount,
        existingCount: existingByChatJid.size,
        persistedCount: result.records.length,
        invalidCount,
        createdCount: result.stats.createdCount,
        updatedCount: result.stats.updatedCount
      },
      records: result.records,
      byKey: result.byKey
    };
  }

  public async bulkUpsertSummaries(
    context: SyncContext,
    summaries: ConversationSummaryInput[]
  ): Promise<ConversationWriteResult> {
    const repoLogger = createRepoLogger(context);
    const { records: dedupedSummaries, duplicateCount } = dedupeByKey(summaries, (summary) => normalizeJid(summary.chat_jid));
    const chatJids = dedupedSummaries.map((summary) => normalizeJid(summary.chat_jid)).filter((value): value is string => value !== null);
    const existingSnapshots = await fetchExistingConversationSnapshots(this.supabaseClient, context, chatJids);
    const existingByChatJid = new Map(
      Array.from(existingSnapshots.entries()).map(([chatJid, snapshot]) => [chatJid, { id: snapshot.id, created_at: snapshot.created_at }])
    );
    const now = nowIso();

    const rows = dedupedSummaries
      .map((summary) => {
        const chatJid = normalizeJid(summary.chat_jid);

        if (!chatJid) {
          return null;
        }

        const existing = existingSnapshots.get(chatJid);

        return {
          workspace_id: context.workspaceId,
          connection_id: context.connectionId,
          chat_jid: chatJid,
          contact_id: existing?.contact_id ?? null,
          last_message: summary.last_message ?? existing?.last_message ?? null,
          last_message_type: summary.last_message_type ?? existing?.last_message_type ?? null,
          last_message_at: summary.last_message_at ?? existing?.last_message_at ?? null,
          unread_count: summary.unread_count ?? existing?.unread_count ?? 0,
          is_group: summary.is_group ?? existing?.is_group ?? false,
          is_archived: summary.is_archived ?? existing?.is_archived ?? false,
          is_pinned: summary.is_pinned ?? existing?.is_pinned ?? false,
          created_at: existing?.created_at ?? now,
          updated_at: now
        } satisfies ConversationInsertRow;
      })
      .filter((row): row is ConversationInsertRow => row !== null);
    const normalizedRows = rows.map((row) => ensureConversationRowDefaults(row, now));
    const rowsFixed = normalizedRows.filter(({ defaultedFields }) => defaultedFields.length > 0).length;
    const fieldsDefaulted = Array.from(new Set(normalizedRows.flatMap(({ defaultedFields }) => defaultedFields)));

    if (normalizedRows.length === 0) {
      repoLogger.info(
        {
          rowsReceived: summaries.length,
          rowsValid: 0,
          rowsInserted: 0,
          rowsUpdated: 0,
          rowsSkipped: duplicateCount + dedupedSummaries.length,
          persistedCount: 0,
          rowsFixed,
          fieldsDefaulted
        },
        'ConversationRepository rows received'
      );
      return {
        stats: {
          inputCount: summaries.length,
          validCount: 0,
          duplicateCount,
          existingCount: existingSnapshots.size,
          persistedCount: 0,
          invalidCount: dedupedSummaries.length,
          createdCount: 0,
          updatedCount: 0
        },
        records: [],
        byKey: new Map()
      };
    }

    repoLogger.info(
      {
        rowsReceived: summaries.length,
        rowsDeduped: dedupedSummaries.length,
        rowsValid: normalizedRows.length,
        rowsSkipped: duplicateCount + (dedupedSummaries.length - normalizedRows.length),
        rowsFixed,
        fieldsDefaulted,
        rowsExisting: existingByChatJid.size
      },
      'ConversationRepository rows received'
    );

    let result: ConversationWriteResult;

    try {
      result = await upsertConversationRows(
        this.supabaseClient,
        normalizedRows.map(({ row }) => row),
        existingByChatJid
      );
    } catch (error) {
      repoLogger.error(
        {
          err: error,
          rowsReceived: summaries.length,
          rowsValid: normalizedRows.length,
          rowsSkipped: duplicateCount + (dedupedSummaries.length - normalizedRows.length)
        },
        'ConversationRepository Supabase errors'
      );
      throw error;
    }

    repoLogger.info(
      {
        rowsInserted: result.stats.createdCount,
        rowsUpdated: result.stats.updatedCount,
        rowsSkipped: duplicateCount + (dedupedSummaries.length - rows.length),
        persistedCount: result.stats.persistedCount
      },
      'ConversationRepository Supabase result'
    );

    return {
      stats: {
        inputCount: summaries.length,
        validCount: normalizedRows.length,
        duplicateCount,
        existingCount: existingByChatJid.size,
        persistedCount: result.records.length,
        invalidCount: dedupedSummaries.length - normalizedRows.length,
        createdCount: result.stats.createdCount,
        updatedCount: result.stats.updatedCount
      },
      records: result.records,
      byKey: result.byKey
    };
  }
}

export function createConversationRepository(supabaseClient: SupabaseClient): ConversationRepository {
  return new ConversationRepository(supabaseClient);
}
