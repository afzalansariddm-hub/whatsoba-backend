import { Router } from 'express';

import { chatRouter } from './chatRoutes';
import { contactRouter } from './contactRoutes';
import { dashboardRouter } from './dashboardRoutes';
import { healthRouter } from './health.routes';
import { messagesRouter } from './messages.routes';
import { webhooksRouter } from './webhooks.routes';
import { sessionsRouter } from './sessions.routes';

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use('/chats', chatRouter);
apiRouter.use('/contacts', contactRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/messages', messagesRouter);
apiRouter.use('/webhooks', webhooksRouter);
