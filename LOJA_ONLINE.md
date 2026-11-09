# Loja online (vitrine, pedidos, frete e Mercado Pago do lojista)

## Como funciona
- Cada empresa tem uma loja (`/store-config`). Ela só liga com a **conta Mercado Pago do lojista conectada** (OAuth), pelo menos uma forma de entrega e o aceite da taxa.
- **Pagamentos da loja online: Mercado Pago (marketplace/split).** O Checkout Pro é criado NA CONTA DO LOJISTA com `marketplace_fee` = taxa do Balcão. O Mercado Pago separa a comissão sozinho no pagamento: o lojista recebe a venda já sem ela e o Balcão recebe a comissão na conta dona da aplicação.
- **Pagamentos do uso do sistema (caixa): também Mercado Pago**, na conta do Balcão (`MP_ACCESS_TOKEN`), com fatura mensal e teto de R$ 40. Ver `BILLING.md`.
- Taxa online: 1,5% dos produtos (link da loja) ou 3% (cliente veio da página "Lojas no Balcão", marcado no navegador por 7 dias). Frete fora. Teste grátis/isenta = 0. Percentuais no admin (`onlineRateBps`, `directoryRateBps`). Registrada como `FeeEntry { channel: 'online', collected: true }`: não vira dívida, fatura nem teto.
- Checkout: reserva estoque e promoção (transação). Sem pagamento em 60 min, a rotina a cada 5 min devolve a reserva; o Pix gerado vence junto (boleto desativado).
- Confirmação: webhook `POST /public/store-webhook/mercadopago?o=<pedido>&s=<assinatura>` (e `x-signature`, se `MP_WEBHOOK_SECRET`) + consulta `GET /v1/payments/:id` com o token do lojista, conferindo `external_reference`, `collector_id` e valor. O cliente que volta do checkout também confirma (`POST /public/store/:slug/orders/:id/confirm { t, paymentId }`).
- Cancelar pedido pago devolve o dinheiro ao comprador pela API do Mercado Pago (a comissão volta junto). Devolução ou chargeback feitos direto no Mercado Pago chegam pelo webhook e cancelam o pedido.
- Tokens do lojista: cifrados (AES-256-GCM), renovados sozinhos quando faltam menos de 7 dias para vencer.

## Frete
- Retirada na loja, entrega própria por faixas de CEP, frete fixo e Correios/transportadoras via **Melhor Envio** (token do lojista, guardado cifrado com AES-256-GCM).
- O preço do frete é sempre recalculado no servidor no checkout.
- Etiquetas: o lojista gera no painel do Melhor Envio e informa o código de rastreio no pedido.

## Endpoints
Painel (logado): `GET/PUT /store-config` · `GET /store-config/mercadopago/connect` · `POST /store-config/mercadopago/callback` · `POST /store-config/mercadopago/disconnect` · `GET /store-config/slug-available?slug=` · `POST /store-config/products/visibility` · `POST /store-config/shipping/test`
`GET /orders?status=open|all|<status>&search=` · `GET /orders/summary` · `GET /orders/:id` · `POST /orders/:id/status` · `POST /orders/:id/cancel`

Público: `GET /public/stores` · `GET /public/products` · `GET /public/store/:slug` · `GET /public/store/:slug/products[/:id]` · `POST /public/store/:slug/quote` · `POST /public/store/:slug/orders` · `GET /public/store/:slug/orders/:id?t=` · `POST /public/store/:slug/orders/:id/confirm` · `POST /public/store-webhook/mercadopago`

## Configuração
- **Mercado Pago:** crie uma aplicação em https://www.mercadopago.com.br/developers/panel com a conta que vai RECEBER as comissões, ative o modo marketplace/OAuth e cadastre a Redirect URL `https://<seu-front>/app/loja/mercadopago`. Preencha `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI` (e opcionalmente `MP_WEBHOOK_SECRET`).
- `APP_URL` (HTTPS, vira a URL do webhook) e `FRONTEND_URL` (retorno do pagamento) já existentes.
- `SECRETS_KEY` (novo, recomendado): `openssl rand -base64 32`.
- Coleções novas: `stores`, `orders`. Rode uma vez com `MONGO_AUTO_INDEX=true` para criar os índices (slug único, número do pedido por loja).
- Front: o CSP passou a liberar `https://viacep.com.br` e `https://brasilapi.com.br` (busca de endereço pelo CEP).

## Conta do comprador (login do cliente)

Uma conta só, válida em **todas as lojas** do Balcão (`/public/shopper/*`, cookie httpOnly `balcao_shopper`, separado do cookie do lojista e assinado com um segredo derivado do `JWT_SECRET`).

- **Cadastro/login:** `POST register | login | logout | logout-all`, `GET/PATCH me` (nome, telefone, CPF/CNPJ, até 5 endereços), `POST password`, `POST forgot | reset`, `POST verify | verify/resend`. Senha com bcrypt; 5 erros bloqueiam por 15 min; trocar/redefinir senha derruba as outras sessões (`tokenVersion`).
- **Vira cliente da loja:** ao comprar logado, a API cria (ou reaproveita) o cadastro em "Clientes" daquela empresa (`Customer.shopperId`, `origin: 'online'`). Pedido e venda ficam com `customerId`.
- **Pedidos antigos:** ao confirmar o e-mail, pedidos feitos como visitante com aquele e-mail entram na conta.
- **Fiado:** o lojista vincula um cliente já existente em *Clientes → Vincular conta online* (`POST /customer/:id/link-shopper`). Só contas com **e-mail confirmado**: ninguém vê dívida de outra pessoa criando conta com o e-mail dela. Se já havia um cadastro automático (sem fiado), ele é absorvido.
- **Minha conta:** `GET orders` (todas as lojas ou `?store=slug`), `GET orders/:id`, `GET stores` (lojas onde é cliente + saldo devedor), `GET stores/:customerId` (compras no balcão e online, pagamentos do fiado).
- **Front:** `/loja/:slug/entrar`, `/loja/:slug/conta` (com a cara da loja) e `/conta`, `/conta/entrar`, `/conta/verificar/:token`, `/conta/redefinir/:token` (com a cara do Balcão).
