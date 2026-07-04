import { AppError } from '../../utils/app-error';
import type { ContactDetail, ContactListFilters, ContactListItem } from '../../services/api/types';
import { BaseApiRepository } from './base-repository';
import { escapeLike, normalizeText, uniqueBy } from './utils';

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
  contact_id: string | null;
  last_message_at: string | null;
  unread_count: number | null;
  is_group: boolean | null;
  is_archived: boolean | null;
  is_pinned: boolean | null;
  last_message: string | null;
  last_message_type: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  timestamp: string;
}

function toBoolean(value: unknown): boolean {
  return Boolean(value);
}

function toContactListItem(row: ContactRow, conversationCount: number, lastMessageAt: string | null): ContactListItem {
  return {
    id: row.id,
    displayName: row.display_name ?? row.push_name ?? row.jid,
    phone: row.phone,
    avatar: row.profile_photo,
    isBusiness: toBoolean(row.is_business),
    lastSeen: row.last_seen,
    conversationCount,
    lastMessageAt
  };
}

function buildContactSearchClause(pattern: string): string {
  return `phone.ilike.${pattern},display_name.ilike.${pattern},push_name.ilike.${pattern},jid.ilike.${pattern}`;
}

function buildConversationSearchClause(pattern: string): string {
  return `last_message.ilike.${pattern},chat_jid.ilike.${pattern}`;
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
    const stats = await this.fetchConversationStats(sliced.map((row) => row.id));

    return sliced.map((row) => toContactListItem(row, stats.counts.get(row.id) ?? 0, stats.lastMessageAt.get(row.id) ?? null));
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

    const conversations = await this.fetchConversationsByContactId(workspaceId, contact.id);
    const conversationIds = conversations.map((conversation) => conversation.id);
    const messageStats = conversationIds.length > 0 ? await this.fetchMessageStats(conversationIds) : { sent: 0, received: 0 };
    const latestConversation = conversations.sort((left, right) => (right.last_message_at ?? '').localeCompare(left.last_message_at ?? ''))[0] ?? null;
    const lastActivity = latestConversation?.last_message_at ?? contact.last_seen ?? null;

    return {
      contact,
      latestConversation,
      statistics: {
        conversationCount: conversations.length,
        messagesSent: messageStats.sent,
        messagesReceived: messageStats.received,
        lastActivity
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

    const [contactsResult, conversationsResult] = await Promise.all([
      supabase
        .from('whatsapp_contacts')
        .select('id,workspace_id,connection_id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,created_at,updated_at')
        .eq('workspace_id', workspaceId)
        .or(buildContactSearchClause(pattern)),
      supabase
        .from('whatsapp_conversations')
        .select('contact_id')
        .eq('workspace_id', workspaceId)
        .or(buildConversationSearchClause(pattern))
    ]);

    if (contactsResult.error) {
      throw contactsResult.error;
    }

    if (conversationsResult.error) {
      throw conversationsResult.error;
    }

    const directContacts = (contactsResult.data ?? []) as ContactRow[];
    const contactIds = uniqueBy((conversationsResult.data ?? []).map((row) => String((row as { contact_id?: string | null }).contact_id ?? '')).filter(Boolean), (value) => value);

    if (contactIds.length === 0) {
      return directContacts;
    }

    const { data: matchedContacts, error } = await supabase
      .from('whatsapp_contacts')
      .select('id,workspace_id,connection_id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,created_at,updated_at')
      .eq('workspace_id', workspaceId)
      .in('id', contactIds);

    if (error) {
      throw error;
    }

    return [...directContacts, ...((matchedContacts ?? []) as ContactRow[])];
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
}
