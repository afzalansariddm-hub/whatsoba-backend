import { AppError } from '../../utils/app-error';
import { getSupabaseClient } from '../../config/supabase';

export class BaseApiRepository {
  protected readonly supabaseClient = getSupabaseClient();

  protected requireSupabaseClient() {
    if (!this.supabaseClient) {
      throw new AppError('Supabase client is not configured', 500);
    }

    return this.supabaseClient;
  }
}
