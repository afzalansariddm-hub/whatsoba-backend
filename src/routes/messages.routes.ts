import { Router } from 'express';

import { sendMediaMessage, sendTextMessage } from '../controllers/messages.controller';
import { validateSendMediaMessage } from '../middleware/validate-media-request';
import { validateSendTextMessage } from '../middleware/validate-message-request';
import { uploadMedia } from '../middleware/upload-media';

export const messagesRouter = Router();

messagesRouter.post('/text', validateSendTextMessage, sendTextMessage);
messagesRouter.post('/media', uploadMedia.single('file'), validateSendMediaMessage, sendMediaMessage);
