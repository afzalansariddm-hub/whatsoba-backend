import type { SupabaseClient } from '@supabase/supabase-js';

import { logger } from '../../config/logger';
import { SUPABASE_SYNC_TABLES } from '../../config/supabase';
import type { SyncContext, SyncContactLike } from './types';

interface ContactRow {
  session_id: string;
  workspace_id: string;
  connection_id: string;
  contact_id: string;
  jid: string;
  name: string | null;
  push_name: string | null;
  verified_name: string | null;
  image_url: string | null;
  is_business: boolean | null;
  is_my_contact: boolean | null;
  status: string | null;
  metadata: Record<string, unknown>;
  synced_at: string;
}

interface SyncResult {
  successCount: number;
  failureCount: number;
}

function now(): string {
  return new Date().toISOString();
}

function getContactId(contact: SyncContactLike): string | null {
  return contact.jid ?? contact.id ?? null;
}

function toContactRow(context: SyncContext, contact: SyncContactLike): ContactRow | null {
  const contactId = getContactId(contact);

  if (!contactId) {
    return null;
  }

  const metadata = { ...contact };

  return {
    session_id: context.sessionId,
    workspace_id: context.workspaceId,
    connection_id: context.connectionId,
    contact_id: contactId,
    jid: contactId,
    name: contact.name ?? contact.notify ?? null,
    push_name: contact.notify ?? contact.name ?? null,
    verified_name: contact.verifiedName ?? null,
    image_url: typeof contact.imgUrl === 'string' ? contact.imgUrl : typeof contact.img_url === 'string' ? contact.img_url : null,
    is_business: typeof contact.isBusiness === 'boolean' ? contact.isBusiness : null,
    is_my_contact: typeof contact.isMyContact === 'boolean' ? contact.isMyContact : null,
    status: typeof contact.status === 'string' ? contact.status : null,
    metadata,
    synced_at: now()
  };
}

async function upsertContact(supabase: SupabaseClient, row: ContactRow): Promise<void> {
  const { error } = await supabase.from(SUPABASE_SYNC_TABLES.contacts).upsert(row, {
    onConflict: 'session_id,contact_id'
  });

  if (error) {
    throw error;
  }
}

export async function syncContacts(
  supabase: SupabaseClient,
  context: SyncContext,
  contacts: SyncContactLike[]
): Promise<SyncResult> {
  let successCount = 0;
  let failureCount = 0;

  for (const contact of contacts) {
    const row = toContactRow(context, contact);

    if (!row) {
      failureCount += 1;
      continue;
    }

    try {
      await upsertContact(supabase, row);
      successCount += 1;
    } catch (error) {
      failureCount += 1;
      logger.warn(
        {
          sessionId: context.sessionId,
          contactId: row.contact_id,
          err: error
        },
        'contact sync failed'
      );
    }
  }

  return {
    successCount,
    failureCount
  };
}
