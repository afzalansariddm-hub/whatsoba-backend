import { ContactRepository } from '../../repositories/api/contact-repository';
import type { ContactDetail, ContactListFilters, ContactListItem } from './types';

export class ContactService {
  private readonly repository = new ContactRepository();

  public async listContacts(filters: ContactListFilters): Promise<ContactListItem[]> {
    return this.repository.listContacts(filters);
  }

  public async getContact(workspaceId: string, contactId: string): Promise<ContactDetail | null> {
    return this.repository.getContactById(workspaceId, contactId);
  }
}

export const contactService = new ContactService();
