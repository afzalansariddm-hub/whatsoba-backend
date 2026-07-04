export interface SyncContext {
  sessionId: string;
  workspaceId: string;
  connectionId: string;
  phone?: string | null;
  displayName?: string | null;
}

export interface SyncSocketLike {
  ev: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
}

export interface HistorySyncEvent {
  chats?: SyncChatLike[];
  contacts?: SyncContactLike[];
  messages?: SyncMessageLike[];
  isLatest?: boolean;
  progress?: number;
  syncType?: string;
}

export interface SyncContactLike {
  id?: string;
  jid?: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
  imgUrl?: string;
  img_url?: string;
  isBusiness?: boolean;
  isMyContact?: boolean;
  status?: string;
  [key: string]: unknown;
}

export interface SyncChatLike {
  id?: string;
  jid?: string;
  name?: string;
  subject?: string;
  unreadCount?: number;
  archived?: boolean;
  pinned?: boolean | number;
  muteEndTime?: number | null;
  readOnly?: boolean;
  isGroup?: boolean;
  conversationTimestamp?: number | null;
  lastMessage?: unknown;
  messages?: unknown;
  [key: string]: unknown;
}

export interface SyncMessageLike {
  key?: {
    id?: string;
    remoteJid?: string;
    participant?: string;
    fromMe?: boolean;
  };
  messageTimestamp?: number | null;
  message?: {
    conversation?: string;
    extendedTextMessage?: {
      text?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SyncRuntime {
  connected: boolean;
  startedAt: number | null;
  client: SyncSocketLike;
  pendingTasks: Array<() => Promise<void>>;
  chain: Promise<void>;
}
