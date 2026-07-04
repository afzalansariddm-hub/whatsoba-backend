import { Router } from 'express';

import { getApiKey, upsertApiKey } from '../controllers/developer.controller';

export const developerRouter = Router();

developerRouter.get('/api-keys', getApiKey);
developerRouter.post('/api-keys', upsertApiKey);
