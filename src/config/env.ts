import dotenv from 'dotenv';

dotenv.config();

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return 3001;
  }

  return parsed;
}

function parseNodeEnv(value: string | undefined): 'development' | 'test' | 'production' {
  const normalized = value ?? 'development';

  if (normalized === 'development' || normalized === 'test' || normalized === 'production') {
    return normalized;
  }

  throw new Error(`Invalid NODE_ENV value: ${normalized}`);
}

function parseCorsOrigins(value: string | undefined): string[] {
  if (!value) {
    return ['http://localhost:5173'];
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parseSessionPath(nodeEnv: string | undefined, value: string | undefined): string {
  if (value && value.trim().length > 0) {
    return value.trim();
  }

  return nodeEnv === 'production' ? '/data/sessions' : './sessions';
}

function parseOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const nodeEnv = parseNodeEnv(process.env.NODE_ENV);
const logLevel = process.env.LOG_LEVEL ?? 'info';
const port = parsePort(process.env.PORT);
const frontendOrigins = parseCorsOrigins(process.env.FRONTEND_URL);
const sessionPath = parseSessionPath(nodeEnv, process.env.SESSION_PATH);
const supabaseUrl = parseOptional(process.env.SUPABASE_URL);
const supabaseServiceRoleKey = parseOptional(process.env.SUPABASE_SERVICE_ROLE_KEY);

export const env = {
  port,
  nodeEnv,
  frontendOrigins,
  sessionPath,
  logLevel,
  isProduction: nodeEnv === 'production',
  supabaseUrl,
  supabaseServiceRoleKey,
  isSupabaseConfigured: Boolean(supabaseUrl && supabaseServiceRoleKey)
} as const;
