import { access, mkdir } from 'node:fs/promises';
import fs from 'node:fs';

import { env } from '../config/env';
import { logger } from '../config/logger';

async function ensureDirectoryWritable(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await access(directory, fs.constants.W_OK);
}

export async function runStartupChecks(): Promise<void> {
  if (env.frontendOrigins.length === 0) {
    throw new Error('At least one FRONTEND_URL must be configured');
  }

  await ensureDirectoryWritable(env.sessionPath);

  logger.info(
    {
      sessionPath: env.sessionPath,
      frontendOrigins: env.frontendOrigins,
      port: env.port,
      nodeEnv: env.nodeEnv
    },
    'startup checks passed'
  );
}
