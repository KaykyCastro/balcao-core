import { HAS_IMAGE, hasImage } from './market-listing.rules';

describe('marketplace: só produtos com foto', () => {
  it('reconhece quem tem foto', () => {
    expect(hasImage({ image: 'https://arquivos.exemplo.com/p/1.webp' })).toBe(true);
    expect(hasImage({ image: '' })).toBe(false);
    expect(hasImage({ image: '   ' })).toBe(false);
    expect(hasImage({ image: null })).toBe(false);
    expect(hasImage({})).toBe(false);
    expect(hasImage(null)).toBe(false);
  });
  it('filtro do Mongo exige texto e não vazio', () => {
    expect(HAS_IMAGE).toEqual({ image: { $type: 'string', $nin: ['', null] } });
  });
});
