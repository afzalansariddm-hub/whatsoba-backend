import type { SessionView } from '../utils/session-view';

export const WEBHOOK_EVENTS = [
  'session.connected',
  'session.disconnected',
  'message.received',
  'message.sent',
  'message.delivered',
  'message.read'
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export type WebhookMessageDirection = 'inbound' | 'outbound';
export type WebhookMessageStatus = 'RECEIVED' | 'SENT' | 'DELIVERED' | 'READ';
export type WebhookMessageType = 'conversation' | 'extendedTextMessage' | 'image' | 'video' | 'audio' | 'document' | 'unknown';

export interface WebhookMessageEvent {
  connectionId: string;
  messageId: string;
  chatId: string;
  sender: string | null;
  timestamp: string;
  type: WebhookMessageType;
  text: string | null;
  direction: WebhookMessageDirection;
  status: WebhookMessageStatus;
}

export type WebhookEventPayloadMap = {
  'session.connected': SessionView;
  'session.disconnected': SessionView;
  'message.received': WebhookMessageEvent;
  'message.sent': WebhookMessageEvent;
  'message.delivered': WebhookMessageEvent;
  'message.read': WebhookMessageEvent;
};

export interface WebhookRegistrationInput {
  url: string;
  events?: WebhookEventName[];
  secret?: string;
}

export interface WebhookRegistration {
  id: string;
  url: string;
  secret: string;
  events: WebhookEventName[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookView {
  id: string;
  url: string;
  events: WebhookEventName[];
  enabled: boolean;
  secretConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export type WebhookDeliveryStatus = 'PENDING' | 'RETRYING' | 'DELIVERED' | 'FAILED';

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  event: WebhookEventName;
  status: WebhookDeliveryStatus;
  attempt: number;
  responseStatus: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface WebhookDeliverySummary {
  pending: number;
  retrying: number;
  delivered: number;
  failed: number;
  total: number;
}

export interface WebhookDeliveryReport {
  summary: WebhookDeliverySummary;
  logs: WebhookDeliveryLog[];
}

export interface WebhookCreateResult extends WebhookView {
  secret: string;
}
