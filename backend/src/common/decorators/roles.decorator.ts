import { SetMetadata } from '@nestjs/common';

export type Role = 'user' | 'admin';

export const ROLES_KEY = 'roles';

/** Restringe a rota a um ou mais papéis (usado junto com o RolesGuard). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
