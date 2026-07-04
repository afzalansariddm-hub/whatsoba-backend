import { ChatRepository } from '../../repositories/api/chat-repository';
import type { ChatDetail, ChatListFilters, ChatListItem, ChatMessageFilters, ApiMessageItem } from './types';

export class ChatService {
  private readonly repository = new ChatRepository();

  public async listChats(filters: ChatListFilters): Promise<ChatListItem[]> {
    return this.repository.listChats(filters);
  }

  public async getChat(workspaceId: string, connectionId: string | undefined, jid: string): Promise<ChatDetail | null> {
    return this.repository.getChatByJid(workspaceId, connectionId, jid);
  }

  public async listMessages(filters: ChatMessageFilters): Promise<ApiMessageItem[]> {
    return this.repository.listChatMessages(filters);
  }
}

export const chatService = new ChatService();
