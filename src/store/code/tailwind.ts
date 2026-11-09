import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'lightningcss';
import { compile } from 'tailwindcss';
import { FONT_FAMILY } from '../fonts.rules';

/**
 * Gera o CSS do componente Código com o próprio Tailwind (v4, a mesma versão da web), a partir das classes que o parser
 * aprovou. Sem preflight (não mexe no resto da loja). As variáveis do tema saem presas a `.bk-code` em vez de :root,
 * para o código de um lojista não trocar cores e medidas do resto da página nem do painel.
 * Cores e fontes da loja viram classes em português: bg-marca, text-texto, border-linha, font-titulo, font-inter…
 */
const LOJA = `
@theme inline {
  --color-marca: var(--color-brand); --color-sobre-marca: var(--color-on-brand);
  --color-fundo: var(--shop-bg); --color-cartao: var(--shop-card); --color-texto: var(--shop-ink);
  --color-suave: var(--shop-muted); --color-linha: var(--shop-line); --color-leve: var(--shop-soft);
  --radius-loja: var(--shop-r);
  --font-titulo: var(--shop-head); --font-texto: var(--shop-body);
${Object.entries(FONT_FAMILY).map(([k, f]) => `  --font-${k}: ${f};`).join('\n')}
}`;
const ENTRY = `@layer theme, utilities;\n@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);\n${LOJA}`;

const dir = path.dirname(require.resolve('tailwindcss/package.json'));
/** As duas folhas do Tailwind ficam em memória; o compilador é novo a cada chamada. */
const sheets = new Map<string, Promise<string>>();
const sheet = (file: string) => { if (!sheets.has(file)) sheets.set(file, readFile(path.join(dir, file), 'utf8')); return sheets.get(file)!; };
/**
 * Um compilador por componente: o build() do Tailwind é cumulativo (guarda toda classe que já viu), então um compilador
 * compartilhado misturaria as classes de todas as lojas e o CSS cresceria sem parar.
 */
function fresh() {
  return compile(ENTRY, {
    base: dir,
    loadStylesheet: async (id: string) => {
      const file = id === 'tailwindcss/theme.css' ? 'theme.css' : id === 'tailwindcss/utilities.css' ? 'utilities.css' : null;
      if (!file) throw new Error(`Folha não permitida: ${id}`);
      return { base: dir, content: await sheet(file) };
    },
  });
}

export const MAX_CSS = 120_000;
/** A mesma base do Tailwind 4 que a web usa (Safari 16.4, Chrome 111, Firefox 128): o site já depende dela por causa do @layer. */
const TARGETS = { safari: (16 << 16) | (4 << 8), ios_saf: (16 << 16) | (4 << 8), chrome: 111 << 16, firefox: 128 << 16 };

/** CSS das classes (já aprovadas por classOk). As variáveis do tema ficam dentro de .bk-code. */
export async function buildCss(classes: string[]): Promise<string> {
  if (!classes.length) return '';
  const c = await fresh();
  const raw = c.build(classes).replace(/:root,\s*:host/g, '.bk-code').replace(/(^|[\s,{}])(:root|:host)(?=[\s,{])/g, '$1.bk-code');
  // Achata o CSS aninhado e minifica (mesmo motor que a web usa no build).
  const css = transform({ filename: 'code.css', code: Buffer.from(raw), minify: true, targets: TARGETS }).code.toString();
  return css.length > MAX_CSS ? '' : css;
}
