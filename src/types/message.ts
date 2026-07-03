export interface SendTextMessageInput {
  connectionId: string;
  chatId: string;
  text: string;
}

export interface SendTextMessageResult {
  messageId: string;
  timestamp: string;
  status: 'SENT';
}

export interface MediaFileInput {
  path: string;
  mimetype: string;
  originalname: string;
  filename: string;
}

export interface SendMediaMessageInput {
  connectionId: string;
  chatId: string;
  caption?: string | null;
  file: MediaFileInput;
}

export interface SendMediaMessageResult {
  messageId: string;
  status: 'SENT';
  mediaUrl: string;
}

export type IncomingMessageType = 'conversation' | 'extendedTextMessage' | 'unknown';

export interface IncomingMessage {
  id: string;
  chatId: string;
  sender: string | null;
  timestamp: string;
  type: IncomingMessageType;
  text: string | null;
}
