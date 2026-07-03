import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../utils/app-error';
import { WEBHOOK_EVENTS, type WebhookEventName } from '../types/webhook';

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }

  return value.trim();
}

function normalizeEvents(value: unknown): WebhookEventName[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const rawEvents = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const events = rawEvents.map((event) => String(event).trim()).filter((event) => event.length > 0) as WebhookEventName[];

  if (events.length === 0) {
    return undefined;
  }

  for (const event of events) {
    if (!WEBHOOK_EVENTS.includes(event)) {
      throw new AppError(`Unsupported webhook event: ${event}`, 400);
    }
  }

  return [...new Set(events)];
}

export function validateWebhookIdParam(request: Request, _response: Response, next: NextFunction): void {
  try {
    request.params.id = requireString(request.params.id, 'id');
    next();
  } catch (error) {
    next(error);
  }
}

export function validateWebhookRegistration(request: Request, _response: Response, next: NextFunction): void {
  try {
    const url = requireString(request.body.url, 'url');
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new AppError('url must use http or https', 400);
    }

    const secret = typeof request.body.secret === 'string' && request.body.secret.trim().length > 0 ? request.body.secret.trim() : undefined;
    const events = normalizeEvents(request.body.events);

    request.body.url = parsedUrl.toString();
    request.body.secret = secret;
    request.body.events = events;
    next();
  } catch (error) {
    next(error);
  }
}
