import type { Request, Response } from 'express';

import { webhookManager } from '../webhooks';
import { AppError } from '../utils/app-error';
import { sendSuccess } from '../utils/api-response';

function getWebhookId(request: Request): string {
  const webhookId = request.params.id;

  return Array.isArray(webhookId) ? webhookId[0] : webhookId;
}

export function createWebhook(request: Request, response: Response): void {
  const created = webhookManager.register({
    url: request.body.url,
    secret: request.body.secret,
    events: request.body.events
  });

  sendSuccess(response, 201, created);
}

export function listWebhooks(_request: Request, response: Response): void {
  sendSuccess(response, 200, {
    webhooks: webhookManager.list()
  });
}

export function getWebhook(request: Request, response: Response): void {
  const webhook = webhookManager.get(getWebhookId(request));

  if (!webhook) {
    throw new AppError('Webhook not found', 404);
  }

  sendSuccess(response, 200, {
    webhook,
    deliveryStatus: webhookManager.getDeliveries(webhook.id).summary
  });
}

export function getWebhookDeliveries(request: Request, response: Response): void {
  const webhookId = getWebhookId(request);
  const webhook = webhookManager.get(webhookId);

  if (!webhook) {
    throw new AppError('Webhook not found', 404);
  }

  sendSuccess(response, 200, {
    webhookId,
    ...webhookManager.getDeliveries(webhookId)
  });
}

export function deleteWebhook(request: Request, response: Response): void {
  const deleted = webhookManager.delete(getWebhookId(request));

  if (!deleted) {
    throw new AppError('Webhook not found', 404);
  }

  sendSuccess(response, 200, {
    deleted
  });
}
