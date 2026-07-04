import { AppError } from '../../utils/app-error';
import { BaseApiRepository } from './base-repository';
import type { ChatDetail, ChatListFilters, ChatListItem, ChatMessageFilters, ApiMessageItem } from '../../services/api/types';
import { escapeLike, normalizeJid, normalizeText, uniqueBy } from './utils';

interface ConversationRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  chat_jid: string;
  contact_id: string | null;
  last_message: string | null;
  last_message_type: string | null;
  last_message_at: string | null;
  unread_count: number | null;
  is_group: boolean | null;
  is_archived: boolean | null;
  is_pinned: boolean | null;
  updated_at: string;
}

interface ContactRow {
  id: string;
  jid: string;
  phone: string | null;
  display_name: string | null;
  push_name: string | null;
  profile_photo: string | null;
  is_business: boolean | null;
  last_seen: string | null;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  message_id: string;
  sender_jid: string | null;
  recipient_jid: string | null;
  direction: 'inbound' | 'outbound';
  message_type: string;
  text: string | null;
  media_url: string | null;
  status: string;
  timestamp: string;
}

interface ConversationWithContact extends ConversationRow {
  contact: ContactRow | null;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toBoolean(value: unknown): boolean {
  return Boolean(value);
}

function buildContactSearchClause(pattern: string): string {
  return `phone.ilike.${pattern},display_name.ilike.${pattern},push_name.ilike.${pattern},jid.ilike.${pattern}`;
}

function asChatListItem(row: ConversationWithContact): ChatListItem {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    displayName: row.contact?.display_name ?? row.contact?.push_name ?? row.chat_jid,
    phone: row.contact?.phone ?? null,
    avatar: row.contact?.profile_photo ?? null,
    lastMessage: row.last_message,
    lastMessageType: row.last_message_type,
    lastMessageAt: row.last_message_at,
    unreadCount: toNumber(row.unread_count),
    isPinned: toBoolean(row.is_pinned),
    isArchived: toBoolean(row.is_archived),
    isGroup: toBoolean(row.is_group),
    connectionId: row.connection_id
  };
}

function asApiMessageItem(row: MessageRow): ApiMessageItem {
  return {
    id: row.id,
    messageId: row.message_id,
    sender: row.sender_jid,
    recipient: row.recipient_jid,
    direction: row.direction,
    type: row.message_type,
    text: row.text,
    mediaUrl: row.media_url,
    status: row.status,
    timestamp: row.timestamp
  };
}

export class ChatRepository extends BaseApiRepository {
  public async listChats(filters: ChatListFilters): Promise<ChatListItem[]> {
    const search = normalizeText(filters.search);
    const contactIds = search ? await this.findMatchingContactIds(filters.workspaceId, filters.connectionId, search) : [];
    const rows = await this.fetchConversationRows(filters, contactIds, search);

    if (rows.length === 0) {
      return [];
    }

    const contacts = await this.fetchContactsByIds(filters.workspaceId, rows.map((row) => row.contact_id).filter((value): value is string => value !== null));
    return rows.map((row) => asChatListItem({ ...row, contact: row.contact_id ? contacts.get(row.contact_id) ?? null : null }));
  }

