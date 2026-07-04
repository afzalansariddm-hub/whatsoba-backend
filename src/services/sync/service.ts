import { logger } from '../../config/logger';
import { getSupabaseClient } from '../../config/supabase';
import { emitRealtimeSocketEvent } from '../../socket/session-events';
import { createContactRepository, type ContactRepository } from './repositories/contact-repository';
import { createConversationRepository, type ConversationRecord, type ConversationRepository, type ConversationWriteResult } from './repositories/conversation-repository';
import { createMessageRepository, type MessageRepository, type MessageStatusUpdateInput } from './repositories/message-repository';
import type { BulkUpsertStats } from './repositories/types';
import type { HistorySyncEvent, MessagesUpsertEvent, SyncChatLike, SyncContext, SyncContactLike, SyncMessageLike, SyncRuntime, SyncSocketLike } from './types';
import { normalizeJid } from './repositories/utils';

interface SyncRunStatistics {
  contacts: BulkUpsertStats;
  conversations: BulkUpsertStats;
  messages: BulkUpsertStats;
  conversationSummaries: BulkUpsertStats;
  historyChats: number;
  chatsUpserted: number;
  messagesImported: number;
  contactsImported: number;
  conversationsCreated: number;
  conversationUpdates: number;
  bootstrapUsed: boolean;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

interface SyncSessionState extends SyncContext, SyncRuntime {
  latestStatistics: SyncRunStatistics | null;
  initialHistoryCompleted: boolean;
  historyChatsDiscovered: boolean;
  counters: SyncCounters;
}

interface SyncCounters {
  historyEventsReceived: number;
  historyChats: number;
  chatsDiscovered: number;
  messagesDiscovered: number;
  contactsDiscovered: number;
  chatsUpserted: number;
  messagesImported: number;
  contactsImported: number;
  conversationsCreated: number;
  conversationUpdates: number;
  bootstrapUsed: boolean;
}

const EMPTY_STATS: BulkUpsertStats = {
  inputCount: 0,
  validCount: 0,
  duplicateCount: 0,
  existingCount: 0,
  persistedCount: 0,
  invalidCount: 0
};

function cloneEmptyStats(): BulkUpsertStats {
  return { ...EMPTY_STATS };
}

function nowMs(): number {
  return Date.now();
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString();
}

const syncSequencesByDay = new Map<string, number>();

function utcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function nextSyncId(): string {
  const dateKey = utcDateKey();
  const sequence = (syncSequencesByDay.get(dateKey) ?? 0) + 1;

  syncSequencesByDay.set(dateKey, sequence);

  return `SYNC-${dateKey}-${String(sequence).padStart(3, '0')}`;
}

function getPayloadKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.keys(value as Record<string, unknown>);
}

function getFirstChatJid(chats: SyncChatLike[]): string | null {
  return chats.map((chat) => chat.jid ?? chat.id ?? null).find((jid): jid is string => Boolean(jid)) ?? null;
}

function getFirstMessageId(messages: SyncMessageLike[]): string | null {
  return messages.map((message) => message.key?.id ?? null).find((messageId): messageId is string => Boolean(messageId)) ?? null;
}

function summarizeHistoryEvent(event: HistorySyncEvent): Record<string, unknown> {
  const chats = event.chats ?? [];
  const contacts = event.contacts ?? [];
  const messages = event.messages ?? [];

  return {
    payloadKeys: getPayloadKeys(event),
    chatCount: chats.length,
    contactCount: contacts.length,
    messageCount: messages.length,
    firstChatJid: getFirstChatJid(chats),
    firstMessageId: getFirstMessageId(messages),
    isLatest: event.isLatest ?? null,
    progress: event.progress ?? null,
    syncType: event.syncType ?? null
  };
}

function summarizeChatEvent(chats: SyncChatLike[]): Record<string, unknown> {
  return {
    payloadKeys: getPayloadKeys(chats[0]),
    chatCount: chats.length,
    contactCount: 0,
    messageCount: 0,
    firstChatJid: getFirstChatJid(chats),
    firstMessageId: null
  };
}

