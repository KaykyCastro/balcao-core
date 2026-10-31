import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHEN_BLOCKED_KEY = 'allowWhenBlocked';
/** Rota que continua acessível mesmo com a conta bloqueada por falta de pagamento. */
export const AllowWhenBlocked = () => SetMetadata(ALLOW_WHEN_BLOCKED_KEY, true);
