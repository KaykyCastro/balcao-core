import { linkOk } from '../builder.rules';
import { FONT_KEYS } from '../fonts.rules';

/**
 * Componente "Código" do construtor: o lojista escreve em sintaxe de React (JSX) com classes do Tailwind, mas NADA é
 * executado. Este parser lê o texto e devolve uma árvore de dados (CodeNode) que a vitrine só desenha:
 * - só tags HTML de conteúdo (sem script, iframe, form, input, svg, style…);
 * - só atributos da lista (className, href, src, alt…); eventos (onClick…), style e dangerouslySetInnerHTML são recusados;
 * - expressões só como caminho de dado do site ({produto.nome}); sem chamada, operador, função ou map;
 * - as "funções" são componentes prontos do site (<Produtos>, <Categorias>, <Busca>, <Avaliacoes>…).
 * As classes passam por `classOk` e viram CSS no servidor (tailwind.ts); o CSS mandado pelo navegador é ignorado.
 */

export type CodeValue = string | number | boolean | { v: string };
export type CodeNode =
  | string
  | { t: 'v'; p: string }
  | { t: 'el'; tag: string; a: Record<string, CodeValue>; c: CodeNode[] }
  | { t: 'cp'; n: string; a: Record<string, CodeValue>; c: CodeNode[] };
export interface CodeError { line: number; message: string }
export interface CodeResult { ast: CodeNode[]; classes: string[]; fonts: string[]; errors: CodeError[] }

export const MAX_CODE = 20_000;
const MAX_NODES = 1500;
const MAX_DEPTH = 40;
const MAX_CLASSES = 3000;

const VOID = new Set(['br', 'hr', 'img']);
export const HTML_TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'br', 'hr', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'img', 'a', 'figure', 'figcaption', 'blockquote', 'cite', 'q', 'time', 'address', 'details', 'summary',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
]);

/** Dados do site que o código pode mostrar, por escopo. `img` = pode ir em src; `link` = pode ir em href. */
export const FIELDS: Record<string, Record<string, 'text' | 'img' | 'link'>> = {
  loja: { nome: 'text', frase: 'text', sobre: 'text', logo: 'img', whatsapp: 'link', instagram: 'link', email: 'text', horario: 'text', cidade: 'text' },
  produto: { nome: 'text', preco: 'text', precoAntigo: 'text', desconto: 'text', parcelas: 'text', imagem: 'img', link: 'link', categoria: 'text', nota: 'text', avaliacoes: 'text', vendidos: 'text', restam: 'text' },
  categoria: { nome: 'text', imagem: 'img', link: 'link' },
  avaliacao: { nome: 'text', texto: 'text', nota: 'text', foto: 'img', data: 'text', produto: 'text' },
  cupom: { codigo: 'text', desconto: 'text', minimo: 'text', validade: 'text' },
};

type AttrSpec = { k: 'str'; max: number } | { k: 'int'; min: number; max: number } | { k: 'bool' } | { k: 'enum'; o: string[] } | { k: 'nota' };
/** Componentes do site. `scope`: o que fica disponível dentro dele (um item por vez). */
export const COMPONENTS: Record<string, { attrs: Record<string, AttrSpec>; scope?: string; children: boolean; inside?: string }> = {
  Produtos: { scope: 'produto', children: true, attrs: { fonte: { k: 'enum', o: ['novidades', 'ofertas', 'mais-vendidos', 'todos', 'menor-preco', 'maior-preco', 'categoria'] }, categoria: { k: 'str', max: 80 }, limite: { k: 'int', min: 1, max: 24 }, className: { k: 'str', max: 2000 } } },
  Categorias: { scope: 'categoria', children: true, attrs: { limite: { k: 'int', min: 1, max: 24 }, className: { k: 'str', max: 2000 } } },
  Avaliacoes: { scope: 'avaliacao', children: true, attrs: { limite: { k: 'int', min: 1, max: 24 }, comFoto: { k: 'bool' }, className: { k: 'str', max: 2000 } } },
  Cupons: { scope: 'cupom', children: true, attrs: { limite: { k: 'int', min: 1, max: 12 }, className: { k: 'str', max: 2000 } } },
  Vazio: { children: true, attrs: {} },
  Busca: { children: false, attrs: { placeholder: { k: 'str', max: 80 }, className: { k: 'str', max: 2000 } } },
  Adicionar: { children: true, inside: 'produto', attrs: { className: { k: 'str', max: 2000 } } },
  Estrelas: { children: false, attrs: { nota: { k: 'nota' }, className: { k: 'str', max: 2000 } } },
  Icone: { children: false, attrs: { nome: { k: 'str', max: 40 }, className: { k: 'str', max: 2000 } } },
  Se: { children: true, attrs: { tem: { k: 'str', max: 0 }, falta: { k: 'str', max: 0 } } },
};
/** Só chaves próprias (nada herdado do protótipo, como constructor ou toString). */
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);
const LISTS = new Set(['Produtos', 'Categorias', 'Avaliacoes', 'Cupons']);

