import { r2EnvErrors } from '../../storage/storage.rules';

/** Valida o ambiente na subida: em produção, configuração insegura derruba o servidor em vez de rodar aberto. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const prod = env.NODE_ENV === 'production';
  const errors: string[] = [];
  const secret = env.JWT_SECRET ?? '';
  if (!secret) errors.push('JWT_SECRET é obrigatório');
  else if (prod && (secret.length < 32 || /^(secret|changeme|password|123)/i.test(secret))) errors.push('JWT_SECRET precisa ter 32+ caracteres aleatórios em produção');
  if (!(env.MONGO_URI ?? env.MONGO_DB)) errors.push('MONGO_URI é obrigatório (replica set, por causa das transações)');
  if (env.TENANT_GUARD && !['off', 'warn', 'strict'].includes(env.TENANT_GUARD)) errors.push('TENANT_GUARD deve ser off, warn ou strict');
  // Login com Google: opcional, mas as duas chaves andam juntas (sem elas o botão do Google não aparece).
  if (!!env.GOOGLE_CLIENT_ID !== !!env.GOOGLE_CLIENT_SECRET) errors.push('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET precisam ser definidos juntos');
  if (env.APP_GOOGLE_RETURN_URL && !/^(balcao|exp):\/\/[^\s]+$/.test(env.APP_GOOGLE_RETURN_URL)) errors.push('APP_GOOGLE_RETURN_URL deve ser balcao://... ou, em desenvolvimento, exp://...');
  if (env.GOOGLE_CLIENT_ID && !/\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID)) errors.push('GOOGLE_CLIENT_ID deve terminar em .apps.googleusercontent.com');
  // Fotos e vídeos: Cloudflare R2 (fora de produção, sem as variáveis, os arquivos ficam numa pasta local).
  errors.push(...r2EnvErrors(env, prod));
  if (prod) {
    // Verificação em duas etapas: sem e-mail configurado ninguém consegue entrar.
    if (!env.SMTP_URL) errors.push('SMTP_URL é obrigatório em produção (o código da verificação em duas etapas vai por e-mail)');
    if (env.GOOGLE_REDIRECT_URI && !env.GOOGLE_REDIRECT_URI.startsWith('https://')) errors.push('GOOGLE_REDIRECT_URI deve usar HTTPS em produção');
    if (!env.CORS_ORIGIN) errors.push('CORS_ORIGIN é obrigatório em produção (ex.: https://app.seudominio.com)');
    // Chave dos dados criptografados (telefone, CPF, endereço, tokens do Mercado Pago). Sem ela, a chave sai do
    // JWT_SECRET, e trocar o JWT_SECRET deixaria esses dados ilegíveis para sempre.
    if (!env.SECRETS_KEY || Buffer.from(env.SECRETS_KEY, 'base64').length !== 32) errors.push('SECRETS_KEY é obrigatória em produção: 32 bytes em base64 (gere com: openssl rand -base64 32). Guarde em lugar seguro: sem ela os dados criptografados não abrem.');
    if (!env.APP_URL?.startsWith('https://')) errors.push('APP_URL deve ser a URL pública da API em HTTPS (usada no webhook)');
    if (!env.FRONTEND_URL?.startsWith('https://')) errors.push('FRONTEND_URL deve ser a URL do app em HTTPS (retorno do pagamento e e-mails)');
    if (!env.MP_ACCESS_TOKEN?.startsWith('APP_USR-')) errors.push('MP_ACCESS_TOKEN (access token de produção do Mercado Pago, começa com APP_USR-) é obrigatório');
  }
  if (errors.length) throw new Error(`Configuração inválida:\n - ${errors.join('\n - ')}`);
}

export const intEnv = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};
