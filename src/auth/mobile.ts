/** Telas do Balcão que o app pode abrir já logado. Qualquer outro caminho é recusado (sem redirecionamento aberto). */
export const HANDOFF_PATHS = ['/app/vendas'] as const;
export type HandoffPath = (typeof HANDOFF_PATHS)[number];
export const HANDOFF_TTL_MS = 60_000;
export const isHandoffPath = (p: unknown): p is HandoffPath => typeof p === 'string' && (HANDOFF_PATHS as readonly string[]).includes(p);
/** Código: 32 bytes aleatórios em hex. */
export const HANDOFF_CODE_RE = /^[a-f0-9]{64}$/;
