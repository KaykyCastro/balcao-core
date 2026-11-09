# Segurança da API

## Autenticação (o padrão é fechado)
Toda rota exige sessão (`JwtAuthGuard` global). Só respondem sem login as rotas marcadas `@Public()`, e elas estão
listadas, com o motivo, em `src/common/security/public-routes.ts`. O teste `public-routes.spec.ts` falha se surgir
rota pública fora da lista: rota nova sem login precisa ser revisada e entrar lá de propósito.

Grupos de rotas públicas: entrar/cadastrar/recuperar senha (lojista, colaborador, app, Google); vitrine e marketplace
(só o que a loja publicou); pedido e comanda do cliente (exigem o código do link); conta do comprador (exigem o login
do comprador, cookie `balcao_shopper`); webhooks do Mercado Pago (sempre reconsultados na API do MP); saúde da API;
arquivos locais (só sem R2, fora de produção).

## Limite de tentativas
- Por IP (`@nestjs/throttler`): login 10/min; cadastro 5/h; "esqueci a senha" 3 a cada 15 min; geral 300/min.
- Por conta: dono, colaborador e comprador ficam bloqueados 15 min depois de errar a senha várias vezes.
- Código de 6 dígitos: 5 erros por código e 10 somando os reenvios (`MAX_WRONG_TOTAL`); depois, entrar de novo.
- Atrás de proxy (nginx, Render, Railway, Cloudflare) defina `TRUST_PROXY=1`, senão todos os clientes parecem um IP só.
- O limite fica na memória de cada instância. Com mais de uma instância da API, use um armazenamento compartilhado (Redis).

## Isolamento entre lojas (o "RLS" do MongoDB)
O MongoDB não tem políticas por linha. O equivalente é `src/common/security/tenant-guard.plugin.ts`: em toda coleção
com `enterpriseId`, consulta, alteração, exclusão, contagem e agregação precisam filtrar pela loja (que vem sempre do
token, nunca do corpo). Exceções de propósito (admin, rotinas, webhooks, vitrine, conta do comprador) são declaradas
com motivo: `crossTenant(this.orders, 'motivo').find(...)`.
- `TENANT_GUARD=warn` (padrão): registra no log `IsolamentoLojas` cada consulta sem loja, uma vez por ponto do código.
- `TENANT_GUARD=strict`: recusa a consulta. Recomendado em produção depois de um período em `warn` sem avisos novos.
- `TENANT_GUARD=off`: desliga.
No banco, use um usuário só com `readWrite` no banco da aplicação (sem papel de admin) e rede restrita à API.

## Dados criptografados
- Senhas: bcrypt. Códigos, convites e tokens de recuperação: só o hash. Tokens do Mercado Pago/Melhor Envio: AES-256-GCM.
- Dados pessoais (`src/common/security/field-crypto.ts`, AES-256-GCM com `SECRETS_KEY`):
  comprador (telefone, CPF/CNPJ, endereços), cliente do lojista (telefone, endereço), pedido (telefone, CPF/CNPJ,
  endereço de entrega). Cidade e UF ficam abertas (frete e vitrine), nome e e-mail também (login, busca, cupom).
- Pedido tem índice cego do telefone (`customer.phoneIdx`, HMAC dos 8 últimos dígitos): a busca do painel acha pelo
  número completo; busca por pedaço do telefone não existe mais.
- Dados que já existiam: `npm run encrypt:pii -- --dry` (conta) e `npm run encrypt:pii` (criptografa). Pode repetir.
- `SECRETS_KEY` é obrigatória em produção (`openssl rand -base64 32`). Guarde fora do servidor: sem ela os dados não abrem.
- Disco e backups: use criptografia em repouso (Atlas já faz; em servidor próprio, volume criptografado) e TLS na conexão.
