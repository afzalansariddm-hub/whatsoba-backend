import { pathToFileURL } from 'node:url';

import { sessionManager } from '../sessions';
import { webhookDispatcher } from '../webhooks';
import { AppError } from '../utils/app-error';
import type { SendMediaMessageInput, SendMediaMessageResult, SendTextMessageInput, SendTextMessageResult } from '../types/message';
import { detectMediaKind } from '../utils/media-types';
import { toSentWebhookMessageEvent } from '../utils/webhook-message-event';

type SendMessageResult = {
  key?: {
    id?: string;
    timestamp?: number | null;
  };
};

type MediaSendContent = Record<string, unknown>;

export class MessageService {
  private static instance: MessageService | undefined;

  private constructor() {}

  public static getInstance(): MessageService {
    if (!MessageService.instance) {
      MessageService.instance = new MessageService();
    }

    return MessageService.instance;
  }

  public async sendText(input: SendTextMessageInput): Promise<SendTextMessageResult> {
    const session = sessionManager.getByConnectionId(input.connectionId);

    if (!session) {
      throw new AppError('Session not found', 404);
    }

    if (session.status !== 'CONNECTED') {
      throw new AppError('Session is not connected', 409);
    }

    const client = sessionManager.getClientByConnectionId(input.connectionId);

    if (!client) {
      throw new AppError('Session client is unavailable', 409);
    }

    const message = (await client.sendMessage(input.chatId, { text: input.text })) as SendMessageResult | undefined;

    if (!message?.key?.id) {
      throw new AppError('Failed to send message', 502);
    }

    const timestamp = message.key.timestamp ? new Date(message.key.timestamp * 1000).toISOString() : new Date().toISOString();

    webhookDispatcher.emit(
      'message.sent',
      toSentWebhookMessageEvent({
        connectionId: input.connectionId,
        messageId: message.key.id,
        chatId: input.chatId,
        sender: session.phone ?? session.connectionId,
        timestamp,
        type: 'conversation',
        text: input.text
      })
    );

    return {
      messageId: message.key.id,
      timestamp,
      status: 'SENT'
    };
  }

  public async sendMedia(input: SendMediaMessageInput): Promise<SendMediaMessageResult> {
    const session = sessionManager.getByConnectionId(input.connectionId);

    if (!session) {
      throw new AppError('Session not found', 404);
    }

    if (session.status !== 'CONNECTED') {
      throw new AppError('Session is not connected', 409);
    }

    const client = sessionManager.getClientByConnectionId(input.connectionId);

    if (!client) {
      throw new AppError('Session client is unavailable', 409);
    }

    const mediaKind = detectMediaKind(input.file.mimetype);

    if (!mediaKind) {
      throw new AppError('Unsupported media type', 415);
    }

    const content = this.createMediaContent(mediaKind, input);
    const message = (await client.sendMessage(input.chatId, content)) as SendMessageResult | undefined;

    if (!message?.key?.id) {
      throw new AppError('Failed to send media message', 502);
    }

    const timestamp = message.key.timestamp ? new Date(message.key.timestamp * 1000).toISOString() : new Date().toISOString();

    webhookDispatcher.emit(
      'message.sent',
      toSentWebhookMessageEvent({
        connectionId: input.connectionId,
        messageId: message.key.id,
        chatId: input.chatId,
        sender: session.phone ?? session.connectionId,
        timestamp,
        type: mediaKind,
        text: input.caption ?? null
      })
    );

    return {
      messageId: message.key.id,
      status: 'SENT',
      mediaUrl: `/media/${input.file.filename}`
    };
  }

  private createMediaContent(mediaKind: 'image' | 'video' | 'audio' | 'document', input: SendMediaMessageInput): MediaSendContent {
    const fileUrl = { url: pathToFileURL(input.file.path).toString() };

    if (mediaKind === 'image') {
      return {
        image: fileUrl,
        caption: input.caption ?? undefined
      };
    }

    if (mediaKind === 'video') {
      return {
        video: fileUrl,
        caption: input.caption ?? undefined
      };
    }

    if (mediaKind === 'audio') {
      return {
        audio: fileUrl,
        mimetype: input.file.mimetype,
        caption: input.caption ?? undefined
      };
    }

    return {
      document: fileUrl,
      mimetype: input.file.mimetype,
      fileName: input.file.originalname,
      caption: input.caption ?? undefined
    };
  }
}

export const messageService = MessageService.getInstance();
