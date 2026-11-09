import { classOk, parseCode } from './code.rules';
import { CodeService } from './code.service';
import { sanitizePage } from '../builder.rules';

const errs = (code: string) => parseCode(code).errors.map((e) => e.message).join(' | ');

describe('componente Código: só o que o site oferece', () => {
  it('lê JSX com tags de conteúdo, classes e dados do site', () => {
    const r = parseCode(`
      <section className="grid gap-4 p-6">
        <h2 className="text-2xl font-titulo">{loja.nome}</h2>
        <Produtos fonte="ofertas" limite={4} className="grid grid-cols-2">
          <a href={produto.link} className="block">
            <img src={produto.imagem} alt={produto.nome} />
            <p>{produto.nome}</p>
            <Se tem={produto.precoAntigo}><s>{produto.precoAntigo}</s></Se>
            <Adicionar className="bg-marca">Comprar</Adicionar>
          </a>
          <Vazio>Sem ofertas agora</Vazio>
        </Produtos>
        <Busca placeholder="O que você procura?" />
      </section>`);
    expect(r.errors).toEqual([]);
    expect(r.classes).toEqual(expect.arrayContaining(['grid', 'gap-4', 'bg-marca', 'font-titulo']));
    const sec = r.ast[0] as { tag: string; c: unknown[] };
    expect(sec.tag).toBe('section');
  });

  it('recusa script, iframe, style e tags de formulário', () => {
    expect(errs('<script>alert(1)</script>')).toMatch(/<script> não é permitido/);
    expect(errs('<iframe src="https://x.com" />')).toMatch(/<iframe> não é permitido/);
    expect(errs('<style>{"body{}"}</style>')).toMatch(/<style> não é permitido/);
    expect(errs('<form><input /></form>')).toMatch(/<form> não é permitido/);
    expect(errs('<svg><use href="#x" /></svg>')).toMatch(/<svg> não é permitido/);
  });

  it('recusa eventos, style, dangerouslySetInnerHTML e espalhar atributos', () => {
    expect(errs('<div onClick={produto.nome}>x</div>')).toMatch(/eventos não são permitidos/);
    expect(errs('<img src="https://x.com/a.png" onError="alert(1)" />')).toMatch(/eventos não são permitidos/);
    expect(errs('<div style="color:red">x</div>')).toMatch(/style não é permitido/);
    expect(errs('<div dangerouslySetInnerHTML={x}>x</div>')).toMatch(/não é permitido|não existe/);
    expect(errs('<div {...props}>x</div>')).toMatch(/Espalhar atributos/);
  });

  it('não deixa escrever JavaScript nas chaves: só caminho de dado conhecido', () => {
    expect(errs('<p>{fetch("https://x.com")}</p>')).toMatch(/Só dá para usar dados do site/);
    expect(errs('<p>{produtos.map(p => p.nome)}</p>')).toMatch(/Só dá para usar dados do site/);
    expect(errs('<p>{window.location}</p>')).toMatch(/"window" não existe/);
    expect(errs('<p>{loja.constructor}</p>')).toMatch(/loja.constructor não existe/);
    expect(errs('<p>{produto.nome}</p>')).toMatch(/só funciona dentro de <Produtos>/);
    expect(errs('<p>{a ? b : c}</p>')).toMatch(/Só dá para usar dados do site/);
    // nada herdado do protótipo do JavaScript
    expect(errs('<p>{constructor.name}</p>')).toMatch(/"constructor" não existe/);
    expect(errs('<p>{loja.__proto__}</p>')).toMatch(/Só dá para usar dados do site/);
    expect(errs('<div constructor="x">x</div>')).toMatch(/atributo constructor não é permitido/);
    expect(errs('<Produtos toString="x" />')).toMatch(/não tem o atributo toString/);
    expect(errs('<p>&constructor;</p>')).toBe('');
  });

  it('links e imagens só por endereços seguros', () => {
    expect(errs('<a href="javascript:alert(1)">x</a>')).toMatch(/href:/);
    expect(errs('<a href="data:text/html,x">x</a>')).toMatch(/href:/);
    expect(errs('<img src="http://x.com/a.png" />')).toMatch(/src precisa/);
    expect(errs('<img src="data:image/svg+xml,<svg onload=1>" />')).toBeTruthy();
    expect(errs('<Produtos><img src={produto.nome} /></Produtos>')).toMatch(/src só aceita uma foto do site/);
    expect(errs('<Produtos><a href={produto.imagem}>x</a></Produtos>')).toMatch(/href só aceita um link do site/);
    expect(errs('<a href="#ofertas">x</a><a href="https://instagram.com/loja">y</a><a href="cart">z</a>')).toBe('');
  });

  it('classes: recusa url(), seletor livre com & e caracteres fora de classe', () => {
    expect(classOk('bg-[url(https://x.com/t.png)]')).toBe(false);
    expect(classOk('[&_*]:hidden')).toBe(false);
    expect(classOk('[&~*]:hidden')).toBe(false);
    expect(classOk('bg-[image-set(x)]')).toBe(false);
    expect(classOk('content-["x"]')).toBe(false);
    expect(classOk('a\\b')).toBe(false);
    expect(classOk('hover:bg-marca/80')).toBe(true);
    expect(classOk('@3xl:grid-cols-[minmax(0,1fr)_2fr]')).toBe(true);
    expect(errs('<div className="p-4 bg-[url(https://x.com/a.png)]">x</div>')).toMatch(/não é permitida/);
  });

  it('não aninha listas e exige Adicionar dentro de Produtos', () => {
    expect(errs('<Produtos><Categorias><p>x</p></Categorias></Produtos>')).toMatch(/não pode ficar dentro de outra lista/);
    expect(errs('<Adicionar>Comprar</Adicionar>')).toMatch(/só funciona dentro de <Produtos>/);
    expect(errs('<Produtos fonte="tudo" />')).toMatch(/fonte aceita/);
    expect(errs('<Inventado />')).toMatch(/<Inventado> não existe/);
  });

  it('erros apontam a linha e a árvore volta vazia', () => {
    const r = parseCode('<div>\n  <p>ok</p>\n  <script></script>\n</div>');
    expect(r.ast).toEqual([]);
    expect(r.errors[0].line).toBe(3);
  });

  it('acusa tag sem fechar e fechamento trocado', () => {
    expect(errs('<div><p>x</div>')).toMatch(/Esperava <\/p>/);
    expect(errs('<div>')).toMatch(/Faltou fechar <div>/);
  });
});

