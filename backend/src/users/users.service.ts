import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase/supabase.service';

@Injectable()
export class UsersService {
  constructor(private readonly supabase: SupabaseService) {}

  async getProfile(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('users')
      .select('id, email, role, terms_accepted, terms_version, created_at')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('Usuário não encontrado.');
    }
    return data;
  }
}
