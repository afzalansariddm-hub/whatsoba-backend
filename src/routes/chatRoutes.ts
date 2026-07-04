import { Router } from 'express';

import { getChat, getChatMessages, listChats } from '../controllers/chat.controller';

export const chatRouter = Router();

chatRouter.get('/', listChats);
chatRouter.get('/:jid/messages', getChatMessages);
chatRouter.get('/:jid', getChat);
