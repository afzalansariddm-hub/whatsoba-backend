import { BaseApiRepository } from './base-repository';
import type { DashboardSummary } from '../../services/api/types';

function startOfUtcDay(date: Date): string {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return value.toISOString();
}

function startOfUtcWeek(date: Date): string {
  const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = current.getUTCDay();
  const diff = (day + 6) % 7;
  current.setUTCDate(current.getUTCDate() - diff);
  return current.toISOString();
}

export class DashboardRepository extends BaseApiRepository {
  public async getSummary(workspaceId: string): Promise<DashboardSummary> {
    const supabase = this.requireSupabaseClient();
    const today = startOfUtcDay(new Date());
    const thisWeek = startOfUtcWeek(new Date());

    const [
      contactsCount,
      conversationsCount,
      unreadConversationsCount,
      messagesTodayCount,
      messagesThisWeekCount,
      groupsCount,
      lastContactSync,
      lastConversationSync,
      lastMessageSync,
      connectedAccountSets
    ] = await Promise.all([
      this.countRows('whatsapp_contacts', workspaceId),
      this.countRows('whatsapp_conversations', workspaceId),
      this.countRows('whatsapp_conversations', workspaceId, (query) => query.gt('unread_count', 0)),
      this.countRows('whatsapp_messages', workspaceId, (query) => query.gte('timestamp', today)),
      this.countRows('whatsapp_messages', workspaceId, (query) => query.gte('timestamp', thisWeek)),
      this.countRows('whatsapp_conversations', workspaceId, (query) => query.eq('is_group', true)),
      this.fetchLatestTimestamp('whatsapp_contacts', workspaceId),
      this.fetchLatestTimestamp('whatsapp_conversations', workspaceId),
      this.fetchLatestTimestamp('whatsapp_messages', workspaceId),
      Promise.all([
        this.fetchConnectionIds('whatsapp_contacts', workspaceId),
        this.fetchConnectionIds('whatsapp_conversations', workspaceId)
      ])
    ]);

    const connectedAccounts = new Set<string>([...connectedAccountSets[0], ...connectedAccountSets[1]]).size;

    return {
      connectedAccounts,
      contacts: contactsCount,
      conversations: conversationsCount,
      unreadConversations: unreadConversationsCount,
      messagesToday: messagesTodayCount,
      messagesThisWeek: messagesThisWeekCount,
      groups: groupsCount,
      lastSynchronization: [lastContactSync, lastConversationSync, lastMessageSync].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
    };
  }

  private async countRows(
    tableName: string,
    workspaceId: string,
    apply?: (query: any) => any
  ): Promise<number> {
    const supabase = this.requireSupabaseClient();
    let query = supabase.from(tableName).select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);

    if (apply) {
      query = apply(query);
    }

    const { count, error } = await query;

    if (error) {
      throw error;
    }

    return count ?? 0;
  }

  private async fetchLatestTimestamp(tableName: string, workspaceId: string): Promise<string | null> {
    const supabase = this.requireSupabaseClient();
    const { data, error } = await supabase
      .from(tableName)
      .select('updated_at')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error) {
      throw error;
    }

    return ((data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? null) as string | null;
  }

  private async fetchConnectionIds(tableName: string, workspaceId: string): Promise<Set<string>> {
    const supabase = this.requireSupabaseClient();
    const { data, error } = await supabase
      .from(tableName)
      .select('connection_id')
      .eq('workspace_id', workspaceId);

    if (error) {
      throw error;
    }

    return new Set(
      (data ?? [])
        .map((row) => String((row as { connection_id?: string | null }).connection_id ?? ''))
        .filter((value) => value.length > 0)
    );
  }
}
