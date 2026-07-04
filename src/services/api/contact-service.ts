import { ContactRepository } from '../../repositories/api/contact-repository';
import type {
  ContactConversationItem,
  ContactConversationsFilters,
  ContactDetail,
  ContactListFilters,
  ContactListItem,
  ContactMessageItem,
  ContactMessagesFilters
} from './types';

export class ContactService {
  private readonly repository = new ContactRepository();

  public async listContacts(filters: ContactListFilters): Promise<ContactListItem[]> {
    return this.repository.listContacts(filters);
  }

  public async getContact(workspaceId: string, contactId: string): Promise<ContactDetail | null> {
    return this.repository.getContactById(workspaceId, contactId);
  }

  public async listContactConversations(filters: ContactConversationsFilters): Promise<ContactConversationItem[]> {
    return this.repository.listContactConversations(filters);
  }

  public async listContactMessages(filters: ContactMessagesFilters): Promise<ContactMessageItem[]> {
    return this.repository.listContactMessages(filters);
  }
}

export const contactService = new ContactService();
