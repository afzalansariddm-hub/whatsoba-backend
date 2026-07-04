import type { SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_SYNC_TABLES } from '../../../config/supabase';
import type { SyncContactLike, SyncContext } from '../types';
import type { BulkUpsertResult } from './types';
import { dedupeByKey, nowIso, normalizeJid } from './utils';

export interface ContactRecord {
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

interface ContactRow {
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

function getPhoneFromJid(jid: string): string | null {
  const [phone] = jid.split('@');

  return phone ?? null;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return null;
}

function toContactRow(context: SyncContext, contact: SyncContactLike): ContactRow | null {
  const jid = normalizeJid(contact.jid ?? contact.id);

  if (!jid) {
    return null;
  }

  const now = nowIso();
  const lastSeen = toIsoDate((contact as { lastSeen?: unknown; lastSeenTimestamp?: unknown }).lastSeen ?? (contact as { lastSeen?: unknown; lastSeenTimestamp?: unknown }).lastSeenTimestamp ?? null);

  return {
    workspace_id: context.workspaceId,
    connection_id: context.connectionId,
    jid,
    phone: getPhoneFromJid(jid),
    display_name:
      typeof contact.name === 'string' && contact.name.trim().length > 0
        ? contact.name.trim()
        : typeof contact.verifiedName === 'string' && contact.verifiedName.trim().length > 0
          ? contact.verifiedName.trim()
          : typeof contact.notify === 'string' && contact.notify.trim().length > 0
            ? contact.notify.trim()
            : null,
    push_name:
      typeof contact.notify === 'string' && contact.notify.trim().length > 0
        ? contact.notify.trim()
        : typeof contact.name === 'string' && contact.name.trim().length > 0
          ? contact.name.trim()
          : typeof contact.verifiedName === 'string' && contact.verifiedName.trim().length > 0
            ? contact.verifiedName.trim()
            : null,
    profile_photo: typeof contact.imgUrl === 'string' && contact.imgUrl.trim().length > 0 ? contact.imgUrl.trim() : typeof contact.img_url === 'string' && contact.img_url.trim().length > 0 ? contact.img_url.trim() : null,
    is_business: typeof contact.isBusiness === 'boolean' ? contact.isBusiness : null,
    last_seen: lastSeen,
    created_at: now,
    updated_at: now
  };
}

async function fetchExistingContacts(
  supabase: SupabaseClient,
  context: SyncContext,
  jids: string[]
): Promise<Map<string, { id: string; created_at: string; phone: string | null; display_name: string | null; push_name: string | null; profile_photo: string | null; is_business: boolean | null; last_seen: string | null }>> {
  if (jids.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from(SUPABASE_SYNC_TABLES.contacts)
    .select('id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,created_at')
    .eq('workspace_id', context.workspaceId)
    .eq('connection_id', context.connectionId)
    .in('jid', jids);

  if (error) {
    throw error;
  }

  return new Map(
    (data ?? []).flatMap((row) => {
      const jid = normalizeJid((row as { jid?: string | null }).jid);

      return jid
        ? [
            [
              jid,
              {
                id: String((row as { id?: string | number }).id),
                phone: (row as { phone?: string | null }).phone ?? null,
                display_name: (row as { display_name?: string | null }).display_name ?? null,
                push_name: (row as { push_name?: string | null }).push_name ?? null,
                profile_photo: (row as { profile_photo?: string | null }).profile_photo ?? null,
                is_business: (row as { is_business?: boolean | null }).is_business ?? null,
                last_seen: (row as { last_seen?: string | null }).last_seen ?? null,
                created_at: String((row as { created_at?: string }).created_at ?? nowIso())
              }
            ]
          ]
        : [];
    })
  );
}

export class ContactRepository {
  public async bulkUpsert(context: SyncContext, contacts: SyncContactLike[]): Promise<BulkUpsertResult<ContactRecord>> {
    const inputCount = contacts.length;
    const { records: dedupedContacts, duplicateCount } = dedupeByKey(contacts, (contact) => normalizeJid(contact.jid ?? contact.id));
    const rows = dedupedContacts
      .map((contact) => toContactRow(context, contact))
      .filter((row): row is ContactRow => row !== null);
    const invalidCount = dedupedContacts.length - rows.length;
    const existingByJid = await fetchExistingContacts(
      this.supabaseClient,
      context,
      rows.map((row) => row.jid)
    );
    const now = nowIso();
    const payload = rows.map((row) => {
      const existing = existingByJid.get(row.jid);

      return {
        ...row,
        phone: row.phone ?? existing?.phone ?? null,
        display_name: row.display_name ?? existing?.display_name ?? null,
        push_name: row.push_name ?? existing?.push_name ?? null,
        profile_photo: row.profile_photo ?? existing?.profile_photo ?? null,
        is_business: row.is_business ?? existing?.is_business ?? null,
        last_seen: row.last_seen ?? existing?.last_seen ?? null,
        created_at: existing?.created_at ?? row.created_at,
        updated_at: now
      };
    });

    if (payload.length === 0) {
      return {
        stats: {
          inputCount,
          validCount: 0,
          duplicateCount,
          existingCount: 0,
          persistedCount: 0,
          invalidCount
        },
        records: [],
        byKey: new Map()
      };
    }

    const { data, error } = await this.supabaseClient
      .from(SUPABASE_SYNC_TABLES.contacts)
      .upsert(payload, {
        onConflict: 'workspace_id,connection_id,jid'
      })
      .select('id,workspace_id,connection_id,jid,phone,display_name,push_name,profile_photo,is_business,last_seen,created_at,updated_at');

    if (error) {
      throw error;
    }

    const records = (data ?? []).map((row) => row as ContactRecord);

    return {
      stats: {
        inputCount,
        validCount: rows.length,
        duplicateCount,
        existingCount: existingByJid.size,
        persistedCount: records.length,
        invalidCount
      },
      records,
      byKey: new Map(records.map((record) => [normalizeJid(record.jid) ?? record.jid, record]))
    };
  }

  public constructor(private readonly supabaseClient: SupabaseClient) {}
}

export function createContactRepository(supabaseClient: SupabaseClient): ContactRepository {
  return new ContactRepository(supabaseClient);
}