function summarizeMessageEvent(messages: SyncMessageLike[], type?: string): Record<string, unknown> {
  return {
    payloadKeys: getPayloadKeys(messages[0]),
    chatCount: 0,
    contactCount: 0,
    messageCount: messages.length,
    firstChatJid: messages
      .map((message) => message.key?.remoteJid ?? null)
      .find((jid): jid is string => Boolean(jid)) ?? null,
    firstMessageId: getFirstMessageId(messages),
    type: type ?? null
  };
}

function classifyMessageType(message: SyncMessageLike): string {
  const payload = message.message as Record<string, unknown> | undefined;

  if (typeof message.message?.conversation === 'string' && message.message.conversation.trim().length > 0) {
    return 'text';
  }

  if (typeof message.message?.extendedTextMessage?.text === 'string' && message.message.extendedTextMessage.text.trim().length > 0) {
    return 'text';
  }

  if (payload?.imageMessage) {
    return 'image';
  }

  if (payload?.videoMessage) {
    return 'video';
  }

  if (payload?.audioMessage || payload?.pttMessage) {
    return payload?.pttMessage ? 'voice' : 'audio';
  }

  if (payload?.documentMessage) {
    return 'document';
  }

  if (payload?.stickerMessage) {
    return 'sticker';
  }

  if (payload?.locationMessage) {
    return 'location';
  }

  if (payload?.contactMessage) {
    return 'contact';
  }

  if (payload?.reactionMessage) {
    return 'reaction';
  }

  return 'unknown';
}

function buildRealtimeMessagePayload(
  context: SyncContext,
  record: ConversationRecord | undefined,
  message: SyncMessageLike,
  status: 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'DELETED' | 'RECEIVED',
  unreadCount?: number | null
) {
  const chatId = message.key?.remoteJid ?? record?.chat_jid ?? '';

  return {
    connectionId: context.connectionId,
    messageId: message.key?.id ?? '',
    conversationId: record?.id ?? null,
    chatId,
    direction: message.key?.fromMe ? 'outbound' : 'inbound',
    type: classifyMessageType(message),
    text:
      typeof message.message?.conversation === 'string'
        ? message.message.conversation
        : typeof message.message?.extendedTextMessage?.text === 'string'
          ? message.message.extendedTextMessage.text
          : null,
    status,
    timestamp: message.messageTimestamp ? new Date(message.messageTimestamp * 1000).toISOString() : new Date().toISOString(),
    unreadCount: unreadCount ?? null
  } as const;
}

function buildRealtimeConversationPayload(
  context: SyncContext,
  conversationId: string,
  chatId: string,
  lastMessage: string | null,
  lastMessageType: string | null,
  lastMessageAt: string | null,
  unreadCount: number,
  isGroup: boolean
) {
  return {
    connectionId: context.connectionId,
    conversationId,
    chatId,
    lastMessage,
    lastMessageType,
    lastMessageAt,
    unreadCount,
    isGroup
  } as const;
}

function createInitialCounters(): SyncCounters {
  return {
    historyEventsReceived: 0,
    historyChats: 0,
    chatsDiscovered: 0,
    messagesDiscovered: 0,
    contactsDiscovered: 0,
    chatsUpserted: 0,
    messagesImported: 0,
    contactsImported: 0,
    conversationsCreated: 0,
    conversationUpdates: 0,
    bootstrapUsed: false
  };
}

export class SyncService {
  private static instance: SyncService | undefined;

  private readonly supabaseClient = getSupabaseClient();
  private readonly contactRepository: ContactRepository | null;
  private readonly conversationRepository: ConversationRepository | null;
  private readonly messageRepository: MessageRepository | null;
  private readonly sessions = new Map<string, SyncSessionState>();
  private readonly boundSockets = new WeakSet<SyncSocketLike>();
  private readonly syncLogger = logger.child({ module: 'sync' });
  private warnedAboutMissingSupabase = false;

  private constructor() {
    if (this.supabaseClient) {
      this.contactRepository = createContactRepository(this.supabaseClient);
      this.conversationRepository = createConversationRepository(this.supabaseClient);
      this.messageRepository = createMessageRepository(this.supabaseClient);
    } else {
      this.contactRepository = null;
      this.conversationRepository = null;
      this.messageRepository = null;
    }
  }

  public static getInstance(): SyncService {
    if (!SyncService.instance) {
      SyncService.instance = new SyncService();
    }

    return SyncService.instance;
  }

