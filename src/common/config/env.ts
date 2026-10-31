/** Valida o ambiente na subida: em produção, configuração insegura derruba o servidor em vez de rodar aberto. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const prod = env.NODE_ENV === 'production';
  const errors: string[] = [];
  const secret = env.JWT_SECRET ?? '';
  if (!secret) errors.push('JWT_SECRET é obrigatório');
  else if (prod && (secret.length < 32 || /^(secret|changeme|password|123)/i.test(secret))) errors.push('JWT_SECRET precisa ter 32+ caracteres aleatórios em produção');
  if (!(env.MONGO_URI ?? env.MONGO_DB)) errors.push('MONGO_URI é obrigatório (replica set, por causa das transações)');
  if (prod) {
    if (!env.CORS_ORIGIN) errors.push('CORS_ORIGIN é obrigatório em produção (ex.: https://app.seudominio.com)');
    if (!env.APP_URL?.startsWith('https://')) errors.push('APP_URL deve ser a URL pública da API em HTTPS (usada no webhook)');
    if (!env.FRONTEND_URL?.startsWith('https://')) errors.push('FRONTEND_URL deve ser a URL do app em HTTPS (retorno do pagamento e e-mails)');
    if (!env.INFINITEPAY_HANDLE) errors.push('INFINITEPAY_HANDLE (InfiniteTag, sem $) é obrigatório');
    if (!env.INFINITEPAY_WEBHOOK_SECRET || env.INFINITEPAY_WEBHOOK_SECRET.length < 24) errors.push('INFINITEPAY_WEBHOOK_SECRET precisa ter 24+ caracteres');
  }
  if (errors.length) throw new Error(`Configuração inválida:\n - ${errors.join('\n - ')}`);
}

export const intEnv = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};
