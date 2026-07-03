import type { Request, Response } from 'express';

import { APP_VERSION } from '../config/app';

export function getHealth(_request: Request, response: Response): void {
  response.json({
    status: 'online',
    version: APP_VERSION
  });
}
