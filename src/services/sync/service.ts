import { logger } from '../../config/logger';
import { getSupabaseClient } from '../../config/supabase';
import { createContactRepository, type ContactRepository } from './repositories/contact-repository';
import { createConversationRepository, type ConversationRecord, type ConversationRepository, type ConversationWriteResult } from './repositories/conversation-repository';
import { createMessageRepository, type MessageRepository } from './repositories/message-repository';
import type { BulkUpsertStats } from './repositories/types';
import type { HistorySyncEvent, MessagesUpsertEvent, SyncChatLike, SyncContext, SyncContactLike, SyncMessageLike, SyncRuntime, SyncSocketLike } from './types';

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
