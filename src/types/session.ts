import type { Socket } from 'socket.io';

export const SESSION_STATUS = {
  CONNECTING: 'CONNECTING',
  QR_READY: 'QR_READY',
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  FAILED: 'FAILED'
} as const;

export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export interface Session {
  id: string;
  workspaceId: string;
  connectionId: string;
  status: SessionStatus;
  qr: string | null;
  phone: string | null;
  displayName: string | null;
  socket: Socket | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  connectionId: string;
  socket?: Socket | null;
  phone?: string | null;
  displayName?: string | null;
}

export interface UpdateSessionInput {
  status?: SessionStatus;
  qr?: string | null;
  phone?: string | null;
  displayName?: string | null;
  socket?: Socket | null;
}
