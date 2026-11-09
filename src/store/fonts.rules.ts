/**
 * Fontes que a vitrine sabe carregar (balcao-web/src/features/store/fonts.ts usa as mesmas chaves).
 * Tema da loja, fontes por componente e as classes font-<chave> do componente Código aceitam só estas.
 */
export const FONT_KEYS = ['modern', 'poppins', 'montserrat', 'raleway', 'quicksand', 'nunito', 'inter', 'dmsans', 'manrope', 'outfit', 'jakarta', 'worksans', 'rubik', 'lato', 'opensans', 'sora', 'figtree', 'archivo', 'elegant', 'classic', 'lora', 'cormorant', 'baskerville', 'garamond', 'fraunces', 'merriweather', 'cinzel', 'prata', 'bebas', 'oswald', 'anton', 'abril', 'archivoblack', 'righteous', 'pacifico', 'dancing', 'greatvibes', 'caveat', 'satisfy'] as const;
/** Texto corrido: só as de leitura (sem as de impacto e manuscritas). */
export const BODY_FONT_KEYS = ['modern', 'poppins', 'montserrat', 'raleway', 'quicksand', 'nunito', 'inter', 'dmsans', 'manrope', 'outfit', 'jakarta', 'worksans', 'rubik', 'lato', 'opensans', 'sora', 'figtree', 'archivo', 'elegant', 'classic', 'lora', 'cormorant', 'baskerville', 'garamond', 'fraunces', 'merriweather', 'cinzel', 'prata'] as const;
export const FONT_FAMILY: Record<string, string> = {
  modern: '"Space Grotesk Variable", ui-sans-serif, system-ui',
  poppins: '"Poppins", ui-sans-serif, system-ui',
  montserrat: '"Montserrat", ui-sans-serif, system-ui',
  raleway: '"Raleway", ui-sans-serif, system-ui',
  quicksand: '"Quicksand", ui-sans-serif, system-ui',
  nunito: '"Nunito", ui-sans-serif, system-ui',
  inter: '"Inter", ui-sans-serif, system-ui',
  dmsans: '"DM Sans", ui-sans-serif, system-ui',
  manrope: '"Manrope", ui-sans-serif, system-ui',
  outfit: '"Outfit", ui-sans-serif, system-ui',
  jakarta: '"Plus Jakarta Sans", ui-sans-serif, system-ui',
  worksans: '"Work Sans", ui-sans-serif, system-ui',
  rubik: '"Rubik", ui-sans-serif, system-ui',
  lato: '"Lato", ui-sans-serif, system-ui',
  opensans: '"Open Sans", ui-sans-serif, system-ui',
  sora: '"Sora", ui-sans-serif, system-ui',
  figtree: '"Figtree", ui-sans-serif, system-ui',
  archivo: '"Archivo", ui-sans-serif, system-ui',
  elegant: '"Playfair Display", Georgia, serif',
  classic: '"DM Serif Display", Georgia, serif',
  lora: '"Lora", Georgia, serif',
  cormorant: '"Cormorant Garamond", Georgia, serif',
  baskerville: '"Libre Baskerville", Georgia, serif',
  garamond: '"EB Garamond", Georgia, serif',
  fraunces: '"Fraunces", Georgia, serif',
  merriweather: '"Merriweather", Georgia, serif',
  cinzel: '"Cinzel", Georgia, serif',
  prata: '"Prata", Georgia, serif',
  bebas: '"Bebas Neue", Impact, sans-serif',
  oswald: '"Oswald", Impact, sans-serif',
  anton: '"Anton", Impact, sans-serif',
  abril: '"Abril Fatface", Georgia, serif',
  archivoblack: '"Archivo Black", Impact, sans-serif',
  righteous: '"Righteous", ui-sans-serif, sans-serif',
  pacifico: '"Pacifico", cursive',
  dancing: '"Dancing Script", cursive',
  greatvibes: '"Great Vibes", cursive',
  caveat: '"Caveat", cursive',
  satisfy: '"Satisfy", cursive',
};
