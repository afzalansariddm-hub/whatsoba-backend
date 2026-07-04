import type { Server as SocketIOServer } from 'socket.io';

import type { IncomingMessage } from '../types/message';
import type { Session } from '../types/session';
import type { SessionView } from '../utils/session-view';

export type SessionEventName =
  | 'session.created'
  | 'session.updated'
  | 'session.qr'
  | 'session.connected'
  | 'session.disconnected'
  | 'session.deleted'
  | 'message.received'
  | RealtimeEventName;

export type RealtimeEventName =
  | 'message.created'
  | 'message.updated'
  | 'conversation.updated'
  | 'conversation.unread'
  | 'presence.updated';

export interface RealtimeMessageEvent {
  connectionId: string;
  messageId: string;
  conversationId?: string | null;
  chatId: string;
  direction: 'inbound' | 'outbound';
  type: string;
  text: string | null;
  status: 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'DELETED' | 'RECEIVED';
  timestamp: string;
  unreadCount?: number | null;
}

export interface RealtimeConversationEvent {
  connectionId: string;
  conversationId: string;
  chatId: string;
  lastMessage: string | null;
  lastMessageType: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isGroup: boolean;
}

export interface RealtimePresenceEvent {
  connectionId: string;
  chatId: string;
  participant?: string | null;
  status: string;
  timestamp: string;
  lastSeen?: string | null;
}

export interface SessionQrEvent {
  id: string;
  qr: string;
}

export interface SessionStateEvent {
  id: string;
  status: Session['status'];
  connectionState: Session['status'];
}

type SessionEventPayloadMap = {
  'session.created': SessionView;
  'session.updated': SessionView;
  'session.qr': SessionQrEvent;
  'session.connected': SessionStateEvent;
  'session.disconnected': SessionStateEvent;
  'session.deleted': SessionView;
  'message.received': IncomingMessage;
  'message.created': RealtimeMessageEvent;
  'message.updated': RealtimeMessageEvent;
  'conversation.updated': RealtimeConversationEvent;
  'conversation.unread': RealtimeConversationEvent;
  'presence.updated': RealtimePresenceEvent;
};

type RealtimeEventPayloadMap = {
  'message.created': RealtimeMessageEvent;
  'message.updated': RealtimeMessageEvent;
  'conversation.updated': RealtimeConversationEvent;
  'conversation.unread': RealtimeConversationEvent;
  'presence.updated': RealtimePresenceEvent;
};

let socketServer: SocketIOServer | null = null;
const emittedRealtimeEvents = new Map<string, number>();
const REALTIME_DEDUPE_WINDOW_MS = 5000;

export function registerSocketServer(server: SocketIOServer): void {
  socketServer = server;
}

export function emitSocketEvent<E extends SessionEventName>(event: E, payload: SessionEventPayloadMap[E]): void {
  socketServer?.emit(event, payload);
}

function shouldEmitRealtimeEvent(event: RealtimeEventName, dedupeKey: string): boolean {
  const cacheKey = `${event}:${dedupeKey}`;
  const now = Date.now();
  const previous = emittedRealtimeEvents.get(cacheKey);

  for (const [key, timestamp] of emittedRealtimeEvents.entries()) {
    if (now - timestamp > REALTIME_DEDUPE_WINDOW_MS) {
      emittedRealtimeEvents.delete(key);
    }
  }

  if (previous !== undefined && now - previous < REALTIME_DEDUPE_WINDOW_MS) {
    return false;
  }

  emittedRealtimeEvents.set(cacheKey, now);
  return true;
}

export function emitRealtimeSocketEvent<E extends RealtimeEventName>(
  event: E,
  payload: RealtimeEventPayloadMap[E],
  dedupeKey: string
): void {
  if (!socketServer) {
    return;
  }

  if (!shouldEmitRealtimeEvent(event, dedupeKey)) {
    return;
  }

  socketServer.emit(event, payload);
}

export function hasSocketServer(): boolean {
  return socketServer !== null;
}
