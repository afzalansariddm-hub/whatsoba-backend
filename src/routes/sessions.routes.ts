import { Router } from 'express';

import {
  createSession,
  deleteSession,
  getSession,
  getSessionQr,
  listSessions,
  reconnectSession
} from '../controllers/sessions.controller';
import { validateCreateSession, validateSessionIdParam } from '../middleware/validate-session-request';

export const sessionsRouter = Router();

sessionsRouter.post('/', validateCreateSession, createSession);
sessionsRouter.get('/', listSessions);
sessionsRouter.get('/:id', validateSessionIdParam, getSession);
sessionsRouter.get('/:id/qr', validateSessionIdParam, getSessionQr);
sessionsRouter.delete('/:id', validateSessionIdParam, deleteSession);
sessionsRouter.post('/:id/reconnect', validateSessionIdParam, reconnectSession);
