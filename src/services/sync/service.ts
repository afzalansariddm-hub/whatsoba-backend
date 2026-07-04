import { logger } from '../../config/logger';
import { getSupabaseClient } from '../../config/supabase';
import { createContactRepository, type ContactRepository } from './repositories/contact-repository';
import { createConversationRepository, type ConversationRecord, type ConversationRepository, type ConversationWriteResult } from './repositories/conversation-repository';
import { createMessageRepository, type MessageRepository } from './repositories/message-repository';
import type { BulkUpsertStats } from './repositories/types';
import type { HistorySyncEvent, SyncChatLike, SyncContext, SyncContactLike, SyncMessageLike, SyncRuntime, SyncSocketLike } from './types';

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
  bootstrapAttempted: boolean;
  counters: SyncCounters;
}

interface SeedContactRecord {
  id: string;
  jid: string;
  display_name: string | null;
  push_name: string | null;
  last_seen: string | null;
}

interface SyncCounters {
  historyChats: number;
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

function createInitialCounters(): SyncCounters {
  return {
    historyChats: 0,
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
    const existing = this.sessions.get(context.sessionId);
    const state: SyncSessionState = {
      ...(existing ?? {
        connected: false,
        startedAt: null,
        pendingTasks: [],
        chain: Promise.resolve(),
        initialHistoryCompleted: false,
        historyChatsDiscovered: false,
        bootstrapAttempted: false,
        counters: createInitialCounters()
      }),
      ...context,
      client,
      latestStatistics: existing?.latestStatistics ?? null,
      initialHistoryCompleted: existing?.initialHistoryCompleted ?? false,
      historyChatsDiscovered: existing?.historyChatsDiscovered ?? false,
      bootstrapAttempted: existing?.bootstrapAttempted ?? false,
      counters: existing?.counters ?? createInitialCounters()
    };

    this.sessions.set(context.sessionId, state);

    if (!this.boundSockets.has(client)) {
      this.bindSocket(context.sessionId, client);
      this.boundSockets.add(client);
    }
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
          sessionId: state.sessionId,
          workspaceId: state.workspaceId,
          connectionId: state.connectionId
        },
        'Starting synchronization...'
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
      void this.handleHistorySync(sessionId, event as HistorySyncEvent);
    });

    client.ev.on('contacts.upsert', (contacts) => {
      void this.handleContactsSync(sessionId, contacts as SyncContactLike[], 'contacts.upsert');
    });

    client.ev.on('contacts.update', (contacts) => {
      void this.handleContactsSync(sessionId, contacts as SyncContactLike[], 'contacts.update');
    });

    client.ev.on('chats.upsert', (chats) => {
      void this.handleChatsSync(sessionId, chats as SyncChatLike[], 'chats.upsert');
    });

    client.ev.on('chats.update', (chats) => {
      void this.handleChatsSync(sessionId, chats as SyncChatLike[], 'chats.update');
    });

    client.ev.on('messages.upsert', (event) => {
      const payload = event as { messages?: SyncMessageLike[] };
      void this.handleMessagesSync(sessionId, payload.messages ?? [], 'messages.upsert');
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

      const startedAt = state.startedAt ?? nowMs();
      state.startedAt = startedAt;

      if (event.progress !== undefined) {
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            progress: event.progress,
            syncType: event.syncType ?? 'unknown'
          },
          'Synchronization progress'
        );
      }

      const historyChats = event.chats ?? [];
      if (historyChats.length > 0) {
        state.historyChatsDiscovered = true;
        state.counters.historyChats += historyChats.length;
      }

      const contactsResult = await this.runContactSync(state, event.contacts ?? []);
      if (contactsResult.stats.inputCount > 0) {
        state.counters.contactsImported += contactsResult.stats.persistedCount;
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            ...contactsResult.stats
          },
          'Contacts synced'
        );
      }

      const contactIds = new Map(contactsResult.records.map((record) => [record.jid, record.id]));
      const conversationsResult = await this.runConversationSync(state, historyChats, contactIds);
      if (conversationsResult.stats.inputCount > 0) {
        state.counters.conversationsCreated += conversationsResult.stats.createdCount;
        state.counters.conversationUpdates += conversationsResult.stats.updatedCount;
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            ...conversationsResult.stats
          },
          'Chats synced'
        );
      }

      const messagesResult = await this.runMessageSync(state, event.messages ?? [], conversationsResult.byKey);
      if (messagesResult.stats.inputCount > 0) {
        state.counters.messagesImported += messagesResult.stats.inputCount;
        state.counters.conversationsCreated += messagesResult.conversationCreations;
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            ...messagesResult.stats
          },
          'Messages synced'
        );
      }

      let summaryStats = cloneEmptyStats();
      if (messagesResult.conversationSummaries.length > 0 && this.conversationRepository) {
        const summaryResult = await this.conversationRepository.bulkUpsertSummaries(state, messagesResult.conversationSummaries);
        summaryStats = summaryResult.stats;
        state.counters.conversationUpdates += summaryResult.stats.updatedCount;
        state.counters.conversationsCreated += summaryResult.stats.createdCount;
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            ...summaryStats
          },
          'Conversation summaries synced'
        );
      }

      if (event.isLatest !== false) {
        state.initialHistoryCompleted = true;
        const conversationCount = await this.getConversationCount(state);
        if (
          !state.bootstrapAttempted &&
          !state.historyChatsDiscovered &&
          contactsResult.records.length > 0 &&
          conversationCount === 0
        ) {
          const bootstrapResult = await this.runContactBootstrap(state, contactsResult.records as SeedContactRecord[]);
          state.counters.bootstrapUsed = true;
          state.counters.conversationsCreated += bootstrapResult.stats.createdCount;
        }

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
            sessionId: state.sessionId,
            workspaceId: state.workspaceId,
            connectionId: state.connectionId,
            durationMs,
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

      const result = await this.runContactSync(state, contacts);
      state.counters.contactsImported += result.stats.persistedCount;
      this.syncLogger.info(
        {
          sessionId: state.sessionId,
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

      const result = await this.runConversationSync(state, chats);
      state.counters.chatsUpserted += chats.length;
      state.counters.conversationsCreated += result.stats.createdCount;
      state.counters.conversationUpdates += result.stats.updatedCount;
      this.syncLogger.info(
        {
          sessionId: state.sessionId,
          source,
          ...result.stats
        },
        'Chats synced'
      );
    });
  }

  private async handleMessagesSync(sessionId: string, messages: SyncMessageLike[], source: string): Promise<void> {
    this.enqueueOrBuffer(sessionId, async () => {
      const state = this.sessions.get(sessionId);

      if (!state || messages.length === 0) {
        return;
      }

      const result = await this.runMessageSync(state, messages);
      state.counters.messagesImported += messages.length;
      state.counters.conversationsCreated += result.conversationCreations;
      this.syncLogger.info(
        {
          sessionId: state.sessionId,
          source,
          ...result.stats
        },
        'Messages synced'
      );

      if (result.conversationSummaries.length > 0 && this.conversationRepository) {
        const summaryResult = await this.conversationRepository.bulkUpsertSummaries(state, result.conversationSummaries);
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
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

  private async getConversationCount(state: SyncContext): Promise<number> {
    if (!this.conversationRepository) {
      this.warnAboutMissingSupabase();
      return 0;
    }

    return this.conversationRepository.countByScope(state.workspaceId, state.connectionId);
  }

  private async runContactBootstrap(state: SyncSessionState, contacts: SeedContactRecord[]) {
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

    const contactIdByJid = new Map(contacts.map((contact) => [contact.jid, contact.id] as const));
    const seedChats: SyncChatLike[] = contacts.map((contact) => ({
      jid: contact.jid,
      name: contact.display_name ?? contact.push_name ?? undefined,
      archived: false,
      pinned: false,
      isGroup: false,
      unreadCount: 0,
      conversationTimestamp: contact.last_seen ? Math.floor(Date.parse(contact.last_seen) / 1000) : null
    }));

    state.bootstrapAttempted = true;
    this.syncLogger.info(
      {
        sessionId: state.sessionId,
        workspaceId: state.workspaceId,
        connectionId: state.connectionId
      },
      'Using contact bootstrap fallback because no conversations were discovered during initial history sync.'
    );

    return this.conversationRepository.bulkUpsert(state, seedChats, contactIdByJid);
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
