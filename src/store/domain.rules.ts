import { createHmac } from 'crypto';

/**
 * Domínio próprio da loja (ex.: minhaloja.com.br). Puro: normaliza o que o lojista digita, recusa o que não pode
 * (domínio da plataforma, IP, endereço interno) e gera o código de confirmação do registro TXT.
 *
 * Para ligar, o lojista configura no DNS do domínio:
 * - A (ou CNAME) do domínio apontando para o servidor do Balcão: é por onde a loja abre;
 * - TXT em `_balcao.<domínio>` com o código: prova que o domínio é dele (ninguém "reserva" o domínio de outra pessoa).
 * O "www." é aceito junto: www.minhaloja.com.br abre a mesma loja.
 */
export const DOMAIN_TXT_PREFIX = '_balcao';
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export class DomainError extends Error {}

/** "https://WWW.MinhaLoja.com.br/qualquer" → "minhaloja.com.br". Erro com mensagem pronta para a tela. */
export function normalizeDomain(raw: string, blocked: string[] = []): string {
  let h = String(raw ?? '').trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (h.startsWith('www.')) h = h.slice(4);
  if (!h) throw new DomainError('Digite o domínio, por exemplo minhaloja.com.br');
  if (h.length > 200) throw new DomainError('Domínio longo demais');
  if (/^[\d.]+$/.test(h) || h.includes(':')) throw new DomainError('Use um domínio (ex.: minhaloja.com.br), não um endereço IP');
  if (!/^[a-z0-9.-]+$/.test(h)) throw new DomainError('O domínio só pode ter letras sem acento, números, hífen e pontos. Domínio com acento: use a versão que começa com "xn--".');
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) throw new DomainError('Domínio inválido. Exemplo: minhaloja.com.br');
  if (!/^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(labels[labels.length - 1])) throw new DomainError('Domínio inválido. Exemplo: minhaloja.com.br');
  if (['localhost', 'local', 'internal', 'test', 'example', 'invalid'].includes(labels[labels.length - 1])) throw new DomainError('Esse domínio não funciona na internet');
  for (const b of blocked.map((x) => x.toLowerCase()).filter(Boolean)) {
    if (h === b || h.endsWith(`.${b}`)) throw new DomainError('Esse domínio é da plataforma. Use um domínio seu, por exemplo minhaloja.com.br');
  }
  return h;
}

/** Os dois endereços que abrem a loja: o domínio e o www. */
export const domainHosts = (host: string) => [host, `www.${host}`];

/** De um endereço recebido (com ou sem www, maiúsculas, porta) → o domínio guardado. */
export const hostKey = (raw: string) => String(raw ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');

/** Código do TXT: estável por loja e domínio (assinado com o segredo da API), sem precisar guardar. */
export function domainToken(secret: string, storeId: string, host: string): string {
  return `balcao-verificacao=${createHmac('sha256', `${secret}:dominio`).update(`${storeId}:${host}`).digest('hex').slice(0, 32)}`;
}

/** O DNS do domínio aponta para o Balcão? Por IP (registro A/AAAA) ou por nome (CNAME para o endereço do Balcão). */
export function pointsToUs(found: { a: string[]; cname: string[] }, target: { ips: string[]; host: string }): boolean {
  const ips = new Set(target.ips.map((x) => x.trim()).filter(Boolean));
  const host = target.host.trim().toLowerCase().replace(/\.$/, '');
  return found.a.some((ip) => ips.has(ip)) || (!!host && found.cname.some((c) => c.toLowerCase().replace(/\.$/, '') === host));
}

/** Endereço público da loja: o domínio próprio, se ativo; senão o endereço na plataforma. */
export function storeUrl(front: string, s: { slug: string; domain?: { host: string | null; status: string } | null }): string {
  return s.domain?.status === 'active' && s.domain.host ? `https://${s.domain.host}` : `${front.replace(/\/$/, '')}/loja/${s.slug}`;
}
