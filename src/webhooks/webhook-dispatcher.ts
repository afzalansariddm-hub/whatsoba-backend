import { EventEmitter } from 'node:events';

import type { WebhookEventName, WebhookEventPayloadMap } from '../types/webhook';

type Listener<E extends WebhookEventName> = (payload: WebhookEventPayloadMap[E]) => void | Promise<void>;

class WebhookDispatcher {
  private readonly emitter = new EventEmitter();

  public on<E extends WebhookEventName>(event: E, listener: Listener<E>): () => void {
    this.emitter.on(event, listener as Listener<WebhookEventName>);

    return () => this.emitter.off(event, listener as Listener<WebhookEventName>);
  }

  public emit<E extends WebhookEventName>(event: E, payload: WebhookEventPayloadMap[E]): void {
    this.emitter.emit(event, payload);
  }
}

export const webhookDispatcher = new WebhookDispatcher();
