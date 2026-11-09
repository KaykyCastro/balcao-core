import { randomUUID } from 'crypto';

/**
 * Regras puras do armazenamento de arquivos (R2). Sem rede nem banco: fáceis de testar.
 * Cada arquivo de empresa mora em enterprises/<id>/<pasta>/; os da plataforma (banners do admin) em platform/.
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const ICON_TYPES = [...IMAGE_TYPES, 'image/x-icon'] as const;
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
export type FileType = (typeof ICON_TYPES)[number] | (typeof VIDEO_TYPES)[number];

const MB = 1024 * 1024;
/** O que cada tipo de envio aceita e em que pasta fica. */
export const KINDS = {
  product: { folder: 'products', types: IMAGE_TYPES, maxBytes: 5 * MB },
  store: { folder: 'store', types: IMAGE_TYPES, maxBytes: 8 * MB }, // logo, banner e banners deslizantes da loja
  logo: { folder: 'logo', types: IMAGE_TYPES, maxBytes: 2 * MB }, // logo da empresa (comprovante e sistema)
  favicon: { folder: 'favicon', types: ICON_TYPES, maxBytes: 512 * 1024 },
  video: { folder: 'videos', types: VIDEO_TYPES, maxBytes: 40 * MB },
  banner: { folder: 'banners', types: IMAGE_TYPES, maxBytes: 8 * MB }, // só admin: banners do marketplace
  review: { folder: 'reviews', types: IMAGE_TYPES, maxBytes: 5 * MB }, // fotos das avaliações dos compradores (pasta da loja)
} as const;
export type UploadKind = keyof typeof KINDS;
export const UPLOAD_KINDS = Object.keys(KINDS) as UploadKind[];

/** Cota por empresa: imagens e vídeos contam separado. */
export const IMAGE_QUOTA_BYTES = 500 * MB;
export const VIDEO_QUOTA_BYTES = 400 * MB;
export const isVideoKind = (k: UploadKind) => k === 'video';

/** Validade da URL de envio: curta, só o tempo de mandar o arquivo. */
export const PRESIGN_TTL_SECONDS = 5 * 60;

const EXT: Record<FileType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/x-icon': 'ico', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

/** Chave nova e imprevisível. `owner` = id da empresa, ou null para arquivos da plataforma. */
export function newKey(owner: string | null, kind: UploadKind, type: FileType) {
  const base = owner ? `enterprises/${owner}` : 'platform';
  return `${base}/${KINDS[kind].folder}/${randomUUID()}.${EXT[type]}`;
}

/** A chave é desta empresa? (impede usar arquivo de outra empresa colando a URL dela) */
export const ownsKey = (owner: string | null, key: string) => key.startsWith(owner ? `enterprises/${owner}/` : 'platform/');

/** URL pública → chave, se o arquivo for nosso. `base` = R2_PUBLIC_URL (ou a pasta local em desenvolvimento). */
export function keyFromUrl(base: string, url: string): string | null {
  const b = base.replace(/\/+$/, '') + '/';
  if (!url.startsWith(b)) return null;
  const key = decodeURIComponent(url.slice(b.length).split(/[?#]/)[0]);
  // <uuid>.<ext>, ou as imagens otimizadas: <uuid>-v480-960.webp (original) e <uuid>-w480.webp (versão menor).
  return /^(enterprises\/[a-f0-9]{24}|platform)\/[a-z]+\/[a-f0-9-]{36}(?:-v\d{2,4}(?:-\d{2,4}){0,3}|-w\d{2,4})?\.[a-z0-9]{2,4}$/.test(key) ? key : null;
}

/** Confere a assinatura real do arquivo (não confia no tipo que o navegador diz). */
export function sniffFile(buf: Buffer): FileType | null {
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return buf.toString('latin1', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  return null;
}

/** O tipo declarado e o tipo real batem com o que este envio aceita? */
export function acceptedType(kind: UploadKind, type: string): type is FileType {
  return (KINDS[kind].types as readonly string[]).includes(type);
}

/** data:image/...;base64,... → bytes (para subir imagens antigas e as de clientes antigos). */
export function parseDataUrl(v: string): { type: string; data: Buffer } | null {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(v);
  return m ? { type: m[1] === 'image/vnd.microsoft.icon' ? 'image/x-icon' : m[1], data: Buffer.from(m[2], 'base64') } : null;
}

/** Arquivos nossos que saíram de um documento (para apagar do R2 ao trocar/excluir). */
export function removedUrls(before: (string | null | undefined)[], after: (string | null | undefined)[]) {
  const keep = new Set(after.filter(Boolean));
  return [...new Set(before.filter((u): u is string => !!u && !keep.has(u)))];
}

/** Variáveis do R2: todas juntas (ou nenhuma, fora de produção); a URL pública precisa ser https. */
export function r2EnvErrors(env: NodeJS.ProcessEnv, prod: boolean): string[] {
  const names = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'] as const;
  const set = names.filter((n) => env[n]);
  const errors: string[] = [];
  if (set.length && set.length < names.length) errors.push(`Cloudflare R2: defina todas juntas (${names.join(', ')}). Faltando: ${names.filter((n) => !env[n]).join(', ')}`);
  if (prod && !set.length) errors.push(`Cloudflare R2 é obrigatório em produção (fotos e vídeos): defina ${names.join(', ')}`);
  if (env.R2_PUBLIC_URL && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(env.R2_PUBLIC_URL)) errors.push('R2_PUBLIC_URL deve ser o endereço público do bucket em HTTPS (ex.: https://arquivos.seudominio.com)');
  if (env.R2_ACCOUNT_ID && !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID)) errors.push('R2_ACCOUNT_ID deve ser o ID da conta Cloudflare (32 caracteres)');
  if (env.R2_BUCKET && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET)) errors.push('R2_BUCKET inválido (letras minúsculas, números e hífen)');
  return errors;
}
