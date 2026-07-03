import type { Server as HttpServer } from 'node:http';

import { Server, type Socket } from 'socket.io';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { registerSocketServer } from './session-events';

export function initializeSocket(server: HttpServer): Server {
  const io = new Server(server, {
    cors: {
      origin: env.frontendOrigins,
      credentials: true
    }
  });
  const activeSockets = new Set<Socket>();

  (io as typeof io & { data: { activeSockets: Set<Socket> } }).data = {
    activeSockets
  };
  registerSocketServer(io);

  io.on('connection', (socket: Socket) => {
    activeSockets.add(socket);
    logger.info({
      socketId: socket.id,
      activeConnections: activeSockets.size
    }, 'socket connected');

    socket.on('disconnect', (reason) => {
      activeSockets.delete(socket);
      logger.info({
        socketId: socket.id,
        reason,
        activeConnections: activeSockets.size
      }, 'socket disconnected');
    });
  });

  return io;
}
