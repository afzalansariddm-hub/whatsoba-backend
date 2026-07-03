import { Router } from 'express';

import { healthRouter } from './health.routes';
import { messagesRouter } from './messages.routes';
import { webhooksRouter } from './webhooks.routes';
import { sessionsRouter } from './sessions.routes';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/webhooks', webhooksRouter);
