import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { logger } from '../config/logger';
import { webhookDispatcher } from './webhook-dispatcher';
import type {
  WebhookCreateResult,
  WebhookDeliveryLog,
  WebhookDeliveryReport,
  WebhookDeliverySummary,
  WebhookEventName,
  WebhookEventPayloadMap,
  WebhookRegistration,
  WebhookRegistrationInput,
  WebhookView
} from '../types/webhook';

interface QueueTask {
  deliveryId: string;
  webhookId: string;
  event: WebhookEventName;
  payload: WebhookEventPayloadMap[WebhookEventName];
  attempt: number;
  runAt: number;
}

interface SignedEnvelope<T> {
  id: string;
  event: WebhookEventName;
  occurredAt: string;
  data: T;
}

const ALL_EVENTS: WebhookEventName[] = [
  'session.connected',
  'session.disconnected',
  'message.received',
  'message.sent',
  'message.delivered',
  'message.read'
];

function now(): string {
  return new Date().toISOString();
}

function clampLogs(logs: WebhookDeliveryLog[]): WebhookDeliveryLog[] {
  return logs.slice(-200);
}

function toView(registration: WebhookRegistration): WebhookView {
  return {
    id: registration.id,
    url: registration.url,
    events: [...registration.events],
    enabled: registration.enabled,
    secretConfigured: registration.secret.length > 0,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt
  };
}

function toCreateResult(registration: WebhookRegistration): WebhookCreateResult {
  return {
    ...toView(registration),
    secret: registration.secret
  };
}

function summarizeLogs(logs: WebhookDeliveryLog[]): WebhookDeliverySummary {
  return logs.reduce<WebhookDeliverySummary>(
    (summary, log) => {
      summary.total += 1;
      summary[log.status.toLowerCase() as keyof Pick<WebhookDeliverySummary, 'pending' | 'retrying' | 'delivered' | 'failed'>] += 1;
      return summary;
    },
    {
      pending: 0,
      retrying: 0,
      delivered: 0,
      failed: 0,
      total: 0
    }
  );
}

export class WebhookManager {
  private static instance: WebhookManager | undefined;

  private readonly webhooks = new Map<string, WebhookRegistration>();
  private readonly logs = new Map<string, WebhookDeliveryLog[]>();
  private readonly queue: QueueTask[] = [];
  private queueTimer: NodeJS.Timeout | null = null;
  private processing = false;
  private readonly maxAttempts = 5;
  private readonly dispatcherUnsubs: Array<() => void> = [];

  private constructor() {
    this.attachDispatcherListeners();
  }

  public static getInstance(): WebhookManager {
    if (!WebhookManager.instance) {
      WebhookManager.instance = new WebhookManager();
    }

    return WebhookManager.instance;
  }

  public register(input: WebhookRegistrationInput): WebhookCreateResult {
    const registration: WebhookRegistration = {
      id: randomUUID(),
      url: input.url,
      secret: input.secret?.trim() || randomBytes(32).toString('hex'),
      events: input.events && input.events.length > 0 ? [...new Set(input.events)] : [...ALL_EVENTS],
      enabled: true,
      createdAt: now(),
      updatedAt: now()
    };

    this.webhooks.set(registration.id, registration);
    this.logs.set(registration.id, []);

    return toCreateResult(registration);
  }

  public list(): WebhookView[] {
    return Array.from(this.webhooks.values()).map(toView);
  }

  public get(webhookId: string): WebhookView | undefined {
    const registration = this.webhooks.get(webhookId);

    return registration ? toView(registration) : undefined;
  }

  public delete(webhookId: string): WebhookView | undefined {
    const registration = this.webhooks.get(webhookId);

    if (!registration) {
      return undefined;
    }

    this.webhooks.delete(webhookId);

    return toView(registration);
  }

