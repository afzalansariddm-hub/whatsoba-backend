import pino from 'pino';

import { env } from './env';

export const logger = pino({
  level: env.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    remove: true
  }
});

export type Logger = typeof logger;
