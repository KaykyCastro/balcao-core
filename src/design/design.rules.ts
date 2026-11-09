/**
 * Acesso do admin ao design da loja online de um lojista ("o Balcão monta o meu site").
 *
 * - O admin pede; o lojista permite uma única vez (ou recusa). Sem permissão, nada.
 * - A permissão vale uma sessão de edição: quando o admin finaliza, ela acaba. Para mexer de novo, outro pedido.
 * - O lojista pode revogar a qualquer hora; a permissão também vence sozinha (GRANT_DAYS).
 * - Na sessão, só as rotas de design passam (DESIGN_ROUTES) e, em PUT /store-config, só os campos de aparência.
 *   Publicar fica com o lojista: o admin monta o rascunho.
 */
export type DesignStatus = 'requested' | 'granted' | 'in_progress' | 'finished' | 'denied' | 'revoked' | 'cancelled' | 'expired';

export const GRANT_DAYS = 7;
export const SESSION_HOURS = 8;
export const OPEN: DesignStatus[] = ['requested', 'granted', 'in_progress'];
export const LIVE: DesignStatus[] = ['granted', 'in_progress'];

export interface GrantLike { status: DesignStatus; expiresAt?: Date | null }

/** A sessão do admin vale agora? (permitida ou em andamento, e dentro do prazo) */
export function isLive(g: GrantLike, now = new Date()): boolean {
  return LIVE.includes(g.status) && !!g.expiresAt && g.expiresAt > now;
}

/** Campos de PUT /store-config que são aparência e textos da vitrine. */
export const DESIGN_STORE_FIELDS = ['tagline', 'about', 'logo', 'banner', 'notice', 'slides', 'theme', 'reels', 'reelsTitle', 'highlights', 'seo'] as const;

const R = (method: string, re: RegExp) => ({ method, re });
/** Rotas que a sessão de design alcança (tudo o mais: 403 DESIGN_SCOPE). */
const DESIGN_ROUTES = [
  R('GET', /^\/store-config$/), R('PUT', /^\/store-config$/), R('PUT', /^\/store-config\/page$/), R('POST', /^\/store-config\/code\/compile$/), R('GET', /^\/store-config\/preview$/),
  R('GET', /^\/store-config\/media$/), R('POST', /^\/store-config\/media$/), R('DELETE', /^\/store-config\/media\/[a-f0-9]{24}$/),
  R('GET', /^\/product(\/.*)?$/), R('GET', /^\/category(\/.*)?$/),
  R('POST', /^\/uploads\/presign$/), R('POST', /^\/uploads\/[a-f0-9]{24}\/complete$/),
];
const UPLOAD_KINDS = ['store', 'video'];

/** null = pode; senão o motivo da recusa (vai na mensagem do 403). */
export function designDenied(method: string, path: string, body: unknown): string | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const p = path.split('?')[0].replace(/\/+$/, '') || '/';
  if (!DESIGN_ROUTES.some((r) => r.method === m && r.re.test(p))) return 'Na sessão de design só dá para mexer no site da loja.';
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (m === 'PUT' && p === '/store-config') {
    const bad = Object.keys(b).filter((k) => !(DESIGN_STORE_FIELDS as readonly string[]).includes(k));
    if (bad.length) return `Na sessão de design só a aparência da loja muda (não: ${bad.join(', ')}).`;
  }
  if (p === '/store-config/page' && b.publish === true) return 'Quem publica é o lojista: salve o rascunho e finalize a edição.';
  if (p === '/uploads/presign' && !UPLOAD_KINDS.includes(String(b.kind))) return 'Na sessão de design só dá para enviar imagens e vídeos da loja.';
  return null;
}
