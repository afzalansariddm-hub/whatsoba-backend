import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from './env';
import { logger } from './logger';

export const SUPABASE_SYNC_TABLES = {
  contacts: 'whatsapp_contacts',
  conversations: 'whatsapp_conversations',
  messages: 'whatsapp_messages'
} as const;

let supabaseClient: SupabaseClient | null = null;

function buildSupabaseClient(): SupabaseClient | null {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    return null;
  }

  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient === null) {
    supabaseClient = buildSupabaseClient();

    if (!supabaseClient) {
      logger.warn('Supabase sync is disabled because SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing');
    }
  }

  return supabaseClient;
}
