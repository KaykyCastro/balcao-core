import { Injectable } from '@nestjs/common';
import type { SitePage } from '../builder.rules';
import { parseCode, type CodeError, type CodeNode } from './code.rules';
import { buildCss } from './tailwind';

export interface CodeOut { ast: CodeNode[]; css: string; fonts: string[]; errors: CodeError[] }

/** Componente Código: texto → árvore segura + CSS do Tailwind. Nada do que o navegador manda como resultado é aceito. */
@Injectable()
export class CodeService {
  async compile(code: string): Promise<CodeOut> {
    const r = parseCode(code);
    if (r.errors.length) return { ast: [], css: '', fonts: [], errors: r.errors };
    const css = await buildCss(r.classes);
    if (r.classes.length && !css) return { ast: [], css: '', fonts: [], errors: [{ line: 1, message: 'Classes demais: o estilo ficou grande demais para um componente' }] };
    return { ast: r.ast, css, fonts: r.fonts, errors: [] };
  }

  /** Recompila todos os componentes Código da página (depois do sanitizePage, que já descartou qualquer `out` do cliente). */
  async compilePage(page: SitePage): Promise<void> {
    for (const s of page.sections) for (const b of s.blocks) {
      if (b.type !== 'code') continue;
      b.props.out = await this.compile(typeof b.props.code === 'string' ? b.props.code : '');
    }
  }
}
