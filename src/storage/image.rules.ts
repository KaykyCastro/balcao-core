import type { UploadKind } from './storage.rules';

/**
 * Tratamento das imagens que vão para o R2: leves e ainda bonitas. Puro (sem sharp), testado em image.spec.ts.
 *
 * - `maxSide`: maior lado da imagem guardada. Produto 1600 px (zoom na página do produto), banners e loja 2400 px
 *   (tela cheia em monitores grandes), logo 800 px, avaliação 1600 px.
 * - `quality`: WebP 80 dá a mesma aparência de um JPEG ~90 com bem menos peso; logo 86 (traços finos e texto).
 * - `widths`: versões menores para telas pequenas e cartões (srcset), guardadas ao lado do original (ver masterKey).
 */
export interface ImageSpec { maxSide: number; quality: number; widths: number[]; budget: number }

export const IMAGE_SPECS: Partial<Record<UploadKind, ImageSpec>> = {
  product: { maxSide: 1600, quality: 80, widths: [480, 960], budget: 450_000 },
  store: { maxSide: 2400, quality: 80, widths: [640, 1280], budget: 700_000 },
  banner: { maxSide: 2400, quality: 80, widths: [640, 1280], budget: 700_000 },
  review: { maxSide: 1600, quality: 78, widths: [480], budget: 400_000 },
  logo: { maxSide: 800, quality: 86, widths: [], budget: 250_000 },
};
export const specOf = (kind: UploadKind) => IMAGE_SPECS[kind] ?? null;

/**
 * O original pode ficar como chegou, sem comprimir de novo (cada compressão perde um pouco)? Só se já for WebP, sem
 * metadados (EXIF pode ter GPS), sem rotação pendente e dentro do tamanho e do peso. As versões menores saem dele.
 */
export function canKeep(meta: { format?: string; width?: number; height?: number; exif?: unknown; xmp?: unknown; orientation?: number }, bytes: number, spec: ImageSpec): boolean {
  return meta.format === 'webp' && !meta.exif && !meta.xmp && (!meta.orientation || meta.orientation === 1)
    && Math.max(meta.width ?? Infinity, meta.height ?? Infinity) <= spec.maxSide && bytes <= spec.budget;
}

/** Larguras que valem a pena para esta imagem: só as menores que ela (não aumenta foto pequena). */
export const usefulWidths = (spec: ImageSpec, width: number) => spec.widths.filter((w) => w < width * 0.9);

/**
 * Nomes: o original otimizado diz no nome quais versões menores existem, para a vitrine montar o srcset sem pedir
 * arquivo que não existe: `.../<uuid>.jpg` → `.../<uuid>-v480-960.webp` (versões `.../<uuid>-w480.webp` e `-w960.webp`).
 * Sem versões (logo, foto pequena): `.../<uuid>.webp`.
 */
export function masterKey(key: string, widths: number[]) {
  return key.replace(/\.[a-z0-9]+$/i, widths.length ? `-v${widths.join('-')}.webp` : '.webp');
}
export function variantKey(master: string, w: number) { return master.replace(/(-v[\d-]+)?\.webp$/, `-w${w}.webp`); }
/** Versões de um original (pelo nome). */
export function variantsOf(master: string): number[] {
  const m = /-v(\d+(?:-\d+)*)\.webp$/.exec(master);
  return m ? m[1].split('-').map(Number) : [];
}
