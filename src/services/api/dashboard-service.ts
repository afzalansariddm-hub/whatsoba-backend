import { DashboardRepository } from '../../repositories/api/dashboard-repository';
import type { DashboardSummary } from './types';

export class DashboardService {
  private readonly repository = new DashboardRepository();

  public async getSummary(workspaceId: string): Promise<DashboardSummary> {
    return this.repository.getSummary(workspaceId);
  }
}

export const dashboardService = new DashboardService();
