import { Router } from 'express';

import { getContact, listContactConversations, listContactMessages, listContacts } from '../controllers/contact.controller';

export const contactRouter = Router();

contactRouter.get('/', listContacts);
contactRouter.get('/:id/conversations', listContactConversations);
contactRouter.get('/:id/messages', listContactMessages);
contactRouter.get('/:id', getContact);
