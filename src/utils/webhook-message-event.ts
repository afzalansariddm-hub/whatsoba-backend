import type { IncomingMessage } from '../types/message';
import type { WebhookMessageDirection, WebhookMessageEvent, WebhookMessageStatus, WebhookMessageType } from '../types/webhook';

export interface OutgoingWebhookMessageInput {
  connectionId: string;
  messageId: string;
  chatId: string;
  sender: string | null;
  timestamp: string;
  type: WebhookMessageType;
  text: string | null;
}

export interface MessageReceiptWebhookInput {
  connectionId: string;
  messageId: string;
  chatId: string;
  sender: string | null;
  timestamp: string;
  status: 'DELIVERED' | 'READ';
}

function buildMessageEvent(
  direction: WebhookMessageDirection,
  status: WebhookMessageStatus,
  input: {
    connectionId: string;
    messageId: string;
    chatId: string;
    sender: string | null;
    timestamp: string;
    type: WebhookMessageType;
    text: string | null;
  }
): WebhookMessageEvent {
  return {
    connectionId: input.connectionId,
    messageId: input.messageId,
    chatId: input.chatId,
    sender: input.sender,
    timestamp: input.timestamp,
    type: input.type,
    text: input.text,
    direction,
    status
  };
}

export function toReceivedWebhookMessageEvent(connectionId: string, message: IncomingMessage): WebhookMessageEvent {
  return buildMessageEvent('inbound', 'RECEIVED', {
    connectionId,
    messageId: message.id,
    chatId: message.chatId,
    sender: message.sender,
    timestamp: message.timestamp,
    type: message.type,
    text: message.text
  });
}

export function toSentWebhookMessageEvent(input: OutgoingWebhookMessageInput): WebhookMessageEvent {
  return buildMessageEvent('outbound', 'SENT', input);
}

export function toReceiptWebhookMessageEvent(input: MessageReceiptWebhookInput): WebhookMessageEvent {
  return buildMessageEvent('outbound', input.status, {
    connectionId: input.connectionId,
    messageId: input.messageId,
    chatId: input.chatId,
    sender: input.sender,
    timestamp: input.timestamp,
    type: 'unknown',
    text: null
  });
}
