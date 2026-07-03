import { Router } from 'express';

import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  getWebhookDeliveries,
  listWebhooks
} from '../controllers/webhooks.controller';
import { validateWebhookIdParam, validateWebhookRegistration } from '../middleware/validate-webhook-request';

export const webhooksRouter = Router();

webhooksRouter.post('/', validateWebhookRegistration, createWebhook);
webhooksRouter.get('/', listWebhooks);
webhooksRouter.get('/:id', validateWebhookIdParam, getWebhook);
webhooksRouter.get('/:id/deliveries', validateWebhookIdParam, getWebhookDeliveries);
webhooksRouter.delete('/:id', validateWebhookIdParam, deleteWebhook);
