import { Router } from 'express';

import { createApiKey, sendTextMessage } from '../controllers/public.controller';
import { requirePublicApiKeyAuth } from '../middleware/public-api-key-auth';

export const v1Router = Router();

v1Router.post('/api-keys', createApiKey);
v1Router.post('/messages/text', requirePublicApiKeyAuth, sendTextMessage);
