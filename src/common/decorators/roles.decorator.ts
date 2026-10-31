import { SetMetadata } from '@nestjs/common';

export type Role = 'user' | 'admin';
export const ROLES_KEY = 'roles';
/** Restringe a rota a estes papéis. Sem o decorator, qualquer empresa autenticada acessa. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
