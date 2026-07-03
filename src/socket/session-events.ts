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
  | 'message.received';

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
};

let socketServer: SocketIOServer | null = null;

export function registerSocketServer(server: SocketIOServer): void {
  socketServer = server;
}

export function emitSocketEvent<E extends SessionEventName>(event: E, payload: SessionEventPayloadMap[E]): void {
  socketServer?.emit(event, payload);
}

export function hasSocketServer(): boolean {
  return socketServer !== null;
}