  public registerSession(context: SyncContext, client: SyncSocketLike): void {
    const state: SyncSessionState = {
      connected: false,
      startedAt: null,
      pendingTasks: [],
      chain: Promise.resolve(),
      initialHistoryCompleted: false,
      historyChatsDiscovered: false,
      counters: createInitialCounters(),
      ...context,
      syncId: nextSyncId(),
      client,
      latestStatistics: null
    };

    this.sessions.set(context.sessionId, state);

    if (!this.boundSockets.has(client)) {
      this.bindSocket(context.sessionId, client);
      this.boundSockets.add(client);
    }

    this.syncLogger.info(
      {
        syncId: state.syncId,
        sessionId: state.sessionId,
        workspaceId: state.workspaceId,
        connectionId: state.connectionId
      },
      'Socket Ready'
    );
  }

  public updateContext(sessionId: string, patch: Partial<SyncContext>): void {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return;
    }

    state.phone = patch.phone ?? state.phone;
    state.displayName = patch.displayName ?? state.displayName;
    state.workspaceId = patch.workspaceId ?? state.workspaceId;
    state.connectionId = patch.connectionId ?? state.connectionId;
  }

  public markConnected(sessionId: string): void {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return;
    }

    state.connected = true;

    if (state.startedAt === null) {
      state.startedAt = nowMs();
      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          workspaceId: state.workspaceId,
          connectionId: state.connectionId,
          phone: state.phone ?? null,
          displayName: state.displayName ?? null
        },
        'Socket Connected'
      );
    }

    const pendingTasks = state.pendingTasks.splice(0);

    for (const task of pendingTasks) {
      this.enqueue(state.sessionId, task);
    }
  }

  public markDisconnected(sessionId: string): void {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return;
    }

    state.connected = false;
  }

  public removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  public getLatestStatistics(sessionId: string): SyncRunStatistics | null {
    return this.sessions.get(sessionId)?.latestStatistics ?? null;
  }

  private bindSocket(sessionId: string, client: SyncSocketLike): void {
    client.ev.on('messaging-history.set', (event) => {
      const state = this.sessions.get(sessionId);
      this.syncLogger.info(
        {
          syncId: state?.syncId ?? null,
          sessionId,
          source: 'messaging-history.set',
          ...summarizeHistoryEvent(event as HistorySyncEvent)
        },
        'History Sync Received'
      );
      void this.handleHistorySync(sessionId, event as HistorySyncEvent);
    });

    client.ev.on('contacts.upsert', (contacts) => {
      void this.handleContactsSync(sessionId, contacts as SyncContactLike[], 'contacts.upsert');
    });

    client.ev.on('contacts.update', (contacts) => {
      void this.handleContactsSync(sessionId, contacts as SyncContactLike[], 'contacts.update');
    });

    client.ev.on('chats.upsert', (chats) => {
      const state = this.sessions.get(sessionId);
      const chatList = chats as SyncChatLike[];
      this.syncLogger.info(
        {
          syncId: state?.syncId ?? null,
          sessionId,
          source: 'chats.upsert',
          ...summarizeChatEvent(chatList)
        },
        'Chats Upsert Event'
      );
      void this.handleChatsSync(sessionId, chats as SyncChatLike[], 'chats.upsert');
    });

    client.ev.on('chats.update', (chats) => {
      const state = this.sessions.get(sessionId);
      const chatList = chats as SyncChatLike[];
      this.syncLogger.info(
        {
          syncId: state?.syncId ?? null,
          sessionId,
          source: 'chats.update',
          ...summarizeChatEvent(chatList)
        },
        'Chats Update Event'
      );
      void this.handleChatsSync(sessionId, chats as SyncChatLike[], 'chats.update');
    });

    client.ev.on('messages.upsert', (event) => {
      const payload = event as MessagesUpsertEvent;
      const state = this.sessions.get(sessionId);
      const messages = payload.messages ?? [];
      this.syncLogger.info(
        {
          syncId: state?.syncId ?? null,
          sessionId,
          source: 'messages.upsert',
          ...summarizeMessageEvent(messages, payload.type)
        },
        'Messages Upsert Event'
      );
      void this.handleMessagesSync(sessionId, messages, 'messages.upsert', payload.type ?? null);
    });

    client.ev.on('messages.update', (event) => {
      void this.handleMessagesUpdate(sessionId, event as { messages?: SyncMessageLike[] });
    });

    client.ev.on('messages.delete', (event) => {
      void this.handleMessagesDelete(sessionId, event as { keys?: Array<{ id?: string; remoteJid?: string; participant?: string }> });
    });

    client.ev.on('message-receipt.update', (event) => {
      void this.handleMessageReceipts(sessionId, event as Array<{ key?: { id?: string; remoteJid?: string; participant?: string }; receipt?: { type?: string } }>);
    });

    client.ev.on('presence.update', (event) => {
      void this.handlePresenceUpdate(sessionId, event as { id?: string; presences?: Record<string, { lastSeen?: number | null; lastKnownPresence?: string }> });
    });
  }

  private enqueue(sessionId: string, task: () => Promise<void>): void {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return;
    }

    state.chain = state.chain
      .catch(() => undefined)
      .then(async () => {
        try {
          await task();
        } catch (error) {
          this.syncLogger.warn(
            {
              syncId: state.syncId,
              sessionId: state.sessionId,
              workspaceId: state.workspaceId,
              connectionId: state.connectionId,
              err: error
            },
            'synchronization task failed'
          );
        }
      });
  }

  private enqueueOrBuffer(sessionId: string, task: () => Promise<void>): void {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return;
    }

    if (!state.connected) {
      state.pendingTasks.push(task);
      return;
    }

    this.enqueue(sessionId, task);
  }

  private async handleHistorySync(sessionId: string, event: HistorySyncEvent): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);

      if (!state) {
        return;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          workspaceId: state.workspaceId,
          connectionId: state.connectionId
        },
        'Entered handleHistorySync()'
      );

      const startedAt = state.startedAt ?? nowMs();
      state.startedAt = startedAt;

      if (event.progress !== undefined) {
        this.syncLogger.info(
          {
            syncId: state.syncId,
            sessionId: state.sessionId,
            progress: event.progress,
            syncType: event.syncType ?? 'unknown'
          },
          'Synchronization progress'
        );
      }

      const historyChats = event.chats ?? [];
      state.counters.historyEventsReceived += 1;
      state.counters.chatsDiscovered += historyChats.length;
      state.counters.messagesDiscovered += (event.messages ?? []).length;
      state.counters.contactsDiscovered += (event.contacts ?? []).length;
      if (historyChats.length > 0) {
        state.historyChatsDiscovered = true;
        state.counters.historyChats += historyChats.length;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          historyChats: historyChats.length,
          contacts: (event.contacts ?? []).length,
          messages: (event.messages ?? []).length
        },
        'History Sync Before Processing'
      );

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          workspaceId: state.workspaceId,
          connectionId: state.connectionId,
          chatsReceived: historyChats.length,
          contactsReceived: (event.contacts ?? []).length,
          messagesReceived: (event.messages ?? []).length
        },
        'Repository Writes'
      );

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          operation: 'contacts.upsert',
          rowsReceived: (event.contacts ?? []).length
        },
        'Before repository write'
      );
      const contactsResult = await this.runContactSync(state, event.contacts ?? []);
      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          operation: 'contacts.upsert',
          ...contactsResult.stats
        },
        'Supabase Result'
      );
      if (contactsResult.stats.inputCount > 0) {
        state.counters.contactsImported += contactsResult.stats.persistedCount;
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            syncId: state.syncId,
            ...contactsResult.stats
          },
          'Contacts synced'
        );
      }

      const contactIds = new Map(contactsResult.records.map((record) => [record.jid, record.id]));
      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          operation: 'chats.upsert',
          rowsReceived: historyChats.length
        },
        'Before repository write'
      );
      const conversationsResult = await this.runConversationSync(state, historyChats, contactIds);
      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          operation: 'chats.upsert',
          ...conversationsResult.stats
        },
        'Supabase Result'
      );
      if (conversationsResult.stats.inputCount > 0) {
        state.counters.chatsUpserted += conversationsResult.stats.persistedCount;
        state.counters.conversationsCreated += conversationsResult.stats.createdCount;
        state.counters.conversationUpdates += conversationsResult.stats.updatedCount;
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            syncId: state.syncId,
            ...conversationsResult.stats
          },
          'Chats synced'
        );
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          operation: 'messages.upsert',
          rowsReceived: (event.messages ?? []).length
        },
        'Before repository write'
      );
      const messagesResult = await this.runMessageSync(state, event.messages ?? [], conversationsResult.byKey);
      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          operation: 'messages.upsert',
          ...messagesResult.stats,
          conversationCreations: messagesResult.conversationCreations
        },
        'Supabase Result'
      );
      if (messagesResult.stats.inputCount > 0) {
        state.counters.messagesImported += messagesResult.stats.persistedCount;
        state.counters.conversationsCreated += messagesResult.conversationCreations;
        for (const record of messagesResult.records) {
          emitRealtimeSocketEvent(
            record.direction === 'outbound' ? 'message.updated' : 'message.created',
            {
              connectionId: state.connectionId,
              messageId: record.message_id,
              conversationId: record.conversation_id,
              chatId: record.recipient_jid ?? '',
              direction: record.direction,
              type: record.message_type,
              text: record.text,
              status: record.direction === 'outbound' ? 'SENT' : 'RECEIVED',
              timestamp: record.timestamp,
              unreadCount: record.direction === 'inbound' ? 1 : 0
            },
            `${state.connectionId}:${record.conversation_id}:${record.message_id}:${record.direction}:${record.status}`
          );
        }

        for (const summary of messagesResult.conversationSummaries) {
          const conversation = messagesResult.records.find((record) => normalizeJid(record.recipient_jid) === normalizeJid(summary.chat_jid));

          if (!conversation) {
            continue;
          }

          emitRealtimeSocketEvent(
            summary.unread_count && summary.unread_count > 0 ? 'conversation.unread' : 'conversation.updated',
            buildRealtimeConversationPayload(
              state,
              conversation.conversation_id,
              summary.chat_jid,
              summary.last_message,
              summary.last_message_type,
              summary.last_message_at,
              summary.unread_count ?? 0,
              Boolean(summary.is_group)
            ),
            `${state.connectionId}:${conversation.conversation_id}:${summary.chat_jid}:${summary.last_message_at ?? 'none'}`
          );
        }
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            syncId: state.syncId,
            ...messagesResult.stats
          },
          'Messages synced'
        );
      }

      let summaryStats = cloneEmptyStats();
      if (messagesResult.conversationSummaries.length > 0 && this.conversationRepository) {
        this.syncLogger.info(
          {
            syncId: state.syncId,
            sessionId: state.sessionId,
            operation: 'conversation summaries',
            rowsReceived: messagesResult.conversationSummaries.length
          },
          'Before repository write'
        );
        const summaryResult = await this.conversationRepository.bulkUpsertSummaries(state, messagesResult.conversationSummaries);
        summaryStats = summaryResult.stats;
        state.counters.conversationUpdates += summaryResult.stats.updatedCount;
        state.counters.conversationsCreated += summaryResult.stats.createdCount;
        this.syncLogger.info(
          {
            syncId: state.syncId,
            sessionId: state.sessionId,
            operation: 'conversation summaries',
            ...summaryStats
          },
          'Supabase Result'
        );
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            syncId: state.syncId,
            operation: 'conversation summaries',
            ...summaryStats
          },
          'Conversation summaries synced'
        );
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          workspaceId: state.workspaceId,
          connectionId: state.connectionId
        },
        'History Sync After Processing'
      );

      if (event.isLatest !== false) {
        state.initialHistoryCompleted = true;
        const durationMs = nowMs() - startedAt;
        state.latestStatistics = {
          contacts: contactsResult.stats,
          conversations: conversationsResult.stats,
          messages: messagesResult.stats,
          conversationSummaries: summaryStats,
          historyChats: state.counters.historyChats,
          chatsUpserted: state.counters.chatsUpserted,
          messagesImported: state.counters.messagesImported,
          contactsImported: state.counters.contactsImported,
          conversationsCreated: state.counters.conversationsCreated,
          conversationUpdates: state.counters.conversationUpdates,
          bootstrapUsed: state.counters.bootstrapUsed,
          durationMs,
          startedAt: toIsoDate(startedAt),
          completedAt: toIsoDate(nowMs())
        };

        this.syncLogger.info(
          {
            syncId: state.syncId,
            sessionId: state.sessionId,
            workspaceId: state.workspaceId,
            connectionId: state.connectionId,
            durationMs,
            historyEventsReceived: state.counters.historyEventsReceived,
            historyChats: state.latestStatistics.historyChats,
            chatsUpserted: state.latestStatistics.chatsUpserted,
            messagesImported: state.latestStatistics.messagesImported,
            contactsImported: state.latestStatistics.contactsImported,
            conversationsCreated: state.latestStatistics.conversationsCreated,
            conversationUpdates: state.latestStatistics.conversationUpdates,
            bootstrapUsed: state.latestStatistics.bootstrapUsed,
            stats: state.latestStatistics
          },
          'Synchronization completed'
        );

        this.syncLogger.info(
          {
            syncId: state.syncId,
            sessionId: state.sessionId,
            historyEventsReceived: state.counters.historyEventsReceived,
            chatsDiscovered: state.counters.chatsDiscovered,
            messagesDiscovered: state.counters.messagesDiscovered,
            contactsDiscovered: state.counters.contactsDiscovered,
            conversationsWritten: state.counters.conversationsCreated + state.counters.conversationUpdates,
            messagesWritten: state.counters.messagesImported,
            bootstrapUsed: state.counters.bootstrapUsed,
            durationMs
          },
          'Sync Complete'
        );

        state.startedAt = null;
      }
    });
  }

  private async handleContactsSync(sessionId: string, contacts: SyncContactLike[], source: string): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);

      if (!state || contacts.length === 0) {
        return;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source,
          rowsReceived: contacts.length
        },
        'Before repository write'
      );
      state.counters.contactsDiscovered += contacts.length;
      const result = await this.runContactSync(state, contacts);
      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source,
          ...result.stats
        },
        'Supabase Result'
      );
      state.counters.contactsImported += result.stats.persistedCount;
      this.syncLogger.info(
        {
          sessionId: state.sessionId,
          syncId: state.syncId,
          source,
          ...result.stats
        },
        'Contacts synced'
      );
    });
  }

  private async handleChatsSync(sessionId: string, chats: SyncChatLike[], source: string): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);

      if (!state || chats.length === 0) {
        return;
      }

      if (!state.initialHistoryCompleted) {
        state.historyChatsDiscovered = true;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source,
          rowsReceived: chats.length
        },
        'Before repository write'
      );
      state.counters.chatsDiscovered += chats.length;
      const result = await this.runConversationSync(state, chats);
      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source,
          ...result.stats
        },
        'Supabase Result'
      );
      state.counters.chatsUpserted += result.stats.persistedCount;
      state.counters.conversationsCreated += result.stats.createdCount;
      state.counters.conversationUpdates += result.stats.updatedCount;
      this.syncLogger.info(
        {
          sessionId: state.sessionId,
          syncId: state.syncId,
          source,
          ...result.stats
        },
        'Chats synced'
      );
    });
  }

  private async handleMessagesSync(sessionId: string, messages: SyncMessageLike[], source: string, messageType?: string | null): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);

      if (!state || messages.length === 0) {
        return;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source,
          type: messageType ?? null,
          rowsReceived: messages.length
        },
        'Before repository write'
      );
      state.counters.messagesDiscovered += messages.length;
      const result = await this.runMessageSync(state, messages);
      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source,
          type: messageType ?? null,
          placeholderConversationCreated: result.conversationCreations > 0,
          conversationCreations: result.conversationCreations,
          ...result.stats
        },
        'Supabase Result'
      );
      state.counters.messagesImported += result.stats.persistedCount;
      state.counters.conversationsCreated += result.conversationCreations;
      this.syncLogger.info(
        {
          sessionId: state.sessionId,
          syncId: state.syncId,
          source,
          type: messageType ?? null,
          placeholderConversationCreated: result.conversationCreations > 0,
          conversationCreations: result.conversationCreations,
          ...result.stats
        },
        'Messages synced'
      );

      if (result.conversationSummaries.length > 0 && this.conversationRepository) {
        this.syncLogger.info(
          {
            syncId: state.syncId,
            sessionId: state.sessionId,
            source,
            rowsReceived: result.conversationSummaries.length
          },
          'Before repository write'
        );
        const summaryResult = await this.conversationRepository.bulkUpsertSummaries(state, result.conversationSummaries);
        this.syncLogger.info(
          {
            syncId: state.syncId,
            sessionId: state.sessionId,
            source,
            ...summaryResult.stats
          },
          'Supabase Result'
        );
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            syncId: state.syncId,
            source,
            ...summaryResult.stats
          },
          'Conversation summaries synced'
        );
      }
    });
  }

  private async handleMessagesUpdate(sessionId: string, event: { messages?: SyncMessageLike[] }): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);
      const messages = event.messages ?? [];

      if (!state || messages.length === 0) {
        return;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source: 'messages.update',
          rowsReceived: messages.length
        },
        'Message update received'
      );

      const result = await this.runMessageSync(state, messages);

      for (const message of messages) {
        const messageId = message.key?.id;
        const record = messageId ? result.records.find((item) => item.message_id === messageId) : undefined;

        if (!messageId) {
          continue;
        }

        emitRealtimeSocketEvent(
          'message.updated',
          buildRealtimeMessagePayload(state, undefined, message, message.key?.fromMe ? 'SENT' : 'RECEIVED'),
          `${state.connectionId}:${messageId}:messages.update`
        );

        if (record) {
          emitRealtimeSocketEvent(
            'conversation.updated',
            buildRealtimeConversationPayload(
              state,
              record.conversation_id,
              message.key?.remoteJid ?? record.recipient_jid ?? '',
              record.text,
              record.message_type,
              record.timestamp,
              0,
              Boolean((message.key?.remoteJid ?? record.recipient_jid ?? '').endsWith('@g.us'))
            ),
            `${state.connectionId}:${record.conversation_id}:messages.update`
          );
        }
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source: 'messages.update',
          ...result.stats
        },
        'Realtime message update emitted'
      );
    });
  }

  private async handleMessagesDelete(sessionId: string, event: { keys?: Array<{ id?: string; remoteJid?: string; participant?: string }> }): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);
      const keys = event.keys ?? [];

      if (!state || keys.length === 0 || !this.messageRepository) {
        return;
      }

      const updates: MessageStatusUpdateInput[] = keys
        .map((key) => {
          const messageId = key.id;
          const chatJid = key.remoteJid;

          return messageId && chatJid
            ? {
                chatJid,
                messageId,
                status: 'DELETED'
              }
            : null;
        })
        .filter((value): value is MessageStatusUpdateInput => value !== null);

      if (updates.length === 0) {
        return;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source: 'messages.delete',
          rowsReceived: updates.length
        },
        'Message delete received'
      );

      const result = await this.messageRepository.updateStatuses(state, updates);

      for (const update of updates) {
        emitRealtimeSocketEvent(
          'message.updated',
          {
            connectionId: state.connectionId,
            messageId: update.messageId,
            conversationId: result.records.find((record) => record.message_id === update.messageId)?.conversation_id ?? null,
            chatId: update.chatJid,
            direction: 'inbound',
            type: 'unknown',
            text: null,
            status: 'DELETED',
            timestamp: update.timestamp ?? new Date().toISOString(),
            unreadCount: null
          },
          `${state.connectionId}:${update.chatJid}:${update.messageId}:messages.delete`
        );
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source: 'messages.delete',
          ...result.stats
        },
        'Realtime message delete emitted'
      );
    });
  }

  private async handleMessageReceipts(
    sessionId: string,
    receipts: Array<{ key?: { id?: string; remoteJid?: string; participant?: string }; receipt?: { type?: string } }>
  ): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);

      if (!state || receipts.length === 0 || !this.messageRepository) {
        return;
      }

      const updates: MessageStatusUpdateInput[] = receipts
        .map((receipt) => {
          const messageId = receipt.key?.id;
          const chatJid = receipt.key?.remoteJid;
          const type = receipt.receipt?.type;

          if (!messageId || !chatJid) {
            return null;
          }

          const status = type === 'read' || type === 'read-self' ? 'READ' : 'DELIVERED';

          return {
            chatJid,
            messageId,
            status
          } satisfies MessageStatusUpdateInput;
        })
        .filter((value): value is MessageStatusUpdateInput => value !== null);

      if (updates.length === 0) {
        return;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source: 'message-receipt.update',
          rowsReceived: updates.length
        },
        'Message receipt received'
      );

      const result = await this.messageRepository.updateStatuses(state, updates);

      for (const update of updates) {
        const record = result.records.find((item) => item.message_id === update.messageId);
        emitRealtimeSocketEvent(
          'message.updated',
          {
            connectionId: state.connectionId,
            messageId: update.messageId,
            conversationId: record?.conversation_id ?? null,
            chatId: update.chatJid,
            direction: 'outbound',
            type: 'unknown',
            text: record?.text ?? null,
            status: update.status as 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'DELETED' | 'RECEIVED',
            timestamp: record?.timestamp ?? new Date().toISOString(),
            unreadCount: null
          },
          `${state.connectionId}:${update.chatJid}:${update.messageId}:${update.status}:receipt`
        );

        if (record) {
          emitRealtimeSocketEvent(
            'conversation.updated',
            buildRealtimeConversationPayload(
              state,
              record.conversation_id,
              update.chatJid,
              record.text ?? null,
              record.message_type,
              record.timestamp,
              0,
              update.chatJid.endsWith('@g.us')
            ),
            `${state.connectionId}:${update.chatJid}:${record.conversation_id}:${update.status}:conversation`
          );
        }
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source: 'message-receipt.update',
          ...result.stats
        },
        'Realtime receipt update emitted'
      );
    });
  }

  private async handlePresenceUpdate(sessionId: string, event: { id?: string; presences?: Record<string, { lastSeen?: number | null; lastKnownPresence?: string }> }): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);

      if (!state || !event.id) {
        return;
      }

      const presences = event.presences ?? {};
      const keys = Object.keys(presences);

      if (keys.length === 0) {
        return;
      }

      this.syncLogger.info(
        {
          syncId: state.syncId,
          sessionId: state.sessionId,
          source: 'presence.update',
          chatId: event.id,
          presenceCount: keys.length
        },
        'Presence update received'
      );

      for (const participant of keys) {
        const presence = presences[participant];

        emitRealtimeSocketEvent(
          'presence.updated',
          {
            connectionId: state.connectionId,
            chatId: event.id,
            participant,
            status: presence.lastKnownPresence ?? 'unknown',
            timestamp: new Date().toISOString(),
            lastSeen: typeof presence.lastSeen === 'number' ? new Date(presence.lastSeen * 1000).toISOString() : null
          },
          `${state.connectionId}:${event.id}:${participant}:${presence.lastKnownPresence ?? 'unknown'}`
        );
      }
    });
  }

  private async runContactSync(state: SyncContext, contacts: SyncContactLike[]) {
    if (!this.contactRepository) {
      this.warnAboutMissingSupabase();

      return {
        stats: cloneEmptyStats(),
        records: [],
        byKey: new Map<string, { id: string }>()
      };
    }

    return this.contactRepository.bulkUpsert(state, contacts);
  }

  private async runConversationSync(state: SyncContext, chats: SyncChatLike[], contactIds?: Map<string, string>): Promise<ConversationWriteResult> {
    if (!this.conversationRepository) {
      this.warnAboutMissingSupabase();

      return {
        stats: {
          ...cloneEmptyStats(),
          createdCount: 0,
          updatedCount: 0
        },
        records: [],
        byKey: new Map<string, ConversationRecord>()
      };
    }

    return this.conversationRepository.bulkUpsert(state, chats, contactIds ?? new Map());
  }

  private async runMessageSync(state: SyncContext, messages: SyncMessageLike[], conversations?: Map<string, ConversationRecord>) {
    if (!this.messageRepository) {
      this.warnAboutMissingSupabase();

      return {
        stats: cloneEmptyStats(),
        records: [],
        byKey: new Map<string, { id: string; conversation_id: string; message_id: string }>(),
        conversationSummaries: [],
        conversationCreations: 0
      };
    }

    return this.messageRepository.bulkUpsert(state, messages, conversations ?? new Map());
  }

  private warnAboutMissingSupabase(): void {
    if (this.warnedAboutMissingSupabase) {
      return;
    }

    this.warnedAboutMissingSupabase = true;
    this.syncLogger.warn('Supabase client is unavailable; synchronization will be skipped');
  }
}

export const syncService = SyncService.getInstance();