  public getDeliveries(webhookId: string): WebhookDeliveryReport {
    const logs = [...(this.logs.get(webhookId) ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return {
      summary: summarizeLogs(logs),
      logs
    };
  }

  public initialize(): WebhookManager {
    return this;
  }

  private attachDispatcherListeners(): void {
    const events: WebhookEventName[] = [...ALL_EVENTS];

    for (const event of events) {
      const unsubscribe = webhookDispatcher.on(event, (payload) => {
        this.enqueueEvent(event, payload);
      });

      this.dispatcherUnsubs.push(unsubscribe);
    }
  }

  private enqueueEvent<E extends WebhookEventName>(event: E, payload: WebhookEventPayloadMap[E]): void {
    const targets = Array.from(this.webhooks.values()).filter((registration) => registration.enabled && registration.events.includes(event));

    if (targets.length === 0) {
      return;
    }

    for (const target of targets) {
      const deliveryId = randomUUID();
      const createdAt = now();

      this.pushLog(target.id, {
        id: deliveryId,
        webhookId: target.id,
        event,
        status: 'PENDING',
        attempt: 1,
        responseStatus: null,
        error: null,
        nextAttemptAt: null,
        createdAt,
        updatedAt: createdAt,
        deliveredAt: null
      });

      this.queue.push({
        deliveryId,
        webhookId: target.id,
        event,
        payload,
        attempt: 1,
        runAt: Date.now()
      });
    }

    this.scheduleProcessing();
  }

  private pushLog(webhookId: string, log: WebhookDeliveryLog): void {
    const current = this.logs.get(webhookId) ?? [];
    current.push(log);
    this.logs.set(webhookId, clampLogs(current));
  }

  private updateLog(webhookId: string, deliveryId: string, patch: Partial<WebhookDeliveryLog>): void {
    const current = this.logs.get(webhookId) ?? [];
    const index = current.findIndex((item) => item.id === deliveryId);

    if (index === -1) {
      return;
    }

    current[index] = {
      ...current[index],
      ...patch,
      updatedAt: now()
    };

    this.logs.set(webhookId, clampLogs(current));
  }

  private scheduleProcessing(): void {
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    const nextRunAt = Math.min(...this.queue.map((task) => task.runAt));
    const waitMs = Math.max(0, nextRunAt - Date.now());

    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      void this.processQueue();
    }, waitMs);
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (true) {
        const index = this.queue.findIndex((task) => task.runAt <= Date.now());

        if (index === -1) {
          break;
        }

        const task = this.queue.splice(index, 1)[0];

        if (task) {
          await this.deliver(task);
        }
      }
    } finally {
      this.processing = false;
      this.scheduleProcessing();
    }
  }

  private async deliver(task: QueueTask): Promise<void> {
    const registration = this.webhooks.get(task.webhookId);

    if (!registration) {
      this.updateLog(task.webhookId, task.deliveryId, {
        status: 'FAILED',
        error: 'Webhook no longer exists',
        nextAttemptAt: null,
        responseStatus: null,
        deliveredAt: null
      });
      return;
    }

    const envelope = {
      id: task.deliveryId,
      event: task.event,
      occurredAt: now(),
      data: task.payload
    } satisfies SignedEnvelope<WebhookEventPayloadMap[WebhookEventName]>;

    const body = JSON.stringify(envelope);
    const signature = createHmac('sha256', registration.secret).update(body).digest('hex');
    const controller = new AbortController();
    const timeoutMs = 10000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(registration.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': registration.id,
          'X-Webhook-Event': task.event,
          'X-Webhook-Delivery-Id': task.deliveryId,
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': envelope.occurredAt
        },
        body,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Webhook responded with ${response.status}`);
      }

      this.updateLog(task.webhookId, task.deliveryId, {
        status: 'DELIVERED',
        responseStatus: response.status,
        error: null,
        nextAttemptAt: null,
        deliveredAt: now()
      });
    } catch (error) {
      const nextAttempt = task.attempt + 1;
      const retryDelayMs = Math.min(30000, 1000 * 2 ** (task.attempt - 1));
      const nextAttemptAt = nextAttempt <= this.maxAttempts ? new Date(Date.now() + retryDelayMs).toISOString() : null;

      this.updateLog(task.webhookId, task.deliveryId, {
        status: nextAttempt <= this.maxAttempts ? 'RETRYING' : 'FAILED',
        responseStatus: null,
        error: error instanceof Error ? error.message : 'Unknown webhook delivery failure',
        nextAttemptAt,
        deliveredAt: null
      });

      logger.warn(
        {
          webhookId: task.webhookId,
          deliveryId: task.deliveryId,
          event: task.event,
          attempt: task.attempt,
          error: error instanceof Error ? error.message : error
        },
        'webhook delivery failed'
      );

      if (nextAttempt <= this.maxAttempts && nextAttemptAt) {
        this.queue.push({
          ...task,
          attempt: nextAttempt,
          runAt: Date.parse(nextAttemptAt)
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const webhookManager = WebhookManager.getInstance();

export function initializeWebhooks(): WebhookManager {
  return webhookManager.initialize();
}
