import type { Request, Response } from 'express';

import { messageService } from '../services/message.service';
import { sendSuccess } from '../utils/api-response';

export async function sendTextMessage(request: Request, response: Response): Promise<void> {
  const result = await messageService.sendText({
    connectionId: request.body.connectionId,
    chatId: request.body.chatId,
    text: request.body.text
  });

  sendSuccess(response, 201, result);
}

export async function sendMediaMessage(request: Request, response: Response): Promise<void> {
  const result = await messageService.sendMedia({
    connectionId: request.body.connectionId,
    chatId: request.body.chatId,
    caption: request.body.caption,
    file: {
      path: request.file?.path ?? '',
      mimetype: request.file?.mimetype ?? '',
      originalname: request.file?.originalname ?? '',
      filename: request.file?.filename ?? ''
    }
  });

  const baseUrl = `${request.protocol}://${request.get('host')}`;
  sendSuccess(response, 201, {
    ...result,
    mediaUrl: new URL(result.mediaUrl, baseUrl).toString()
  });
}