describe('CodeService', () => {
  const svc = new CodeService();

  it('gera o CSS só das classes usadas, com o tema preso ao componente', async () => {
    const out = await svc.compile('<div className="p-4 bg-marca text-white font-inter hover:opacity-80">{loja.nome}</div>');
    expect(out.errors).toEqual([]);
    expect(out.css).toContain('.bg-marca{background-color:var(--color-brand)}');
    expect(out.css).toContain('.bk-code{');
    expect(out.css).not.toMatch(/:root|:host/);
    expect(out.css).not.toContain('&:hover');
    expect(out.fonts).toEqual(['inter']);
  }, 20_000);

  it('cada componente tem só o CSS das próprias classes (o compilador não acumula)', async () => {
    const a = await svc.compile('<p className="text-red-500">a</p>');
    const b = await svc.compile('<p className="text-blue-500">b</p>');
    expect(a.css).toContain('text-red-500'); expect(a.css).not.toContain('text-blue-500');
    expect(b.css).toContain('text-blue-500'); expect(b.css).not.toContain('text-red-500');
  }, 20_000);

  it('ao salvar ignora árvore e CSS mandados pelo navegador e gera de novo', async () => {
    const page = sanitizePage({ v: 1, sections: [{ id: 'sec1abcd', style: {}, blocks: [{ id: 'blk1abcd', type: 'code', span: 4, col: 0, hideOn: 'none',
      props: { code: '<p className="p-2">{loja.nome}</p>', out: { ast: [{ t: 'el', tag: 'script', a: {}, c: ['alert(1)'] }], css: 'body{display:none}' } } }] }] });
    expect(page.sections[0].blocks[0].props.out).toBeUndefined();
    await svc.compilePage(page);
    const out = page.sections[0].blocks[0].props.out as { ast: { tag: string }[]; css: string };
    expect(out.ast[0].tag).toBe('p');
    expect(out.css).not.toContain('body{display:none}');
  }, 20_000);

  it('fonte por componente: só fontes da lista', () => {
    const page = sanitizePage({ v: 1, sections: [{ id: 'sec1abcd', style: {}, blocks: [
      { id: 'blk1abcd', type: 'heading', span: 4, col: 0, hideOn: 'none', font: { head: 'cinzel', body: 'inter' }, props: { text: 'Oi' } },
      { id: 'blk2abcd', type: 'heading', span: 4, col: 0, hideOn: 'none', font: { head: 'comic-sans', body: 'greatvibes' }, props: { text: 'Oi' } },
    ] }] });
    expect(page.sections[0].blocks[0].font).toEqual({ head: 'cinzel', body: 'inter' });
    expect(page.sections[0].blocks[1].font).toBeUndefined(); // manuscrita não vale para texto corrido
  });
});
