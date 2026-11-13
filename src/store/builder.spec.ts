import { BLOCK_TYPES, linkOk, pageUrls, sanitizePage } from './builder.rules';

const page = (blocks: unknown[], style: unknown = {}) => ({ sections: [{ id: 'sec1', style, blocks }] });

describe('construtor de sites (página por seções)', () => {
  it('tem um catálogo grande de componentes', () => {
    expect(BLOCK_TYPES.length).toBe(140);
    expect(BLOCK_TYPES).toEqual(expect.arrayContaining(['navbar', 'banner', 'productGrid', 'video', 'search', 'icon', 'footer', 'editorialHero', 'lookbook', 'luxeProducts', 'concierge']));
  });

  it('componentes de moda: guarda só os campos conhecidos e corta listas e textos', () => {
    const p = sanitizePage(page([
      { id: 'blk1', type: 'collectionBento', props: { title: 'Coleções', fromCategories: false, items: Array.from({ length: 9 }, () => ({ title: 'x'.repeat(90), link: '#novidades', evil: 1 })) } },
      { id: 'blk2', type: 'giantText', props: { text: 'VERÃO', outline: true, align: 'meio', sub: 'Nova coleção' } },
      { id: 'blk3', type: 'campaignGrid', props: { limit: 99, position: 'end', textColor: 'dark', source: 'new' } },
    ]));
    const [a, b, c] = p.sections[0].blocks;
    expect((a.props.items as unknown[]).length).toBe(5);
    expect(a.props.items).toEqual(expect.arrayContaining([expect.not.objectContaining({ evil: 1 })]));
    expect((a.props.items as { title: string }[])[0].title.length).toBe(60);
    expect(b.props).toEqual({ text: 'VERÃO', outline: true, sub: 'Nova coleção' });
    expect(c.props).toMatchObject({ limit: 12, position: 'end', textColor: 'dark', source: 'new' });
    expect(() => sanitizePage(page([{ id: 'blk1', type: 'lookSlider', props: { items: [{ title: 'Look', link: 'javascript:alert(1)' }] } }]))).toThrow(/Link inválido/);
  });

  it('vitrines de campanha: cores só em hexadecimal, números no limite, listas cortadas', () => {
    const p = sanitizePage(page([
      { id: 'blk1', type: 'splitPromo', props: { big: '11.11', left: '#FF4D2E', right: 'red', coupon: true, height: 'xl' } },
      { id: 'blk2', type: 'bestSellerRank', props: { limit: 50, columns: 1 } },
      { id: 'blk3', type: 'photoStrip', props: { images: Array.from({ length: 12 }, () => ({ src: '', label: 'Look' })), ratio: '3:4' } },
      { id: 'blk4', type: 'heroMixed', props: { light: 'Esquenta', bold: 'Verão', overlay: 300, align: 'center' } },
    ]));
    const [a, b, c, d] = p.sections[0].blocks;
    expect(a.props).toEqual({ big: '11.11', left: '#FF4D2E', coupon: true, height: 'xl' });
    expect(b.props).toEqual({ limit: 12, columns: 3 });
    expect((c.props.images as unknown[]).length).toBe(8);
    expect(d.props).toMatchObject({ light: 'Esquenta', bold: 'Verão', overlay: 80, align: 'center' });
  });

  it('limpa campos desconhecidos, corta textos e normaliza números', () => {
    const p = sanitizePage(page([{ id: 'blk1', type: 'heading', span: 9, props: { text: 'x'.repeat(500), size: 'gigante', align: 'center', hack: '<script>' } }], { padY: 'lg', evil: 1, overlay: 200 }));
    const b = p.sections[0].blocks[0];
    expect(b.span).toBe(4);
    expect((b.props.text as string).length).toBe(160);
    expect(b.props).not.toHaveProperty('size');
    expect(b.props).not.toHaveProperty('hack');
    expect(p.sections[0].style).toEqual({ padY: 'lg', overlay: 90 });
  });

  it('recusa componente desconhecido, id repetido e link perigoso', () => {
    expect(() => sanitizePage(page([{ id: 'blk1', type: 'iframe', props: {} }]))).toThrow('desconhecido');
    expect(() => sanitizePage(page([{ id: 'blk1', type: 'text' }, { id: 'blk1', type: 'text' }]))).toThrow('Identificador');
    expect(() => sanitizePage(page([{ id: 'blk1', type: 'button', props: { link: 'javascript:alert(1)' } }]))).toThrow('Link inválido');
    expect(() => sanitizePage(page([{ id: 'blk1', type: 'image', props: { src: 'data:image/png;base64,AAA' } }]))).toThrow('Arquivo inválido');
  });

  it('aceita os links da loja', () => {
    for (const l of ['', '#ofertas', 'cart', 'search', 'cat:507f1f77bcf86cd799439011', 'p:507f1f77bcf86cd799439011', '/loja/x/trocas', 'https://instagram.com/x']) expect(linkOk(l)).toBe(true);
    for (const l of ['http://x.com', 'javascript:x', '//evil.com', 'cat:1']) expect(linkOk(l)).toBe(false);
  });

  it('acha as imagens e vídeos, inclusive dentro de listas', () => {
    const p = sanitizePage(page([
      { id: 'blk1', type: 'carousel', props: { slides: [{ image: 'https://a/1.webp' }, { image: 'https://a/2.webp' }] } },
      { id: 'blk2', type: 'video', props: { src: 'https://a/v.mp4', poster: 'https://a/p.webp' } },
    ], { bgImage: 'https://a/bg.webp' }));
    expect(pageUrls(p).sort()).toEqual(['https://a/1.webp', 'https://a/2.webp', 'https://a/bg.webp', 'https://a/p.webp', 'https://a/v.mp4']);
  });

  it('limita o tamanho da página', () => {
    expect(() => sanitizePage({ sections: Array.from({ length: 61 }, (_, i) => ({ id: `sec${i}x`, blocks: [] })) })).toThrow('no máximo');
  });
});
