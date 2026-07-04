import type { Request, Response } from 'express';

import { sendSuccess } from '../utils/api-response';
import { dashboardService } from '../services/api';
import { parseApiContext } from '../services/api/query';

export async function getDashboardSummary(request: Request, response: Response): Promise<void> {
  const { workspaceId } = parseApiContext(request);
  const data = await dashboardService.getSummary(workspaceId);
  sendSuccess(response, 200, data);
}
