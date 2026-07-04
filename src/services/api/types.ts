export type SortDirection = 'asc' | 'desc';

export interface ApiContext {
  workspaceId: string;
}

export interface ChatListFilters extends ApiContext {
  connectionId?: string;
  search?: string;
  limit: number;
  offset: number;
  sort: SortDirection;
  unread?: boolean;
  groups?: boolean;
  archived?: boolean;
  pinned?: boolean;
}

export interface ChatListItem {
  id: string;
  chatJid: string;
  displayName: string | null;
  phone: string | null;
  avatar: string | null;
  lastMessage: string | null;
  lastMessageType: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isPinned: boolean;
  isArchived: boolean;
  isGroup: boolean;
  connectionId: string;
}

export interface ChatDetail {
  conversation: unknown;
  contact: unknown;
  latestMessage: unknown;
  unreadCount: number;
  isGroup: boolean;
  isPinned: boolean;
  isArchived: boolean;
}

export interface ChatMessageFilters extends ApiContext {
  connectionId?: string;
  jid: string;
  limit: number;
  before?: string;
  after?: string;
}

export interface ContactListFilters extends ApiContext {
  search?: string;
  limit: number;
  offset: number;
  sort: SortDirection;
}

export interface ContactConversationItem {
  id: string;
  chatJid: string;
  lastMessage: string | null;
  lastMessageType: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isGroup: boolean;
  isArchived: boolean;
  isPinned: boolean;
  messageCount: number;
}

export interface ContactMessageItem {
  id: string;
  messageId: string;
  conversationId: string;
  chatJid: string;
  sender: string | null;
  recipient: string | null;
  direction: 'inbound' | 'outbound';
  type: string;
  text: string | null;
  mediaUrl: string | null;
  status: string;
  timestamp: string;
}

export interface ContactListItem {
  id: string;
  displayName: string | null;
  phone: string | null;
  avatar: string | null;
  about: string | null;
  isBusiness: boolean;
  lastSeen: string | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  conversationCount: number;
  messageCount: number;
  lastActivity: string | null;
  latestConversation: ContactConversationItem | null;
}

export interface ContactConversationsFilters extends ApiContext {
  contactId: string;
  limit: number;
  offset: number;
  sort: SortDirection;
}

export interface ContactMessagesFilters extends ApiContext {
  contactId: string;
  limit: number;
  offset: number;
  sort: SortDirection;
}

export interface ContactDetail {
  contact: ContactListItem;
  latestConversation: ContactConversationItem | null;
  statistics: {
    conversationCount: number;
    messageCount: number;
    messagesSent: number;
    messagesReceived: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
    lastActivity: string | null;
  };
}

export interface DashboardSummary {
  connectedAccounts: number;
  contacts: number;
  conversations: number;
  unreadConversations: number;
  messagesToday: number;
  messagesThisWeek: number;
  groups: number;
  lastSynchronization: string | null;
}

export interface ApiMessageItem {
  id: string;
  messageId: string;
  sender: string | null;
  recipient: string | null;
  direction: 'inbound' | 'outbound';
  type: string;
  text: string | null;
  mediaUrl: string | null;
  status: string;
  timestamp: string;
}