/** Atributos de tag HTML: tipo do valor e em quais tags valem. */
const HTML_ATTRS: Record<string, { kind: 'class' | 'text' | 'id' | 'src' | 'href' | 'int' | 'bool'; tags?: string[] }> = {
  className: { kind: 'class' }, id: { kind: 'id' }, title: { kind: 'text' }, 'aria-label': { kind: 'text' },
  alt: { kind: 'text', tags: ['img'] }, src: { kind: 'src', tags: ['img'] }, href: { kind: 'href', tags: ['a'] },
  colSpan: { kind: 'int', tags: ['td', 'th'] }, rowSpan: { kind: 'int', tags: ['td', 'th'] }, open: { kind: 'bool', tags: ['details'] },
};

/**
 * Uma classe do Tailwind é aceita só com caracteres de classe; valores livres ([…]) não podem carregar url(), image-set,
 * aspas, barra invertida, & (seletor livre, alcançaria fora do componente) nem chaves.
 */
const CLASS_RE = /^[A-Za-z0-9_\-:/.[\]%#(),!@+*=]{1,160}$/;
export function classOk(c: string): boolean {
  if (!CLASS_RE.test(c)) return false;
  const l = c.toLowerCase();
  return !/(url|image-set|expression|import|src)\(|&|\\/.test(l) && !/@(import|font-face|media|supports|layer)/.test(l);
}

class P {
  i = 0; nodes = 0; errors: CodeError[] = []; classes = new Set<string>(); fonts = new Set<string>();
  constructor(private s: string) {}
  line(at = this.i) { let n = 1; for (let k = 0; k < at && k < this.s.length; k++) if (this.s[k] === '\n') n++; return n; }
  err(message: string, at = this.i) { if (this.errors.length < 30) this.errors.push({ line: this.line(at), message }); }
  eof() { return this.i >= this.s.length; }
  peek(n = 0) { return this.s[this.i + n] ?? ''; }
  ws() { while (!this.eof() && /\s/.test(this.peek())) this.i++; }
  name() { const m = /^[A-Za-z][A-Za-z0-9-]*/.exec(this.s.slice(this.i)); if (!m) return ''; this.i += m[0].length; return m[0]; }

  /** Lê filhos até `</close>` (ou o fim). scopes = escopos abertos (loja sempre). */
  children(close: string | null, scopes: string[], depth: number): CodeNode[] {
    const out: CodeNode[] = [];
    while (!this.eof()) {
      if (this.s.startsWith('</', this.i)) {
        const at = this.i; this.i += 2; const n = this.name(); this.ws();
        if (this.peek() === '>') this.i++;
        if (close === null) { this.err(`Fechamento </${n}> sem abertura`, at); continue; }
        if (n !== close) this.err(`Esperava </${close || ''}> e encontrou </${n}>`, at);
        return out;
      }
      if (this.peek() === '<') { const el = this.element(scopes, depth); if (el) out.push(el); continue; }
      if (this.peek() === '{') { const v = this.expr(scopes); if (v) out.push(v); continue; }
      const start = this.i;
      while (!this.eof() && this.peek() !== '<' && this.peek() !== '{') this.i++;
      const text = jsxText(this.s.slice(start, this.i));
      if (text.includes('}')) this.err('A chave } solta no texto não é permitida: escreva {"}"}', start);
      if (text) out.push(text);
    }
    if (close !== null) this.err(`Faltou fechar <${close || '>'}>`);
    return out;
  }

  /** {caminho.do.dado} ou {/* comentário *\/} no meio do texto. */
  expr(scopes: string[]): CodeNode | null {
    const at = this.i; this.i++;
    const end = this.s.indexOf('}', this.i);
    if (end < 0) { this.err('Faltou fechar a chave }', at); this.i = this.s.length; return null; }
    const raw = this.s.slice(this.i, end).trim(); this.i = end + 1;
    if (/^\/\*[\s\S]*\*\/$/.test(raw)) return null;
    const lit = /^"([^"\\]{0,200})"$/.exec(raw) ?? /^'([^'\\]{0,200})'$/.exec(raw);
    if (lit) return lit[1];
    const p = this.path(raw, scopes, at);
    return p ? { t: 'v', p } : null;
  }

  /** Só caminho de dado conhecido do escopo aberto: loja.nome, produto.preco… */
  path(raw: string, scopes: string[], at: number): string | null {
    const m = /^([a-z]+)\.([A-Za-z]+)$/.exec(raw);
    if (!m) { this.err(`Só dá para usar dados do site entre chaves, como {produto.nome}. "${raw.slice(0, 40)}" não é permitido`, at); return null; }
    const [, scope, field] = m;
    if (!own(FIELDS, scope)) { this.err(`"${scope}" não existe. Use: ${Object.keys(FIELDS).join(', ')}`, at); return null; }
    if (!own(FIELDS[scope], field)) { this.err(`${scope}.${field} não existe. Campos de ${scope}: ${Object.keys(FIELDS[scope]).join(', ')}`, at); return null; }
    if (!scopes.includes(scope)) { this.err(`{${scope}.${field}} só funciona dentro de <${Object.entries(COMPONENTS).find(([, c]) => c.scope === scope)?.[0]}>`, at); return null; }
    return `${scope}.${field}`;
  }

  element(scopes: string[], depth: number): CodeNode | null {
    const at = this.i; this.i++;
    if (this.s.startsWith('!--', this.i)) { const e = this.s.indexOf('-->', this.i); this.i = e < 0 ? this.s.length : e + 3; return null; }
    if (++this.nodes > MAX_NODES) { this.err(`Use no máximo ${MAX_NODES} elementos`, at); this.i = this.s.length; return null; }
    if (depth > MAX_DEPTH) { this.err('Elementos aninhados demais', at); this.i = this.s.length; return null; }
    // Fragmento <>…</>
    if (this.peek() === '>') { this.i++; return { t: 'el', tag: 'div', a: { className: 'contents' }, c: this.children('', scopes, depth + 1) }; }
    const tag = this.name();
    if (!tag) { this.err('Tag inválida depois de <', at); this.i++; return null; }
    const isComp = /^[A-Z]/.test(tag);
    const comp = isComp ? own(COMPONENTS, tag) : undefined;
    if (isComp && !comp) this.err(`<${tag}> não existe. Componentes do site: ${Object.keys(COMPONENTS).join(', ')}`, at);
    if (!isComp && !HTML_TAGS.has(tag)) this.err(`<${tag}> não é permitido. ${tag === 'script' || tag === 'iframe' || tag === 'style' ? 'Código e páginas externas não rodam na loja.' : 'Use tags de conteúdo como div, p, h2, img, a, ul.'}`, at);
    const attrs: Record<string, CodeValue> = {};
    let selfClose = false;
    for (;;) {
      this.ws();
      if (this.eof()) { this.err(`Faltou fechar <${tag}>`, at); return null; }
      if (this.s.startsWith('/>', this.i)) { this.i += 2; selfClose = true; break; }
      if (this.peek() === '>') { this.i++; break; }
      if (this.peek() === '{') { this.err('Espalhar atributos ({...x}) não é permitido', this.i); this.expr(scopes); continue; }
      const aAt = this.i; const an = this.name();
      if (!an) { this.err(`Atributo inválido em <${tag}>`, aAt); this.i++; continue; }
      // Eventos, style e HTML cru: recusa pelo nome, sem nem olhar o valor.
      const banned = /^on[A-Z]/.test(an) ? `${an}: eventos não são permitidos. Use os componentes do site (<Adicionar>, <Busca>…)`
        : an === 'style' ? 'style não é permitido: use classes do Tailwind em className'
        : an === 'dangerouslySetInnerHTML' ? 'dangerouslySetInnerHTML não é permitido' : '';
      if (banned) { this.err(banned, aAt); this.skipValue(); continue; }
      let val: CodeValue = true;
      this.ws();
      if (this.peek() === '=') {
        this.i++; this.ws();
        const q = this.peek();
        if (q === '"' || q === "'") { const e = this.s.indexOf(q, this.i + 1); if (e < 0) { this.err('Faltou fechar as aspas', aAt); this.i = this.s.length; return null; } val = this.s.slice(this.i + 1, e); this.i = e + 1; }
        else if (q === '{') {
          const e = this.s.indexOf('}', this.i); if (e < 0) { this.err('Faltou fechar a chave }', aAt); this.i = this.s.length; return null; }
          const raw = this.s.slice(this.i + 1, e).trim(); this.i = e + 1;
          if (/^-?\d{1,6}$/.test(raw)) val = Number(raw);
          else if (raw === 'true' || raw === 'false') val = raw === 'true';
          else if (/^"[^"\\]*"$/.test(raw) || /^'[^'\\]*'$/.test(raw)) val = raw.slice(1, -1);
          else { const p = this.path(raw, scopes, aAt); if (!p) continue; val = { v: p }; }
        } else { this.err(`Valor do atributo ${an} precisa estar entre aspas ou chaves`, aAt); continue; }
      }
      const ok = isComp ? this.compAttr(tag, comp, an, val, aAt) : this.htmlAttr(tag, an, val, aAt);
      if (ok !== undefined) attrs[an] = ok;
    }
    if (comp?.inside && !scopes.includes(comp.inside)) this.err(`<${tag}> só funciona dentro de <Produtos>`, at);
    if (tag === 'Se' && (attrs.tem === undefined) === (attrs.falta === undefined)) this.err('<Se> precisa de tem={…} ou falta={…} (um dos dois)', at);
    if (LISTS.has(tag) && scopes.some((s) => s !== 'loja')) this.err(`<${tag}> não pode ficar dentro de outra lista`, at);
    const inner = comp?.scope ? [...scopes, comp.scope] : scopes;
    let c: CodeNode[] = [];
    if (!selfClose) {
      if (VOID.has(tag)) this.err(`<${tag}> não tem conteúdo: feche com <${tag} />`, at);
      c = this.children(tag, inner, depth + 1);
      if (comp && !comp.children && c.length) this.err(`<${tag}> não aceita conteúdo dentro`, at);
    }
    if (isComp && !comp) return null;
    if (!isComp && !HTML_TAGS.has(tag)) return null;
    return isComp ? { t: 'cp', n: tag, a: attrs, c } : { t: 'el', tag, a: attrs, c };
  }

  /** Pula o valor de um atributo recusado ("…", '…' ou {…}). */
  skipValue() {
    this.ws(); if (this.peek() !== '=') return; this.i++; this.ws();
    const q = this.peek(); const close = q === '{' ? '}' : q === '"' || q === "'" ? q : '';
    if (!close) return;
    const e = this.s.indexOf(close, this.i + 1); this.i = e < 0 ? this.s.length : e + 1;
  }

  cls(v: CodeValue, at: number): string | undefined {
    if (typeof v !== 'string') { this.err('className precisa ser um texto entre aspas (classes do Tailwind)', at); return undefined; }
    const list = v.split(/\s+/).filter(Boolean);
    const good: string[] = [];
    for (const c of list) {
      if (!classOk(c)) { this.err(`Classe "${c.slice(0, 60)}" não é permitida`, at); continue; }
      if (this.classes.size >= MAX_CLASSES) { this.err('Classes demais neste componente', at); break; }
      this.classes.add(c); good.push(c);
      const f = /(?:^|:)font-([a-z]+)$/.exec(c); if (f && (FONT_KEYS as readonly string[]).includes(f[1])) this.fonts.add(f[1]);
    }
    return good.join(' ');
  }

  htmlAttr(tag: string, an: string, v: CodeValue, at: number): CodeValue | undefined {
    if (/^on[A-Z]/.test(an)) { this.err(`${an}: eventos não são permitidos. Use os componentes do site (<Adicionar>, <Busca>…)`, at); return undefined; }
    if (an === 'style') { this.err('style não é permitido: use classes do Tailwind em className', at); return undefined; }
    if (an === 'class') { this.err('Use className (como no React), não class', at); return undefined; }
    const spec = own(HTML_ATTRS, an);
    if (!spec || (spec.tags && !spec.tags.includes(tag))) { this.err(`O atributo ${an} não é permitido em <${tag}>`, at); return undefined; }
    const bound = typeof v === 'object' ? v.v : null;
    switch (spec.kind) {
      case 'class': return this.cls(v, at);
      case 'id': if (typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v)) return v; this.err('id: letras minúsculas, números e hífen', at); return undefined;
      case 'text': if (typeof v === 'string') return v.slice(0, 200); if (bound) return v; this.err(`${an} precisa ser texto`, at); return undefined;
      case 'int': if (typeof v === 'number') return Math.min(12, Math.max(1, v)); this.err(`${an} precisa ser um número`, at); return undefined;
      case 'bool': return v === true;
      case 'src':
        if (bound) { if (own(FIELDS[bound.split('.')[0]], bound.split('.')[1]) === 'img') return v; this.err(`src só aceita uma foto do site (como {produto.imagem}), não {${bound}}`, at); return undefined; }
        if (typeof v === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/.test(v)) return v;
        this.err('src precisa ser um endereço https:// ou uma foto do site, como {produto.imagem}', at); return undefined;
      case 'href':
        if (bound) { if (own(FIELDS[bound.split('.')[0]], bound.split('.')[1]) === 'link') return v; this.err(`href só aceita um link do site (como {produto.link}), não {${bound}}`, at); return undefined; }
        if (typeof v === 'string' && linkOk(v.trim())) return v.trim();
        this.err('href: use #ancora, /caminho da loja, cart, search ou https://', at); return undefined;
    }
  }

  compAttr(tag: string, comp: (typeof COMPONENTS)[string] | undefined, an: string, v: CodeValue, at: number): CodeValue | undefined {
    if (!comp) return undefined;
    const spec = own(comp.attrs, an);
    if (!spec) { this.err(`<${tag}> não tem o atributo ${an}${Object.keys(comp.attrs).length ? `. Use: ${Object.keys(comp.attrs).join(', ')}` : ''}`, at); return undefined; }
    if (an === 'className') return this.cls(v, at);
    if (tag === 'Se') { if (typeof v === 'object') return v; this.err(`${an} precisa ser um dado do site, como {produto.precoAntigo}`, at); return undefined; }
    switch (spec.k) {
      case 'str': if (typeof v === 'string') return v.slice(0, spec.max); break;
      case 'int': if (typeof v === 'number') return Math.min(spec.max, Math.max(spec.min, v)); if (typeof v === 'string' && /^\d+$/.test(v)) return Math.min(spec.max, Math.max(spec.min, Number(v))); break;
      case 'bool': if (typeof v === 'boolean') return v; break;
      case 'enum': if (typeof v === 'string' && spec.o.includes(v)) return v; this.err(`${an} aceita: ${spec.o.join(', ')}`, at); return undefined;
      case 'nota': if (typeof v === 'number') return Math.min(5, Math.max(0, v)); if (typeof v === 'object' && /\.nota$/.test(v.v)) return v; break;
    }
    this.err(`Valor inválido em ${an} de <${tag}>`, at); return undefined;
  }
}

/** Texto como no JSX: linhas só de espaço somem; quebras e recuos viram um espaço. */
function jsxText(raw: string): string {
  if (!raw.includes('\n')) return decode(raw);
  const lines = raw.split('\n').map((l, i, all) => (i === 0 ? l.trimEnd() : i === all.length - 1 ? l.trimStart() : l.trim())).filter((l) => l !== '');
  return decode(lines.join(' '));
}
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', middot: '·', ndash: '–', mdash: '—', hellip: '…' };
const decode = (s: string) => s.replace(/&([a-z]+);/g, (m, k: string) => own(ENT, k) ?? m);

/** Lê o código do componente. Com erro, a árvore volta vazia (a vitrine não mostra meio componente). */
export function parseCode(code: string): CodeResult {
  const src = String(code ?? '').slice(0, MAX_CODE);
  const p = new P(src);
  const ast = p.children(null, ['loja'], 0);
  return p.errors.length ? { ast: [], classes: [], fonts: [], errors: p.errors } : { ast, classes: [...p.classes], fonts: [...p.fonts], errors: [] };
}
