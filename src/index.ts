import { createServer } from 'node:http';

import { APP_NAME, APP_VERSION } from './config/app';
import { env } from './config/env';
import { logger } from './config/logger';
import { createApp } from './app';
import { initializeSocket } from './socket';
import { initializeWebhooks } from './webhooks';
import { runStartupChecks } from './utils/startup-checks';

const app = createApp();
const httpServer = createServer(app);
const io = initializeSocket(httpServer);

let shuttingDown = false;

function closeHttpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated');

  try {
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
    await closeHttpServer();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

async function start(): Promise<void> {
  await runStartupChecks();
  initializeWebhooks();

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'uncaught exception');
    void shutdown('SIGTERM');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
    void shutdown('SIGTERM');
  });

  httpServer.listen(env.port, () => {
    logger.info(
      {
        app: APP_NAME,
        version: APP_VERSION,
        port: env.port,
        nodeEnv: env.nodeEnv,
        frontendOrigins: env.frontendOrigins,
        sessionPath: env.sessionPath
      },
      'server started'
    );
  });
}

void start().catch((error) => {
  logger.error({ err: error }, 'startup failed');
  process.exit(1);
});
