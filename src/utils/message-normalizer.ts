import type { IncomingMessage, IncomingMessageType } from '../types/message';

type MessageContent = {
  conversation?: string;
  extendedTextMessage?: {
    text?: string;
  };
};

type MessageKey = {
  id?: string;
  remoteJid?: string;
  participant?: string;
  fromMe?: boolean;
};

type BaileysIncomingMessage = {
  key?: MessageKey;
  messageTimestamp?: number | null;
  message?: MessageContent;
};

type MessagesUpsertEvent = {
  messages?: BaileysIncomingMessage[];
};

function getMessageType(message: MessageContent | undefined): IncomingMessageType {
  if (message?.conversation) {
    return 'conversation';
  }

  if (message?.extendedTextMessage?.text) {
    return 'extendedTextMessage';
  }

  return 'unknown';
}

function getText(message: MessageContent | undefined): string | null {
  if (message?.conversation) {
    return message.conversation;
  }

  if (message?.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  return null;
}

export function normalizeIncomingMessage(event: MessagesUpsertEvent): IncomingMessage[] {
  const messages = event.messages ?? [];

  return messages
    .map((message) => {
      const id = message.key?.id;
      const chatId = message.key?.remoteJid;
      const sender = message.key?.participant ?? (message.key?.fromMe ? chatId ?? null : chatId ?? null);
      const timestamp = message.messageTimestamp ? new Date(message.messageTimestamp * 1000).toISOString() : new Date().toISOString();

      if (!id || !chatId) {
        return null;
      }

      return {
        id,
        chatId,
        sender,
        timestamp,
        type: getMessageType(message.message),
        text: getText(message.message)
      } satisfies IncomingMessage;
    })
    .filter((message): message is IncomingMessage => message !== null);
}
