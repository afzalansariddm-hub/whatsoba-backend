import type { Session } from '../types/session';

export interface SessionView {
  id: string;
  workspaceId: string;
  connectionId: string;
  status: Session['status'];
  connectionState: Session['status'];
  qr: string | null;
  phone: string | null;
  displayName: string | null;
  battery: {
    level: number | null;
  };
  createdAt: string;
  updatedAt: string;
}

export function toSessionView(session: Session): SessionView {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    connectionId: session.connectionId,
    status: session.status,
    connectionState: session.status,
    qr: session.qr,
    phone: session.phone,
    displayName: session.displayName,
    battery: {
      level: null
    },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}
