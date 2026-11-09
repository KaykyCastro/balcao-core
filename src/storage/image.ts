import sharp from 'sharp';
import { canKeep, usefulWidths, type ImageSpec } from './image.rules';

/** Uma imagem no máximo por vez por núcleo: fotos de 12 MP pesam na memória. */
sharp.concurrency(1);
sharp.cache(false);

export interface Optimized { master: Buffer; kept: boolean; width: number; height: number; variants: { width: number; data: Buffer }[] }

/**
 * Deixa a imagem leve e bonita: gira conforme a câmera (EXIF), tira todos os metadados (inclusive GPS), limita o maior
 * lado, converte para WebP (com transparência, se tiver) e gera as versões menores. Imagem já otimizada passa direto.
 * GIF/animação: só o primeiro quadro (a loja não usa animação em imagem).
 */
export async function optimizeImage(input: Buffer, spec: ImageSpec): Promise<Optimized> {
  const img = sharp(input, { failOn: 'truncated', limitInputPixels: 40_000_000 });
  const meta = await img.metadata();
  const webp = { quality: spec.quality, effort: 4, smartSubsample: true } as const;
  const kept = canKeep(meta, input.length, spec);
  let master = input; let width = meta.width ?? 0; let height = meta.height ?? 0;
  if (!kept) {
    const out = await sharp(input, { failOn: 'truncated', limitInputPixels: 40_000_000 }).rotate()
      .resize({ width: spec.maxSide, height: spec.maxSide, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
      .webp(webp).toBuffer({ resolveWithObject: true });
    master = out.data; width = out.info.width; height = out.info.height;
  }
  const variants: Optimized['variants'] = [];
  for (const w of usefulWidths(spec, width)) {
    const data = await sharp(master).resize({ width: w, kernel: 'lanczos3' }).webp(webp).toBuffer();
    variants.push({ width: w, data });
  }
  return { master, kept, width, height, variants };
}
