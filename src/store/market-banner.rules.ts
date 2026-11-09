/** Regras puras dos banners do marketplace. */

/** Link do banner: caminho interno do site (sem "//", que viraria outro domínio) ou https. Vazio = sem link. */
export const BANNER_LINK_RE = /^(|\/(?!\/)[^\s"'<>]{0,300}|https:\/\/[^\s"'<>]{1,400})$/;
export const MAX_PER_PLACEMENT = 8;

export interface BannerWindow { active: boolean; startsAt: Date | null; endsAt: Date | null }
/** Está no ar agora? Ativo e dentro do período (sem data = sem limite). */
export function isLive(b: BannerWindow, now = new Date()) {
  return b.active && (!b.startsAt || b.startsAt <= now) && (!b.endsAt || b.endsAt > now);
}
