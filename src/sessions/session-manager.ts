import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Socket } from 'socket.io';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/app-error';
import { SESSION_STATUS, type CreateSessionInput, type Session, type UpdateSessionInput } from '../types/session';
import { emitSocketEvent } from '../socket/session-events';
import { webhookDispatcher } from '../webhooks';
import { normalizeIncomingMessage } from '../utils/message-normalizer';
import { toReceiptWebhookMessageEvent, toReceivedWebhookMessageEvent } from '../utils/webhook-message-event';
import { toSessionView } from '../utils/session-view';
import { syncService } from '../services/sync';

type BaileysModule = {
  default: (config: unknown) => BaileysSocket;
  DisconnectReason: {
    loggedOut: number;
  };
  useMultiFileAuthState: (folder: string) => Promise<{
    state: unknown;
    saveCreds: () => Promise<void>;
  }>;
};
type BaileysSocket = {
  ev: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  };
  sendMessage: (jid: string, content: unknown, options?: unknown) => Promise<unknown>;
  user?: {
    id?: string;
    name?: string;
  };
  logout: (msg?: string) => Promise<void>;
  end: (error: Error | undefined) => Promise<void>;
};

type ConnectionUpdate = {
  connection?: 'connecting' | 'open' | 'close';
  qr?: string;
  lastDisconnect?: {
    error?: unknown;
  };
};

type MessagesUpsertEvent = {
  messages?: Array<{
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
    };
  }>;
};

type MessageReceiptUpdateEvent = Array<{
  key?: {
    id?: string;
    remoteJid?: string;
    participant?: string;
  };
  receipt?: {
    type?: 'read' | 'read-self' | 'hist_sync' | 'peer_msg' | 'sender' | 'inactive' | 'played';
  };
}>;

interface SessionRuntime {
  authDir: string;
  client: BaileysSocket | null;
  reconnectTimer: NodeJS.Timeout | null;
  token: string;
}

function now(): string {
  return new Date().toISOString();
}

function toPhoneNumber(userId: string | undefined): string | null {
  if (!userId) {
    return null;
  }

  return userId.split('@')[0]?.split(':')[0] ?? null;
}

function isLoggedOut(error: unknown, disconnectReason: number): boolean {
  return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode === disconnectReason;
}

export class SessionManager {
  private static instance: SessionManager | undefined;

  private readonly sessions = new Map<string, Session>();
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly activeSockets = new Map<string, Set<Socket>>();