  public async getChatByJid(workspaceId: string, connectionId: string | undefined, jid: string): Promise<ChatDetail | null> {
    const supabase = this.requireSupabaseClient();
    const chatJid = normalizeJid(jid);

    if (!chatJid) {
      throw new AppError('jid is required', 400);
    }

    let query = supabase
      .from('whatsapp_conversations')
      .select('id,workspace_id,connection_id,chat_jid,contact_id,last_message,last_message_type,last_message_at,unread_count,is_group,is_archived,is_pinned,updated_at')
      .eq('workspace_id', workspaceId)
      .eq('chat_jid', chatJid)
      .limit(1);

    if (connectionId) {
      query = query.eq('connection_id', connectionId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const conversation = (data?.[0] as ConversationRow | undefined) ?? null;

    if (!conversation) {
      return null;
    }

    const contact = conversation.contact_id ? await this.fetchContactById(workspaceId, conversation.contact_id) : null;
    const latestMessage = await this.fetchLatestMessage(conversation.id);

    return {
      conversation,
      contact,
      latestMessage: latestMessage ? asApiMessageItem(latestMessage) : null,
      unreadCount: toNumber(conversation.unread_count),
      isGroup: toBoolean(conversation.is_group),
      isPinned: toBoolean(conversation.is_pinned),
      isArchived: toBoolean(conversation.is_archived)
    };
  }

  public async listChatMessages(filters: ChatMessageFilters): Promise<ApiMessageItem[]> {
    const supabase = this.requireSupabaseClient();
    const chatJid = normalizeJid(filters.jid);

    if (!chatJid) {
      throw new AppError('jid is required', 400);
    }

    const conversation = await this.findConversationByJid(filters.workspaceId, filters.connectionId, chatJid);

    if (!conversation) {
      return [];
    }

    let query = supabase
      .from('whatsapp_messages')
      .select('id,conversation_id,message_id,sender_jid,recipient_jid,direction,message_type,text,media_url,status,timestamp')
      .eq('workspace_id', filters.workspaceId)
      .eq('conversation_id', conversation.id)
      .order('timestamp', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(filters.limit);

    if (filters.before) {
      query = query.lt('timestamp', filters.before);
    }

    if (filters.after) {
      query = query.gt('timestamp', filters.after);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const items = uniqueBy((data ?? []).map((row) => asApiMessageItem(row as MessageRow)), (message) => message.messageId);

    return items;
  }

  private async findMatchingContactIds(workspaceId: string, connectionId: string | undefined, search: string): Promise<string[]> {
    const supabase = this.requireSupabaseClient();
    const pattern = `%${escapeLike(search)}%`;

    let query = supabase
      .from('whatsapp_contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .or(buildContactSearchClause(pattern));

    if (connectionId) {
      query = query.eq('connection_id', connectionId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return uniqueBy((data ?? []).map((row) => String((row as { id?: string }).id)), (value) => value).filter((value): value is string => Boolean(value));
  }

  private async fetchConversationRows(
    filters: ChatListFilters,
    contactIds: string[],
    search: string | null
  ): Promise<ConversationWithContact[]> {
    const supabase = this.requireSupabaseClient();
    const page = Math.max(filters.limit, 1);
    const offset = Math.max(filters.offset, 0);
    const sortAscending = filters.sort === 'asc';
    const pattern = search ? `%${escapeLike(search)}%` : null;

    let query = supabase
      .from('whatsapp_conversations')
      .select('id,workspace_id,connection_id,chat_jid,contact_id,last_message,last_message_type,last_message_at,unread_count,is_group,is_archived,is_pinned,updated_at')
      .eq('workspace_id', filters.workspaceId);

    if (filters.connectionId) {
      query = query.eq('connection_id', filters.connectionId);
    }

    if (filters.unread !== undefined) {
      query = filters.unread ? query.gt('unread_count', 0) : query.eq('unread_count', 0);
    }

    if (filters.groups !== undefined) {
      query = query.eq('is_group', filters.groups);
    }

    if (filters.archived !== undefined) {
      query = query.eq('is_archived', filters.archived);
    }

    if (filters.pinned !== undefined) {
      query = query.eq('is_pinned', filters.pinned);
    }

    if (pattern) {
      const clauses = [`chat_jid.ilike.${pattern}`, `last_message.ilike.${pattern}`];

      if (contactIds.length > 0) {
        clauses.push(`contact_id.in.(${contactIds.join(',')})`);
      }

      query = query.or(clauses.join(','));
    }

    query = query
      .order('last_message_at', { ascending: sortAscending, nullsFirst: sortAscending })
      .order('updated_at', { ascending: sortAscending })
      .range(offset, offset + page - 1);

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const conversations = (data ?? []) as ConversationRow[];
    const contactMap = await this.fetchContactsByIds(filters.workspaceId, conversations.map((row) => row.contact_id).filter((value): value is string => value !== null));

    return conversations.map((conversation) => ({
      ...conversation,
      contact: conversation.contact_id ? contactMap.get(conversation.contact_id) ?? null : null
    }));
  }

  private async fetchContactsByIds(workspaceId: string, contactIds: string[]): Promise<Map<string, ContactRow>> {
    const supabase = this.requireSupabaseClient();

    if (contactIds.length === 0) {
      return new Map();
    }

    const { data, error } = await supabase
      .from('whatsapp_contacts')
      .select('id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,updated_at')
      .eq('workspace_id', workspaceId)
      .in('id', contactIds);

    if (error) {
      throw error;
    }

    return new Map(
      (data ?? []).map((row) => {
        const contact = row as ContactRow;
        return [contact.id, contact] as const;
      })
    );
  }

  private async fetchContactById(workspaceId: string, contactId: string): Promise<ContactRow | null> {
    const supabase = this.requireSupabaseClient();
    const { data, error } = await supabase
      .from('whatsapp_contacts')
      .select('id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,updated_at')
      .eq('workspace_id', workspaceId)
      .eq('id', contactId)
      .limit(1);

    if (error) {
      throw error;
    }

    return (data?.[0] as ContactRow | undefined) ?? null;
  }

  private async fetchLatestMessage(conversationId: string): Promise<MessageRow | null> {
    const supabase = this.requireSupabaseClient();
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('id,conversation_id,message_id,sender_jid,recipient_jid,direction,message_type,text,media_url,status,timestamp')
      .eq('conversation_id', conversationId)
      .order('timestamp', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      throw error;
    }

    return (data?.[0] as MessageRow | undefined) ?? null;
  }

  private async findConversationByJid(workspaceId: string, connectionId: string | undefined, chatJid: string): Promise<ConversationRow | null> {
    const supabase = this.requireSupabaseClient();

    let query = supabase
      .from('whatsapp_conversations')
      .select('id,workspace_id,connection_id,chat_jid,contact_id,last_message,last_message_type,last_message_at,unread_count,is_group,is_archived,is_pinned,updated_at')
      .eq('workspace_id', workspaceId)
      .eq('chat_jid', chatJid)
      .limit(1);

    if (connectionId) {
      query = query.eq('connection_id', connectionId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return (data?.[0] as ConversationRow | undefined) ?? null;
  }
}
