import { Router } from 'express';

import { getContact, listContacts } from '../controllers/contact.controller';

export const contactRouter = Router();

contactRouter.get('/', listContacts);
contactRouter.get('/:id', getContact);
