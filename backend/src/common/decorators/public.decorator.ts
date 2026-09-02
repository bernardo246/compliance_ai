import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca uma rota como pública, liberando-a do JwtAuthGuard global. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
