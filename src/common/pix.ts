/**
 * Pix "copia e cola" (BR Code, padrão EMV do Banco Central) a partir da chave do lojista.
 * QR estático com valor: o dinheiro cai direto na conta do lojista; não há aviso automático de pagamento,
 * então quem confirma é o caixa (ou use o Pix pelo Mercado Pago, que confirma sozinho).
 */
export type PixKeyType = 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';

const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC16-CCITT (polinômio 0x1021, início 0xFFFF), como o manual do BR Code pede. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (const ch of Buffer.from(payload, 'utf8')) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Tira acentos e o que o BR Code não aceita (nome e cidade são ASCII). */
export const pixText = (s: string, max: number) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-]/g, '').trim().slice(0, max).trim();

/** Chave no formato que o Pix espera: telefone com +55, CPF/CNPJ só números, e-mail minúsculo. */
export function normalizePixKey(type: PixKeyType, key: string): string | null {
  const k = key.trim();
  const d = k.replace(/\D/g, '');
  if (type === 'cpf') return d.length === 11 ? d : null;
  if (type === 'cnpj') return d.length === 14 ? d : null;
  if (type === 'phone') { const n = d.startsWith('55') && d.length >= 12 ? d : `55${d}`; return n.length === 12 || n.length === 13 ? `+${n}` : null; }
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k) && k.length <= 77 ? k.toLowerCase() : null;
  if (type === 'random') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k) ? k.toLowerCase() : null;
  return null;
}

export function pixPayload(p: { key: string; name: string; city: string; amountCents?: number; txid?: string; description?: string }): string {
  const name = pixText(p.name, 25) || 'LOJA';
  const city = pixText(p.city, 15) || 'BRASIL';
  const txid = (p.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const desc = p.description ? pixText(p.description, 40) : '';
  const account = field('00', 'br.gov.bcb.pix') + field('01', p.key) + (desc ? field('02', desc) : '');
  const body = [
    field('00', '01'),
    field('26', account),
    field('52', '0000'),
    field('53', '986'),
    p.amountCents ? field('54', (p.amountCents / 100).toFixed(2)) : '',
    field('58', 'BR'),
    field('59', name),
    field('60', city),
    field('62', field('05', txid)),
  ].join('') + '6304';
  return body + crc16(body);
}
