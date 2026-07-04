import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env';
import { MEDIA_DIRECTORY, MEDIA_ROUTE_PREFIX } from './config/media';
import { errorHandler } from './middleware/error-handler';
import { notFound } from './middleware/not-found';
import { requestLogger } from './middleware/request-logger';
import { apiRouter } from './routes';
import { v1Router } from './routes/v1.routes';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    cors({
      origin: env.frontendOrigins,
      credentials: true
    })
  );
  app.use(helmet());
  app.use(compression());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);
  app.use(MEDIA_ROUTE_PREFIX, express.static(MEDIA_DIRECTORY));

  app.use('/v1', v1Router);
  app.use('/api', apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
