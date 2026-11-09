/** O pacote só traz tipos .d.mts (não lidos com a moduleResolution desta API): só a função usada em tailwind.ts. */
declare module 'tailwindcss' {
  export function compile(css: string, opts: {
    base?: string;
    loadStylesheet?: (id: string, base: string) => Promise<{ base: string; content: string }>;
  }): Promise<{ build(candidates: string[]): string }>;
}
