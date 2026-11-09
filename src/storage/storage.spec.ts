import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { staffAccess } from '../staff/staff.rules';
import { LocalDriver } from './storage.driver';
import { acceptedType, keyFromUrl, newKey, ownsKey, parseDataUrl, r2EnvErrors, removedUrls, sniffFile } from './storage.rules';

const EID = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const BASE = 'https://arquivos.balcao.app';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const jpg = Buffer.from('ffd8ffe000104a46494600010100', 'hex');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(4)]);

describe('armazenamento (R2)', () => {
  it('reconhece o arquivo pela assinatura real, não pelo nome', () => {
    expect(sniffFile(png)).toBe('image/png');
    expect(sniffFile(jpg)).toBe('image/jpeg');
    expect(sniffFile(webp)).toBe('image/webp');
    expect(sniffFile(mp4)).toBe('video/mp4');
    expect(sniffFile(Buffer.from('<svg onload=alert(1)></svg>....'))).toBeNull();
    expect(sniffFile(Buffer.from('<html><script>x</script></html>'))).toBeNull();
  });

  it('cada tipo de envio aceita só os formatos dele', () => {
    expect(acceptedType('product', 'image/webp')).toBe(true);
    expect(acceptedType('product', 'video/mp4')).toBe(false);
    expect(acceptedType('product', 'image/svg+xml')).toBe(false);
    expect(acceptedType('favicon', 'image/x-icon')).toBe(true);
    expect(acceptedType('video', 'video/quicktime')).toBe(true);
  });

  it('guarda cada arquivo na pasta da empresa, com nome imprevisível', () => {
    const k = newKey(EID, 'product', 'image/webp');
    expect(k).toMatch(new RegExp(`^enterprises/${EID}/products/[a-f0-9-]{36}\\.webp$`));
    expect(newKey(EID, 'product', 'image/webp')).not.toBe(k);
    expect(newKey(null, 'banner', 'image/png')).toMatch(/^platform\/banners\//);
  });

  it('só aceita URL nossa e da própria empresa', () => {
    const k = newKey(EID, 'store', 'image/png');
    expect(keyFromUrl(BASE, `${BASE}/${k}`)).toBe(k);
    expect(keyFromUrl(BASE + '/', `${BASE}/${k}?v=2`)).toBe(k);
    expect(keyFromUrl(BASE, `https://outro.site/${k}`)).toBeNull();
    expect(keyFromUrl(BASE, `${BASE}/../segredo.txt`)).toBeNull();
    expect(ownsKey(EID, k)).toBe(true);
    expect(ownsKey(OTHER, k)).toBe(false);
    expect(ownsKey(null, k)).toBe(false);
  });

  it('lê data URL antiga (inclusive o tipo de ícone do Windows)', () => {
    expect(parseDataUrl(`data:image/png;base64,${png.toString('base64')}`)?.data.equals(png)).toBe(true);
    expect(parseDataUrl('data:image/vnd.microsoft.icon;base64,AAABAA==')?.type).toBe('image/x-icon');
    expect(parseDataUrl('https://x.com/a.png')).toBeNull();
  });

  it('sabe quais arquivos saíram (para apagar do R2)', () => {
    expect(removedUrls(['a', 'b', 'c', '', null], ['b', 'd'])).toEqual(['a', 'c']);
    expect(removedUrls(['a', 'a'], [])).toEqual(['a']);
  });

  it('exige as 5 variáveis do R2 juntas, e em produção', () => {
    const ok = { R2_ACCOUNT_ID: 'f'.repeat(32), R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'balcao-arquivos', R2_PUBLIC_URL: BASE };
    expect(r2EnvErrors(ok, true)).toEqual([]);
    expect(r2EnvErrors({}, false)).toEqual([]); // desenvolvimento sem R2: pasta local
    expect(r2EnvErrors({}, true).join()).toMatch(/obrigatório em produção/);
    expect(r2EnvErrors({ ...ok, R2_BUCKET: undefined }, false).join()).toMatch(/Faltando: R2_BUCKET/);
    expect(r2EnvErrors({ ...ok, R2_PUBLIC_URL: 'http://arquivos.com' }, false).join()).toMatch(/HTTPS/);
  });

  it('envio local (desenvolvimento): o token vale só para aquele arquivo, tipo, tamanho e prazo', async () => {
    const d = new LocalDriver(mkdtempSync(join(tmpdir(), 'balcao-')), 'http://localhost:2700', 'segredo');
    const key = newKey(EID, 'product', 'image/png');
    const { url } = await d.presignPut(key, 'image/png', png.length, 60);
    const token = url.split('/storage/local/')[1];
    expect(d.verifyPut(token, 'image/png', png.length)?.key).toBe(key);
    expect(d.verifyPut(token, 'image/png', png.length + 1)).toBeNull(); // arquivo maior que o anunciado
    expect(d.verifyPut(token, 'text/html', png.length)).toBeNull();
    expect(d.verifyPut(token.slice(0, -2) + 'xx', 'image/png', png.length)).toBeNull(); // assinatura adulterada
    const old = (await d.presignPut(key, 'image/png', png.length, -1)).url.split('/storage/local/')[1];
    expect(d.verifyPut(old, 'image/png', png.length)).toBeNull(); // expirado
    await d.put(key, png);
    expect(await d.head(key)).toEqual({ size: png.length });
    expect((await d.readStart(key, 4)).equals(png.subarray(0, 4))).toBe(true);
    await d.remove([key]);
    expect(await d.head(key)).toBeNull();
  });

  it('colaborador com estoque pode enviar foto; sem estoque, não', () => {
    expect(staffAccess('POST', '/uploads/presign', ['stock']).ok).toBe(true);
    expect(staffAccess('POST', `/uploads/${EID}/complete`, ['stock']).ok).toBe(true);
    expect(staffAccess('POST', '/uploads/presign', ['sales']).ok).toBe(false);
  });
});
