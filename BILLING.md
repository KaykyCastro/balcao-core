# Cobrança do Balcão (Mercado Pago)

Todo pagamento passa pelo **Mercado Pago**:
- **Taxa de uso do sistema (caixa):** 0,5% por venda, teto mensal (R$ 40 até R$ 20 mil vendidos), 30 dias grátis, fatura no fim do mês com 15 dias para pagar; vencida = conta bloqueada. A fatura abre um Checkout Pro (Pix ou cartão) na conta do Balcão (`MP_ACCESS_TOKEN`).
- **Loja online:** ver `LOJA_ONLINE.md` (conta do lojista via OAuth, comissão do Balcão separada no pagamento).

## Confirmação das faturas
- Webhook: `POST /billing/webhook/mercadopago?i=<fatura>&s=<assinatura HMAC>` (+ `x-signature` se `MP_WEBHOOK_SECRET`).
- Volta do checkout: `/app/pagamento?fatura=<id>&payment_id=...` → `POST /billing/invoices/:id/confirm { paymentId }`.
- Em ambos, o pagamento é consultado em `GET /v1/payments/:id`: só baixa com `status=approved`, `external_reference` = id da fatura e valor ≥ fatura. Idempotente.

## Avisos da fatura (`billing-notice.service.ts`, regras em `reminder.rules.ts`)
A conta é bloqueada no instante em que a fatura vence, então os avisos vêm antes: **saiu**, **faltam 3 dias**, **vence amanhã** e **venceu (bloqueada)**. Rotina às 9h (Fortaleza). Cada aviso sai uma vez por fatura (reservado em `Invoice.reminders` antes de enviar) e registra os canais:
- e-mail (sempre, para o e-mail da conta) e aviso no sino do painel (sempre);
- WhatsApp, se o lojista ativou em Pagamento do ERP (número + aceite, `Enterprise.billingNotify`) e a API estiver configurada.
Com o pagamento automático ativo, só "saiu" (com a data da cobrança) e "venceu" (se o cartão recusar).

**WhatsApp (Cloud API da Meta):** `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_INVOICE` (padrão `balcao_fatura`), `WHATSAPP_TEMPLATE_LANG` (padrão `pt_BR`). Crie e aprove no Meta Business um modelo de categoria "Utilidade" com 4 variáveis no corpo, por exemplo:
> Olá, {{1}}! Aviso do Balcão: {{2}}. Valor: {{3}}. Para pagar: {{4}}

Sem essas variáveis, os avisos seguem por e-mail e no painel (o número do lojista fica guardado).

## Pagamento automático no cartão (`autopay.service.ts`, regras em `autopay.rules.ts`)
Assinatura do Mercado Pago (`/preapproval`, sem plano) na conta do Balcão (`MP_ACCESS_TOKEN`). O lojista digita o cartão **na página do Mercado Pago** (init_point); o Balcão guarda só `Enterprise.autopay { preapprovalId, status, amountCents, nextChargeAt }`, nunca dados do cartão.
- Cobrança sempre no **dia 3** (a fatura sai no dia 1 e vence 15 dias depois). Depois do fechamento diário, `prepareAll` põe no próximo ciclo o total em aberto que ainda não venceu; sem nada a cobrar, a assinatura é pausada.
- Pagamento: webhook `POST /billing/webhook/mercadopago/assinatura` (cadastre no painel do Mercado Pago os tópicos `subscription_preapproval` e `subscription_authorized_payment` com essa URL) e conciliação às 8h e 18h (`/authorized_payments/search`). Sempre reconsulta `/v1/payments/:id`: só `approved`, da assinatura gravada para a empresa; quita as faturas da mais antiga para a mais nova até onde o valor cobre. Idempotente pelo `paymentId`.
- Sem `MP_ACCESS_TOKEN`, `POST /billing/autopay` responde 409 `AUTOPAY_UNAVAILABLE` e a tela mostra que está sendo liberado.
- Endpoints: `POST /billing/autopay` (devolve `{ url }`), `POST /billing/autopay/sync` (volta `?cartao=1`), `DELETE /billing/autopay`, `GET|PUT /billing/notify`.

## Endpoints
`GET /billing/summary` · `GET /billing/invoices` · `POST /billing/invoices` (pagar antes, ao bater o teto) · `POST /billing/invoices/:id/pay` · `POST /billing/invoices/:id/confirm` · `POST /billing/webhook/mercadopago`

## Variáveis
`MP_ACCESS_TOKEN` (obrigatória em produção, começa com `APP_USR-`), `APP_URL` (HTTPS, vira a URL do webhook), `FRONTEND_URL`, `BILLING_GRACE_DAYS`. Para a loja online: `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI`, `MP_WEBHOOK_SECRET` (opcional).

## Migração (se havia faturas da InfinitePay)
Faturas pendentes com link antigo: limpe o link para gerar um novo no Mercado Pago.
```js
db.invoices.updateMany({ status: 'pending' }, { $set: { checkoutUrl: null, checkoutLockedAt: null } });
```
