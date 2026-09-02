import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { SignOptions } from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID, createHash } from 'crypto';
import { SupabaseService } from '../common/supabase/supabase.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './strategies/jwt.strategy';

const BCRYPT_COST = 12;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  private db() {
    return this.supabase.getClient();
  }

  private hashRefreshToken(token: string): string {
    // Guardamos apenas o hash do refresh token no banco — se o banco vazar,
    // o token em si não pode ser reconstruído.
    return createHash('sha256').update(token).digest('hex');
  }

  private async signTokens(user: {
    id: string;
    email: string;
    role: 'user' | 'admin';
  }): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: 'access',
    };

    const accessToken = await this.jwt.signAsync(payload, {
      privateKey: this.config.get<string>('jwt.privateKey'),
      algorithm: 'RS256',
      // jsonwebtoken 9 tipa expiresIn como `number | StringValue` (ex.: '15m');
      // como o valor vem do .env como string genérica, o cast é necessário.
      expiresIn: this.config.get<string>('jwt.accessExpiresIn') as SignOptions['expiresIn'],
    });

    // Refresh token opaco (não é um JWT) — só existe como registro no banco.
    const refreshToken = randomBytes(48).toString('hex');
    const refreshTokenHash = this.hashRefreshToken(refreshToken);
    const expiresInDays = this.parseDaysFromDuration(
      this.config.get<string>('jwt.refreshExpiresIn') ?? '7d',
    );

    const { error } = await this.db().from('refresh_tokens').insert({
      id: randomUUID(),
      user_id: user.id,
      token_hash: refreshTokenHash,
      expires_at: new Date(
        Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
      ).toISOString(),
      revoked: false,
    });

    if (error) {
      throw new Error(`Falha ao persistir refresh token: ${error.message}`);
    }

    return { accessToken, refreshToken };
  }

  private parseDaysFromDuration(duration: string): number {
    const match = /^(\d+)d$/.exec(duration);
    return match ? parseInt(match[1], 10) : 7;
  }

  async register(dto: RegisterDto) {
    const { data: existing } = await this.db()
      .from('users')
      .select('id')
      .eq('email', dto.email)
      .maybeSingle();

    if (existing) {
      throw new ConflictException('Já existe uma conta com este e-mail.');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    const { data: user, error } = await this.db()
      .from('users')
      .insert({
        id: randomUUID(),
        email: dto.email,
        password_hash: passwordHash,
        role: 'user',
        terms_accepted: false,
      })
      .select('id, email, role')
      .single();

    if (error || !user) {
      throw new Error(`Falha ao criar usuário: ${error?.message}`);
    }

    await this.logAudit(user.id, 'register');

    const tokens = await this.signTokens(user);
    return { user, ...tokens };
  }

  async login(dto: LoginDto) {
    const { data: user, error } = await this.db()
      .from('users')
      .select('id, email, password_hash, role')
      .eq('email', dto.email)
      .maybeSingle();

    if (error || !user) {
      throw new UnauthorizedException('E-mail ou senha inválidos.');
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.password_hash);

    if (!passwordMatches) {
      await this.logAudit(user.id, 'login_failed');
      throw new UnauthorizedException('E-mail ou senha inválidos.');
    }

    await this.logAudit(user.id, 'login');

    const tokens = await this.signTokens(user);
    return {
      user: { id: user.id, email: user.email, role: user.role },
      ...tokens,
    };
  }

  /**
   * Refresh token rotation: o token recebido é invalidado e um novo par
   * (access + refresh) é emitido. Se o token já tiver sido usado/revogado,
   * tratamos como possível reuso de token vazado e revogamos toda a família.
   */
  async refresh(refreshToken: string) {
    const tokenHash = this.hashRefreshToken(refreshToken);

    const { data: stored, error } = await this.db()
      .from('refresh_tokens')
      .select('id, user_id, expires_at, revoked')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (error || !stored) {
      throw new UnauthorizedException('Refresh token inválido.');
    }

    if (stored.revoked || new Date(stored.expires_at) < new Date()) {
      // Reuso de token revogado/expirado — por segurança, revoga tudo do usuário.
      await this.db()
        .from('refresh_tokens')
        .update({ revoked: true })
        .eq('user_id', stored.user_id);
      throw new UnauthorizedException('Refresh token expirado ou já utilizado. Faça login novamente.');
    }

    await this.db()
      .from('refresh_tokens')
      .update({ revoked: true })
      .eq('id', stored.id);

    const { data: user } = await this.db()
      .from('users')
      .select('id, email, role')
      .eq('id', stored.user_id)
      .single();

    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado.');
    }

    return this.signTokens(user);
  }

  async logout(refreshToken: string) {
    const tokenHash = this.hashRefreshToken(refreshToken);
    await this.db()
      .from('refresh_tokens')
      .update({ revoked: true })
      .eq('token_hash', tokenHash);
  }

  async acceptTerms(userId: string, version: string) {
    const currentVersion = this.config.get<string>('terms.currentVersion');

    if (version !== currentVersion) {
      throw new UnauthorizedException(
        `Versão do termo desatualizada. Versão vigente: ${currentVersion}.`,
      );
    }

    const { error } = await this.db()
      .from('users')
      .update({
        terms_accepted: true,
        terms_version: version,
        terms_accepted_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      throw new Error(`Falha ao registrar aceite do termo: ${error.message}`);
    }

    await this.logAudit(userId, 'accept_terms');
    return { termsAccepted: true, version };
  }

  private async logAudit(userId: string, acao: string, ip?: string) {
    await this.db()
      .from('audit_logs')
      .insert({ id: randomUUID(), user_id: userId, acao, ip_address: ip ?? null });
  }
}
