import sharp from 'sharp';
import { canKeep, IMAGE_SPECS, masterKey, usefulWidths, variantKey, variantsOf } from './image.rules';
import { optimizeImage } from './image';
import { keyFromUrl } from './storage.rules';

const spec = IMAGE_SPECS.product!;
/** Foto "de celular": 4000×3000 com ruído (como uma foto real), EXIF com GPS e orientação 6 (girada 90°). */
async function phonePhoto() {
  const raw = Buffer.alloc(4000 * 3000 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919 + (i >> 7) * 31) & 255;
  return sharp(raw, { raw: { width: 4000, height: 3000, channels: 3 } })
    .withExif({ IFD0: { Make: 'Celular' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '3/1 43/1 0/1' } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95 }).toBuffer();
}

describe('tratamento de imagens (regras)', () => {
  it('nome do original diz quais versões existem; sem versões vira só .webp', () => {
    expect(masterKey('enterprises/a/products/u.jpg', [480, 960])).toBe('enterprises/a/products/u-v480-960.webp');
    expect(masterKey('enterprises/a/logo/u.png', [])).toBe('enterprises/a/logo/u.webp');
    expect(variantKey('enterprises/a/products/u-v480-960.webp', 480)).toBe('enterprises/a/products/u-w480.webp');
    expect(variantsOf('x/u-v480-960.webp')).toEqual([480, 960]);
    expect(variantsOf('x/u.webp')).toEqual([]);
  });
  it('os nomes novos continuam reconhecidos como arquivos nossos (senão o salvamento não marca o envio e a limpeza apaga a foto)', () => {
    const base = 'https://arquivos.x.com';
    const k = 'enterprises/6aece553185e9318a93d2ec5/products/13603ef4-4ec6-441d-8b58-2278d79c3de7';
    expect(keyFromUrl(base, `${base}/${k}-v480-960.webp`)).toBe(`${k}-v480-960.webp`);
    expect(keyFromUrl(base, `${base}/${k}-w480.webp`)).toBe(`${k}-w480.webp`);
    expect(keyFromUrl(base, `${base}/${k}.webp`)).toBe(`${k}.webp`);
    expect(keyFromUrl(base, `${base}/${k}-v480-960.webp/../x`)).toBeNull();
    expect(keyFromUrl(base, `${base}/${k}-evil.webp`)).toBeNull();
  });

  it('não aumenta foto pequena', () => {
    expect(usefulWidths(spec, 700)).toEqual([480]);
    expect(usefulWidths(spec, 400)).toEqual([]);
  });
  it('só guarda como chegou se for WebP limpo (sem EXIF/XMP/rotação), no tamanho e no peso', () => {
    const ok = { format: 'webp', width: 1200, height: 900 };
    expect(canKeep(ok, 200_000, spec)).toBe(true);
    expect(canKeep({ ...ok, exif: Buffer.from('x') }, 200_000, spec)).toBe(false);
    expect(canKeep({ ...ok, xmp: Buffer.from('x') }, 200_000, spec)).toBe(false);
    expect(canKeep({ ...ok, orientation: 6 }, 200_000, spec)).toBe(false);
    expect(canKeep({ ...ok, format: 'jpeg' }, 200_000, spec)).toBe(false);
    expect(canKeep({ ...ok, width: 3000 }, 200_000, spec)).toBe(false);
    expect(canKeep(ok, 900_000, spec)).toBe(false);
  });
});

describe('tratamento de imagens (sharp)', () => {
  it('foto de celular: gira, tira EXIF/GPS, limita a 1600 px, vira WebP bem menor e gera as versões', async () => {
    const input = await phonePhoto();
    const im = await sharp(input).metadata();
    expect(im.orientation).toBe(6);
    expect(im.exif?.toString('latin1')).toContain('Celular'); // a foto de entrada tem EXIF de verdade
    const o = await optimizeImage(input, spec);
    const m = await sharp(o.master).metadata();
    expect(m.format).toBe('webp');
    expect(m.exif).toBeUndefined();
    expect([m.width, m.height]).toEqual([1200, 1600]); // em pé: a orientação 6 foi aplicada
    expect(o.master.length).toBeLessThan(input.length / 3);
    expect(o.variants.map((v) => v.width)).toEqual([480, 960]);
    for (const v of o.variants) expect((await sharp(v.data).metadata()).width).toBe(v.width);
  }, 30_000);

  it('PNG com transparência continua transparente', async () => {
    const png = await sharp({ create: { width: 600, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const o = await optimizeImage(png, IMAGE_SPECS.logo!);
    expect((await sharp(o.master).metadata()).hasAlpha).toBe(true);
  });

  it('WebP já otimizado passa direto (sem comprimir de novo), mas ganha as versões', async () => {
    const webp = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#c0ffee' } }).webp({ quality: 80 }).toBuffer();
    const o = await optimizeImage(webp, spec);
    expect(o.kept).toBe(true);
    expect(o.master).toBe(webp);
    expect(o.variants.map((v) => v.width)).toEqual([480, 960]);
  });

  it('arquivo corrompido é recusado', async () => {
    const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#888' } }).jpeg().toBuffer();
    await expect(optimizeImage(jpg.subarray(0, 300), spec)).rejects.toThrow();
  });
});
