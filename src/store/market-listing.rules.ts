/**
 * Marketplace "Lojas no Balcão": só entram produtos COM FOTO. Um produto sem imagem fica só na vitrine da própria
 * loja (lá o lojista decide); no marketplace ele nunca aparece: lista, ofertas, últimas unidades, busca, recomendados,
 * curtidos, vídeos das lojas, novidades e vendas recentes da faixa "Agora", e a vitrine da página inicial.
 * `image` é a primeira foto do produto (o cadastro sempre preenche com images[0]).
 */
export const HAS_IMAGE = { image: { $type: 'string', $nin: ['', null] } } as const;

export const hasImage = (p: { image?: string | null } | null | undefined): boolean => typeof p?.image === 'string' && p.image.trim().length > 0;
