import { logger } from '../../config/logger';
import { getSupabaseClient } from '../../config/supabase';
import { createContactRepository, type ContactRepository } from './repositories/contact-repository';
import { createConversationRepository, type ConversationRecord, type ConversationRepository } from './repositories/conversation-repository';
import { createMessageRepository, type MessageRepository } from './repositories/message-repository';
import type { BulkUpsertStats } from './repositories/types';
import type { HistorySyncEvent, SyncChatLike, SyncContext, SyncContactLike, SyncMessageLike, SyncRuntime, SyncSocketLike } from './types';

interface SyncRunStatistics {
  contacts: BulkUpsertStats;
  conversations: BulkUpsertStats;
  messages: BulkUpsertStats;
  conversationSummaries: BulkUpsertStats;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

interface SyncSessionState extends SyncContext, SyncRuntime {
  latestStatistics: SyncRunStatistics | null;
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

function emptyRunStatistics(durationMs: number, startedAt: number): SyncRunStatistics {
  const startedIso = toIsoDate(startedAt);
  const completedIso = toIsoDate(startedAt + durationMs);

  return {
    contacts: cloneEmptyStats(),
    conversations: cloneEmptyStats(),
    messages: cloneEmptyStats(),
    conversationSummaries: cloneEmptyStats(),
    durationMs,
    startedAt: startedIso,
    completedAt: completedIso
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
        chain: Promise.resolve()
      }),
      ...context,
      client,
      latestStatistics: existing?.latestStatistics ?? null
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

      const contactsResult = await this.runContactSync(state, event.contacts ?? []);
      if (contactsResult.stats.inputCount > 0) {
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            ...contactsResult.stats
          },
          'Contacts synced'
        );
      }

      const contactIds = new Map(contactsResult.records.map((record) => [record.jid, record.id]));
      const conversationsResult = await this.runConversationSync(state, event.chats ?? [], contactIds);
      if (conversationsResult.stats.inputCount > 0) {
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
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            ...summaryStats
          },
          'Conversation summaries synced'
        );
      }

      const durationMs = nowMs() - startedAt;
      state.latestStatistics = {
        contacts: contactsResult.stats,
        conversations: conversationsResult.stats,
        messages: messagesResult.stats,
        conversationSummaries: summaryStats,
        durationMs,
        startedAt: toIsoDate(startedAt),
        completedAt: toIsoDate(nowMs())
      };

      if (event.isLatest !== false) {
        this.syncLogger.info(
          {
            sessionId: state.sessionId,
            workspaceId: state.workspaceId,
            connectionId: state.connectionId,
            durationMs,
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

      const result = await this.runConversationSync(state, chats);
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

  private async runConversationSync(state: SyncContext, chats: SyncChatLike[], contactIds?: Map<string, string>) {
    if (!this.conversationRepository) {
      this.warnAboutMissingSupabase();

      return {
        stats: cloneEmptyStats(),
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
        conversationSummaries: []
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
