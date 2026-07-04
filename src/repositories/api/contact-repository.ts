import { AppError } from '../../utils/app-error';
import type {
  ContactConversationItem,
  ContactConversationsFilters,
  ContactDetail,
  ContactListFilters,
  ContactListItem,
  ContactMessageItem,
  ContactMessagesFilters
} from '../../services/api/types';
import { BaseApiRepository } from './base-repository';
import { escapeLike, maxIso, minIso, normalizeText, uniqueBy } from './utils';

interface ContactRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  jid: string;
  phone: string | null;
  display_name: string | null;
  push_name: string | null;
  profile_photo: string | null;
  is_business: boolean | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

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
  created_at: string;
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
  chat_jid?: string;
}

interface ContactAggregate {
  conversationCount: number;
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  lastActivity: string | null;
  latestConversation: ContactConversationItem | null;
}

function toBoolean(value: unknown): boolean {
  return Boolean(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toContactConversationItem(row: ConversationRow, messageCount: number): ContactConversationItem {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    lastMessage: row.last_message,
    lastMessageType: row.last_message_type,
    lastMessageAt: row.last_message_at,
    unreadCount: toNumber(row.unread_count),
    isGroup: toBoolean(row.is_group),
    isArchived: toBoolean(row.is_archived),
    isPinned: toBoolean(row.is_pinned),
    messageCount
  };
}

function toContactMessageItem(row: MessageRow): ContactMessageItem {
  return {
    id: row.id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    chatJid: row.chat_jid ?? '',
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

function toContactListItem(
  row: ContactRow,
  aggregate: ContactAggregate
): ContactListItem {
  return {
    id: row.id,
    displayName: row.display_name ?? row.push_name ?? row.jid,
    phone: row.phone,
    avatar: row.profile_photo,
    about: null,
    isBusiness: toBoolean(row.is_business),
    lastSeen: row.last_seen,
    firstMessageAt: aggregate.firstMessageAt,
    lastMessageAt: aggregate.lastMessageAt,
    conversationCount: aggregate.conversationCount,
    messageCount: aggregate.messageCount,
    lastActivity: aggregate.lastActivity,
    latestConversation: aggregate.latestConversation
  };
}

function buildContactSearchClause(pattern: string): string {
  return `phone.ilike.${pattern},display_name.ilike.${pattern},push_name.ilike.${pattern},jid.ilike.${pattern}`;
}

export class ContactRepository extends BaseApiRepository {
  public async listContacts(filters: ContactListFilters): Promise<ContactListItem[]> {
    const search = normalizeText(filters.search);
    const rows = search ? await this.fetchSearchCandidates(filters.workspaceId, search) : await this.fetchPagedContacts(filters);
    const uniqueRows = uniqueBy(rows, (row) => row.jid);
    const sortedRows = uniqueRows.sort((left, right) => {
      const leftValue = (left.display_name ?? left.push_name ?? left.jid).toLowerCase();
      const rightValue = (right.display_name ?? right.push_name ?? right.jid).toLowerCase();
      return filters.sort === 'asc' ? leftValue.localeCompare(rightValue) : rightValue.localeCompare(leftValue);
    });
    const sliced = sortedRows.slice(filters.offset, filters.offset + filters.limit);
    const aggregates = await this.fetchContactAggregates(filters.workspaceId, sliced.map((row) => row.id));

    return sliced.map((row) => {
      const aggregate = aggregates.get(row.id) ?? {
        conversationCount: 0,
        messageCount: 0,
        firstMessageAt: null,
        lastMessageAt: row.last_seen,
        lastActivity: row.last_seen,
        latestConversation: null
      };

      return toContactListItem(row, aggregate);
    });
  }

  public async getContactById(workspaceId: string, contactId: string): Promise<ContactDetail | null> {
    const supabase = this.requireSupabaseClient();
    const { data, error } = await supabase
      .from('whatsapp_contacts')
      .select('id,workspace_id,connection_id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,created_at,updated_at')
      .eq('workspace_id', workspaceId)
      .eq('id', contactId)
      .limit(1);

    if (error) {
      throw error;
    }

    const contact = (data?.[0] as ContactRow | undefined) ?? null;

    if (!contact) {
      return null;
    }

    const aggregates = await this.fetchContactAggregates(workspaceId, [contact.id]);
    const contactAggregate = aggregates.get(contact.id) ?? {
        conversationCount: 0,
        messageCount: 0,
        firstMessageAt: null,
        lastMessageAt: contact.last_seen,
        lastActivity: contact.last_seen,
        latestConversation: null
      };
    const conversations = await this.fetchConversationsForContacts(workspaceId, [contact.id]);
    const messages = conversations.length > 0 ? await this.fetchMessagesForConversationIds(workspaceId, conversations.map((conversation) => conversation.id)) : [];
    const messagesSent = messages.filter((message) => message.direction === 'outbound').length;
    const messagesReceived = messages.filter((message) => message.direction === 'inbound').length;
    const contactView = toContactListItem(contact, contactAggregate);

    return {
      contact: contactView,
      latestConversation: contactAggregate.latestConversation,
      statistics: {
        conversationCount: conversations.length,
        messageCount: contactAggregate.messageCount,
        messagesSent,
        messagesReceived,
        firstMessageAt: contactAggregate.firstMessageAt,
        lastMessageAt: contactAggregate.lastMessageAt,
        lastActivity: contactAggregate.lastActivity
      }
    };
  }

  private async fetchPagedContacts(filters: ContactListFilters): Promise<ContactRow[]> {
    const supabase = this.requireSupabaseClient();
    const pageSize = Math.max(filters.limit, 1);
    const chunkSize = Math.max(pageSize * 3, 50);
    const collected: ContactRow[] = [];
    let rawOffset = 0;

    while (collected.length < filters.offset + pageSize) {
      let query = supabase
        .from('whatsapp_contacts')
        .select('id,workspace_id,connection_id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,created_at,updated_at')
        .eq('workspace_id', filters.workspaceId)
        .order('updated_at', { ascending: false })
        .range(rawOffset, rawOffset + chunkSize - 1);

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      const rows = (data ?? []) as ContactRow[];

      if (rows.length === 0) {
        break;
      }

      collected.push(...rows);
      rawOffset += chunkSize;

      if (rows.length < chunkSize) {
        break;
      }
    }

    return collected;
  }

  private async fetchSearchCandidates(workspaceId: string, search: string): Promise<ContactRow[]> {
    const supabase = this.requireSupabaseClient();
    const pattern = `%${escapeLike(search)}%`;

    const { data, error } = await supabase
      .from('whatsapp_contacts')
      .select('id,workspace_id,connection_id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,created_at,updated_at')
      .eq('workspace_id', workspaceId)
      .or(buildContactSearchClause(pattern));

    if (error) {
      throw error;
    }

    return (data ?? []) as ContactRow[];
  }

  private async fetchConversationStats(contactIds: string[]): Promise<{ counts: Map<string, number>; lastMessageAt: Map<string, string> }> {
    const supabase = this.requireSupabaseClient();

    if (contactIds.length === 0) {
      return { counts: new Map(), lastMessageAt: new Map() };
    }

    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .select('id,contact_id,last_message_at')
      .in('contact_id', contactIds);

    if (error) {
      throw error;
    }

    const counts = new Map<string, number>();
    const lastMessageAt = new Map<string, string>();

    for (const row of (data ?? []) as ConversationRow[]) {
      if (!row.contact_id) {
        continue;
      }

      counts.set(row.contact_id, (counts.get(row.contact_id) ?? 0) + 1);

      if (row.last_message_at) {
        const current = lastMessageAt.get(row.contact_id);
        if (!current || row.last_message_at > current) {
          lastMessageAt.set(row.contact_id, row.last_message_at);
        }
      }
    }

    return { counts, lastMessageAt };
  }

  private async fetchConversationsByContactId(workspaceId: string, contactId: string): Promise<ConversationRow[]> {
    const supabase = this.requireSupabaseClient();
    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .select('id,contact_id,last_message_at,unread_count,is_group,is_archived,is_pinned,last_message,last_message_type')
      .eq('workspace_id', workspaceId)
      .eq('contact_id', contactId)
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (error) {
      throw error;
    }

    return (data ?? []) as ConversationRow[];
  }

  private async fetchMessageStats(conversationIds: string[]): Promise<{ sent: number; received: number }> {
    const supabase = this.requireSupabaseClient();
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('direction')
      .in('conversation_id', conversationIds);

    if (error) {
      throw error;
    }

    let sent = 0;
    let received = 0;

    for (const row of (data ?? []) as MessageRow[]) {
      if (row.direction === 'outbound') {
        sent += 1;
      } else {
        received += 1;
      }
    }

    return { sent, received };
  }

  private async fetchContactAggregates(workspaceId: string, contactIds: string[]): Promise<Map<string, ContactAggregate>> {
    if (contactIds.length === 0) {
      return new Map();
    }

    const conversations = await this.fetchConversationsForContacts(workspaceId, contactIds);
    const conversationIds = conversations.map((conversation) => conversation.id);
    const messages = conversationIds.length > 0 ? await this.fetchMessagesForConversationIds(workspaceId, conversationIds) : [];
    const messagesByConversationId = new Map<string, MessageRow[]>();
    const conversationsByContactId = new Map<string, ConversationRow[]>();
    const messagesByContactId = new Map<string, MessageRow[]>();

    for (const conversation of conversations) {
      if (!conversation.contact_id) {
        continue;
      }

      const items = conversationsByContactId.get(conversation.contact_id) ?? [];
      items.push(conversation);
      conversationsByContactId.set(conversation.contact_id, items);
    }

    for (const message of messages) {
      const byConversation = messagesByConversationId.get(message.conversation_id) ?? [];
      byConversation.push(message);
      messagesByConversationId.set(message.conversation_id, byConversation);

      const conversation = conversations.find((item) => item.id === message.conversation_id);
      if (!conversation?.contact_id) {
        continue;
      }

      const byContact = messagesByContactId.get(conversation.contact_id) ?? [];
      byContact.push(message);
      messagesByContactId.set(conversation.contact_id, byContact);
    }

    const aggregates = new Map<string, ContactAggregate>();

    for (const contactId of contactIds) {
      const contactConversations = conversationsByContactId.get(contactId) ?? [];
      const contactMessages = messagesByContactId.get(contactId) ?? [];
      const latestConversationRow =
        contactConversations
          .slice()
          .sort((left, right) => (right.last_message_at ?? right.updated_at ?? '').localeCompare(left.last_message_at ?? left.updated_at ?? ''))[0] ?? null;
      const latestConversationMessageCount = latestConversationRow ? (messagesByConversationId.get(latestConversationRow.id) ?? []).length : 0;
      const latestConversation = latestConversationRow ? toContactConversationItem(latestConversationRow, latestConversationMessageCount) : null;
      const firstMessageAt = minIso(contactMessages.map((message) => message.timestamp));
      const lastMessageAt = maxIso(contactMessages.map((message) => message.timestamp));
      const lastActivity = maxIso([
        latestConversation?.lastMessageAt ?? null,
        lastMessageAt,
        contactConversations[0]?.updated_at ?? null
      ]);

      aggregates.set(contactId, {
        conversationCount: contactConversations.length,
        messageCount: contactMessages.length,
        firstMessageAt,
        lastMessageAt: lastMessageAt ?? latestConversation?.lastMessageAt ?? null,
        lastActivity: lastActivity ?? latestConversation?.lastMessageAt ?? null,
        latestConversation
      });
    }

    return aggregates;
  }

  private async fetchConversationsForContacts(workspaceId: string, contactIds: string[]): Promise<ConversationRow[]> {
    const supabase = this.requireSupabaseClient();

    if (contactIds.length === 0) {
      return [];
    }

    const { data, error } = await supabase
      .from('whatsapp_conversations')
      .select('id,workspace_id,connection_id,chat_jid,contact_id,last_message,last_message_type,last_message_at,unread_count,is_group,is_archived,is_pinned,created_at,updated_at')
      .eq('workspace_id', workspaceId)
      .in('contact_id', contactIds)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });

    if (error) {
      throw error;
    }

    return (data ?? []) as ConversationRow[];
  }

  private async fetchMessagesForConversationIds(workspaceId: string, conversationIds: string[]): Promise<MessageRow[]> {
    const supabase = this.requireSupabaseClient();

    if (conversationIds.length === 0) {
      return [];
    }

    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('id,conversation_id,message_id,sender_jid,recipient_jid,direction,message_type,text,media_url,status,timestamp')
      .eq('workspace_id', workspaceId)
      .in('conversation_id', conversationIds)
      .order('timestamp', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    return (data ?? []) as MessageRow[];
  }

  public async listContactConversations(filters: ContactConversationsFilters): Promise<ContactConversationItem[]> {
    const conversations = await this.fetchConversationsForContacts(filters.workspaceId, [filters.contactId]);
    const conversationIds = conversations.map((conversation) => conversation.id);
    const messages = conversationIds.length > 0 ? await this.fetchMessagesForConversationIds(filters.workspaceId, conversationIds) : [];
    const messageCountByConversationId = new Map<string, number>();

    for (const message of messages) {
      messageCountByConversationId.set(message.conversation_id, (messageCountByConversationId.get(message.conversation_id) ?? 0) + 1);
    }

    const sorted = conversations.sort((left, right) => {
      const leftValue = left.last_message_at ?? left.updated_at ?? '';
      const rightValue = right.last_message_at ?? right.updated_at ?? '';
      return filters.sort === 'asc' ? leftValue.localeCompare(rightValue) : rightValue.localeCompare(leftValue);
    });
    const paged = sorted.slice(filters.offset, filters.offset + filters.limit);

    return paged.map((conversation) => toContactConversationItem(conversation, messageCountByConversationId.get(conversation.id) ?? 0));
  }

  public async listContactMessages(filters: ContactMessagesFilters): Promise<ContactMessageItem[]> {
    const conversations = await this.fetchConversationsForContacts(filters.workspaceId, [filters.contactId]);
    const conversationIds = conversations.map((conversation) => conversation.id);
    const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation] as const));
    const messages = conversationIds.length > 0 ? await this.fetchMessagesForConversationIds(filters.workspaceId, conversationIds) : [];
    const sorted = messages.sort((left, right) => {
      const leftValue = left.timestamp ?? '';
      const rightValue = right.timestamp ?? '';
      return filters.sort === 'asc' ? leftValue.localeCompare(rightValue) : rightValue.localeCompare(leftValue);
    });
    const paged = sorted.slice(filters.offset, filters.offset + filters.limit);

    return paged.map((message) => {
      const conversation = conversationById.get(message.conversation_id);

      return toContactMessageItem({
        ...message,
        chat_jid: conversation?.chat_jid ?? ''
      });
    });
  }
}
