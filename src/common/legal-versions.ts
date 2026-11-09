/**
 * Versões vigentes dos documentos legais (mesmas datas do front, em caixa/src/config/terms.ts).
 * Ao publicar uma nova versão, atualize os dois lados: o painel pede o novo aceite aos lojistas
 * e o admin passa a contar quem ainda está na versão antiga.
 */
export const LEGAL_VERSIONS = {
  terms: '2026-11-08',
  privacy: '2026-11-08',
  purchase: '2026-11-02',
} as const;

/** "ana.souza@ex.com" → "an***@ex.com" (para trilhas de auditoria sem expor o e-mail inteiro). */
export function maskEmail(email: string) {
  const [u = '', d = ''] = String(email).split('@');
  return `${u.slice(0, 2)}***@${d}`;
}