  private constructor() {}

  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }

    return SessionManager.instance;
  }

  public create(input: CreateSessionInput): Session {
    if (this.sessionsHasConnectionId(input.connectionId)) {
      throw new AppError('Session with this connectionId already exists', 409);
    }

    const id = randomUUID();
    const session: Session = {
      id,
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      status: SESSION_STATUS.CONNECTING,
      qr: null,
      phone: input.phone ?? null,
      displayName: input.displayName ?? null,
      socket: input.socket ?? null,
      createdAt: now(),
      updatedAt: now()
    };

    const authDir = this.getSessionDirectory(input.connectionId);
    this.sessions.set(id, session);
    this.runtimes.set(id, {
      authDir,
      client: null,
      reconnectTimer: null,
      token: randomUUID()
    });

    if (input.socket) {
      this.syncActiveSocket(id, input.socket);
    }

    emitSocketEvent('session.created', toSessionView(session));
    void this.startConnection(id);

    return this.clone(session);
  }

  public get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);

    return session ? this.clone(session) : undefined;
  }

  public getByConnectionId(connectionId: string): Session | undefined {
    const session = Array.from(this.sessions.values()).find((currentSession) => currentSession.connectionId === connectionId);

    return session ? this.clone(session) : undefined;
  }

  public list(workspaceId?: string): Session[] {
    const sessions = Array.from(this.sessions.values());
    const filtered = workspaceId ? sessions.filter((session) => session.workspaceId === workspaceId) : sessions;

    return filtered.map((session) => this.clone(session));
  }

  public async delete(sessionId: string): Promise<Session | undefined> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return undefined;
    }

    const snapshot = this.clone(session);
    this.sessions.delete(sessionId);
    this.activeSockets.delete(sessionId);

    await this.destroyConnection(sessionId, true, true);
    emitSocketEvent('session.deleted', toSessionView(snapshot));

    return snapshot;
  }

  public async restart(sessionId: string): Promise<Session | undefined> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return undefined;
    }

    session.status = SESSION_STATUS.CONNECTING;
    session.qr = null;
    session.updatedAt = now();

    this.bumpToken(sessionId);
    await this.destroyConnection(sessionId, false, false);
    void this.startConnection(sessionId);

    return this.clone(session);
  }

  public update(sessionId: string, input: UpdateSessionInput): Session | undefined {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return undefined;
    }

    const hasSocketUpdate = Object.prototype.hasOwnProperty.call(input, 'socket');
    const nextSocket = hasSocketUpdate ? input.socket ?? null : session.socket;

    session.status = input.status ?? session.status;
    session.qr = input.qr !== undefined ? input.qr : session.qr;
    session.phone = input.phone !== undefined ? input.phone : session.phone;
    session.displayName = input.displayName !== undefined ? input.displayName : session.displayName;
    session.socket = nextSocket;
    session.updatedAt = now();

    this.sessions.set(session.id, session);
    this.syncActiveSocket(session.id, nextSocket);
    emitSocketEvent('session.updated', toSessionView(session));

    return this.clone(session);
  }

  public getActiveSockets(sessionId: string): Socket[] {
    return Array.from(this.activeSockets.get(sessionId) ?? []);
  }

  public getClientByConnectionId(connectionId: string): BaileysSocket | undefined {
    const sessionEntry = Array.from(this.sessions.entries()).find(([, session]) => session.connectionId === connectionId);

    if (!sessionEntry) {
      return undefined;
    }

    return this.runtimes.get(sessionEntry[0])?.client ?? undefined;
  }

  private async startConnection(sessionId: string): Promise<void> {
    try {
      const session = this.sessions.get(sessionId);
      const runtime = this.runtimes.get(sessionId);

      if (!session || !runtime) {
        return;
      }

      const token = runtime.token;
      const baileys = (await import('@whiskeysockets/baileys')) as unknown as BaileysModule;
      const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = baileys;

      if (!this.isRuntimeCurrent(sessionId, token)) {
        return;
      }

      await mkdir(runtime.authDir, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(runtime.authDir);

      if (!this.isRuntimeCurrent(sessionId, token)) {
        return;
      }

      const socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Whatsoba Gateway', 'Chrome', '1.0.0'],
        logger: logger.child({ module: 'baileys', sessionId }),
        syncFullHistory: true
      }) as BaileysSocket;

      runtime.client = socket;
      syncService.registerSession(
        {
          sessionId,
          workspaceId: session.workspaceId,
          connectionId: session.connectionId,
          phone: session.phone ?? null,
          displayName: session.displayName ?? null
        },
        socket
      );
      this.bindSocket(sessionId, token, socket, saveCreds, DisconnectReason.loggedOut);

      this.patchSession(sessionId, {
        status: SESSION_STATUS.CONNECTING,
        qr: null
      });
    } catch (error) {
      logger.error({ err: error, sessionId }, 'baileys connection failed');
      this.patchSession(sessionId, {
        status: SESSION_STATUS.FAILED,
        qr: null
      });
    }
  }

  private bindSocket(
    sessionId: string,
    token: string,
    socket: BaileysSocket,
    saveCreds: () => Promise<void>,
    loggedOutReason: number
  ): void {
    const runtime = this.runtimes.get(sessionId);
    const session = this.sessions.get(sessionId);

    if (!runtime || !session) {
      return;
    }

    socket.ev.on('creds.update', () => {
      void saveCreds();
    });

    socket.ev.on('connection.update', (update) => {
      const connectionUpdate = update as ConnectionUpdate;

      if (!this.isRuntimeCurrent(sessionId, token)) {
        return;
      }

      const connection = connectionUpdate.connection;
      const qr = connectionUpdate.qr ?? null;
      const lastDisconnect = connectionUpdate.lastDisconnect?.error;

      if (connection === 'connecting') {
        this.patchSession(sessionId, {
          status: SESSION_STATUS.CONNECTING
        });
      }

      if (qr) {
        this.patchSession(sessionId, {
          status: SESSION_STATUS.QR_READY,
          qr
        });
        emitSocketEvent('session.qr', {
          id: sessionId,
          qr
        });
      }

      if (connection === 'open') {
        const phone = toPhoneNumber(socket.user?.id) ?? this.sessions.get(sessionId)?.phone ?? null;
        const displayName = socket.user?.name ?? this.sessions.get(sessionId)?.displayName ?? null;

        this.patchSession(sessionId, {
          status: SESSION_STATUS.CONNECTED,
          qr: null,
          phone,
          displayName
        });
        syncService.updateContext(sessionId, {
          phone,
          displayName
        });
        emitSocketEvent('session.connected', {
          id: sessionId,
          status: SESSION_STATUS.CONNECTED,
          connectionState: SESSION_STATUS.CONNECTED
        });
        webhookDispatcher.emit('session.connected', toSessionView(session));
        syncService.markConnected(sessionId);
        return;
      }

      if (connection !== 'close') {
        return;
      }

      runtime.client = null;

      if (isLoggedOut(lastDisconnect, loggedOutReason)) {
        this.patchSession(sessionId, {
          status: SESSION_STATUS.DISCONNECTED,
          qr: null
        });
        emitSocketEvent('session.disconnected', {
          id: sessionId,
          status: SESSION_STATUS.DISCONNECTED,
          connectionState: SESSION_STATUS.DISCONNECTED
        });
        webhookDispatcher.emit('session.disconnected', toSessionView(session));
        syncService.markDisconnected(sessionId);
        return;
      }

      this.patchSession(sessionId, {
        status: SESSION_STATUS.DISCONNECTED,
        qr: null
      });
      emitSocketEvent('session.disconnected', {
        id: sessionId,
        status: SESSION_STATUS.DISCONNECTED,
        connectionState: SESSION_STATUS.DISCONNECTED
      });
      webhookDispatcher.emit('session.disconnected', toSessionView(session));
      syncService.markDisconnected(sessionId);
      this.scheduleReconnect(sessionId, token);
    });

    socket.ev.on('messages.upsert', (update) => {
      const messages = normalizeIncomingMessage(update as MessagesUpsertEvent);

      for (const message of messages) {
        webhookDispatcher.emit('message.received', toReceivedWebhookMessageEvent(session.connectionId, message));
      }
    });

    socket.ev.on('message-receipt.update', (update) => {
      const receipts = update as MessageReceiptUpdateEvent;

      for (const receiptUpdate of receipts) {
        const messageId = receiptUpdate.key?.id;
        const chatId = receiptUpdate.key?.remoteJid;

        if (!messageId || !chatId) {
          continue;
        }

        const status = receiptUpdate.receipt?.type === 'read' ? 'READ' : 'DELIVERED';

        webhookDispatcher.emit(
          status === 'READ' ? 'message.read' : 'message.delivered',
          toReceiptWebhookMessageEvent({
            connectionId: session.connectionId,
            messageId,
            chatId,
            sender: receiptUpdate.key?.participant ?? session.phone ?? toPhoneNumber(socket.user?.id),
            timestamp: now(),
            status
          })
        );
      }
    });

  }

  private scheduleReconnect(sessionId: string, token: string): void {
    const runtime = this.runtimes.get(sessionId);

    if (!runtime || !this.isRuntimeCurrent(sessionId, token)) {
      return;
    }

    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
    }

    runtime.reconnectTimer = setTimeout(() => {
      if (!this.isRuntimeCurrent(sessionId, token)) {
        return;
      }

      void this.startConnection(sessionId);
    }, 1500);
  }

  private async destroyConnection(sessionId: string, removeAuthDir: boolean, shouldLogout: boolean): Promise<void> {
    const runtime = this.runtimes.get(sessionId);

    if (!runtime) {
      return;
    }

    this.bumpToken(sessionId);

    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }

    const socket = runtime.client;
    runtime.client = null;

    if (socket) {
      try {
        if (shouldLogout) {
          await socket.logout('Session removed');
        } else {
          await socket.end(new Error('Session closed'));
        }
      } catch (error) {
        logger.warn({ err: error, sessionId }, shouldLogout ? 'baileys logout during cleanup failed' : 'baileys close during cleanup failed');
        try {
          await socket.end(new Error('Session closed'));
        } catch (endError) {
          logger.warn({ err: endError, sessionId }, 'baileys end during cleanup failed');
        }
      }
    }

    if (removeAuthDir) {
      try {
        await rm(runtime.authDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn({ err: error, sessionId }, 'failed to remove session auth directory');
      }

      this.runtimes.delete(sessionId);
      syncService.removeSession(sessionId);
    }
  }

  private getSessionDirectory(connectionId: string): string {
    return path.resolve(process.cwd(), env.sessionPath, connectionId);
  }

  private sessionsHasConnectionId(connectionId: string): boolean {
    return Array.from(this.sessions.values()).some((session) => session.connectionId === connectionId);
  }

  private isRuntimeCurrent(sessionId: string, token: string): boolean {
    return this.runtimes.get(sessionId)?.token === token && this.sessions.has(sessionId);
  }

  private bumpToken(sessionId: string): string | undefined {
    const runtime = this.runtimes.get(sessionId);

    if (!runtime) {
      return undefined;
    }

    runtime.token = randomUUID();
    return runtime.token;
  }

  private syncActiveSocket(sessionId: string, socket: Socket | null): void {
    if (!socket) {
      return;
    }

    const sockets = this.activeSockets.get(sessionId) ?? new Set<Socket>();
    sockets.add(socket);
    this.activeSockets.set(sessionId, sockets);
  }

  private patchSession(sessionId: string, patch: Partial<Pick<Session, 'status' | 'qr' | 'phone' | 'displayName'>>): void {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    if (patch.status !== undefined) {
      session.status = patch.status;
    }

    if (patch.qr !== undefined) {
      session.qr = patch.qr;
    }

    if (patch.phone !== undefined) {
      session.phone = patch.phone;
    }

    if (patch.displayName !== undefined) {
      session.displayName = patch.displayName;
    }

    session.updatedAt = now();
    this.sessions.set(sessionId, session);
    emitSocketEvent('session.updated', toSessionView(session));
  }

  private clone(session: Session): Session {
    return {
      ...session
    };
  }
}

export const sessionManager = SessionManager.getInstance();
