import { createHash, randomBytes } from 'node:crypto';

import { logger } from '../../config/logger';
import { getSupabaseClient } from '../../config/supabase';
import { AppError } from '../../utils/app-error';

export interface ApiKeyRecord {
  id: string;
  workspace_id: string;
  name: string;
  key_hash: string;
  prefix: string;
  status: 'active' | 'disabled';
  created_at: string;
  last_used_at: string | null;
  created_by: string | null;
}

export interface GeneratedApiKeyResult {
  apiKey: string | null;
  record: ApiKeyRecord;
  created: boolean;
}

export interface GenerateApiKeyInput {
  workspaceId: string;
  name?: string;
  createdBy?: string | null;
}

export interface ApiKeyMetadata {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  status: 'active' | 'disabled';
  createdAt: string;
  lastUsedAt: string | null;
  createdBy: string | null;
}

function normalizeName(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'Default';
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function generateRawKey(): string {
  return `sk_live_${randomBytes(24).toString('hex')}`;
}

function toMetadata(record: ApiKeyRecord): ApiKeyMetadata {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    name: record.name,
    prefix: record.prefix,
    status: record.status,
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at,
    createdBy: record.created_by
  };
}

export class ApiKeyService {
  private static instance: ApiKeyService | undefined;
  private readonly supabaseClient = getSupabaseClient();
  private readonly serviceLogger = logger.child({ module: 'api-key-service' });

  private constructor() {}

  public static getInstance(): ApiKeyService {
    if (!ApiKeyService.instance) {
      ApiKeyService.instance = new ApiKeyService();
    }

    return ApiKeyService.instance;
  }

  public async generateKey(input: GenerateApiKeyInput): Promise<GeneratedApiKeyResult> {
    const supabase = this.requireSupabase();
    const name = normalizeName(input.name);
    const existing = await this.fetchActiveKeyByWorkspace(input.workspaceId);

    if (existing) {
      return {
        apiKey: null,
        record: existing,
        created: false
      };
    }

    const rawKey = generateRawKey();
    const prefix = rawKey.slice(0, 12);
    const keyHash = hashKey(rawKey);

    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        workspace_id: input.workspaceId,
        name,
        key_hash: keyHash,
        prefix,
        status: 'active',
        created_by: input.createdBy ?? null
      })
      .select('id,workspace_id,name,key_hash,prefix,status,created_at,last_used_at,created_by')
      .single();

    if (error) {
      this.serviceLogger.error({ err: error, workspaceId: input.workspaceId }, 'api key generation failed');
      throw error;
    }

    return {
      apiKey: rawKey,
      record: data as ApiKeyRecord,
      created: true
    };
  }

  public async validateKey(rawKey: string): Promise<ApiKeyRecord | null> {
    const supabase = this.requireSupabase();
    const keyHash = hashKey(rawKey.trim());
    const { data, error } = await supabase
      .from('api_keys')
      .select('id,workspace_id,name,key_hash,prefix,status,created_at,last_used_at,created_by')
      .eq('key_hash', keyHash)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return null;
    }

    if ((data as ApiKeyRecord).status !== 'active') {
      return null;
    }

    await supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);

    return data as ApiKeyRecord;
  }

  public async findWorkspace(rawKey: string): Promise<string | null> {
    const record = await this.validateKey(rawKey);
    return record?.workspace_id ?? null;
  }

  public async getMetadataByWorkspace(workspaceId: string): Promise<ApiKeyMetadata | null> {
    const record = await this.fetchActiveKeyByWorkspace(workspaceId);
    return record ? toMetadata(record) : null;
  }

  private async fetchActiveKeyByWorkspace(workspaceId: string): Promise<ApiKeyRecord | null> {
    const supabase = this.requireSupabase();
    const { data, error } = await supabase
      .from('api_keys')
      .select('id,workspace_id,name,key_hash,prefix,status,created_at,last_used_at,created_by')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return (data as ApiKeyRecord | null) ?? null;
  }

  private requireSupabase() {
    if (!this.supabaseClient) {
      throw new AppError('Supabase client is not configured', 500);
    }

    return this.supabaseClient;
  }
}

export const apiKeyService = ApiKeyService.getInstance();
