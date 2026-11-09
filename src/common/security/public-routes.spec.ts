import 'reflect-metadata';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PUBLIC_ROUTES } from './public-routes';

const SRC = join(__dirname, '..', '..');
const METHOD: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH', 5: 'ALL', 6: 'OPTIONS', 7: 'HEAD' };

function controllers(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return controllers(p);
    return f.endsWith('.controller.ts') && !f.endsWith('.spec.ts') ? [p] : [];
  });
}

/** Rotas que o JwtAuthGuard deixa passar sem sessão (@Public na classe ou no método). */
function publicRoutes() {
  const out: string[] = [];
  for (const file of controllers(SRC)) {
    const mod = require(file) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-require-imports
    for (const cls of Object.values(mod)) {
      if (typeof cls !== 'function' || Reflect.getMetadata('path', cls) === undefined) continue;
      const base = [].concat(Reflect.getMetadata('path', cls) ?? '')[0] as string;
      const clsPublic = !!Reflect.getMetadata('isPublic', cls);
      const proto = (cls as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (name === 'constructor' || !desc || typeof desc.value !== 'function') continue; // getters não são rotas
        const fn = desc.value as object;
        const p = Reflect.getMetadata('path', fn);
        if (p === undefined) continue;
        if (!(Reflect.getMetadata('isPublic', fn) ?? clsPublic)) continue;
        const path = ('/' + [base, ...[].concat(p)].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
        out.push(`${METHOD[Reflect.getMetadata('method', fn)]} ${path}  (${relative(SRC, file)})`);
      }
    }
  }
  return out;
}

describe('segurança: rotas sem login', () => {
  const found = publicRoutes();
  const approved = new Set(PUBLIC_ROUTES.map(([m, p]) => `${m} ${p}`));

  it('só as rotas públicas aprovadas respondem sem login', () => {
    const extra = found.filter((r) => !approved.has(r.split('  (')[0]));
    // Rota nova sem login? Revise o que ela expõe e acrescente em common/security/public-routes.ts.
    expect(extra).toEqual([]);
  });

  it('a lista aprovada não tem rota que já não existe', () => {
    const live = new Set(found.map((r) => r.split('  (')[0]));
    expect([...approved].filter((r) => !live.has(r))).toEqual([]);
  });

  it('toda rota pública diz por que é pública', () => {
    expect(PUBLIC_ROUTES.filter(([, , why]) => !why.trim())).toEqual([]);
  });
});
