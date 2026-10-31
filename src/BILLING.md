# Cobrança do ERP (0,5% por venda, teto R$ 40, Mercado Pago)

## Regras implementadas
- Cada venda (`POST /sale`) cobra 0,5% (arredondado em centavos, meio-centavo p/ cima), somado a `Enterprise.debtCents` **na mesma transação** da venda/baixa de estoque.
- Teto R$ 40,00: a venda que cruza o teto passa, cobrando só o que falta; com a dívida em R$ 40 novas vendas retornam **402 `DEBT_CAP_REACHED`**. Cadastros continuam livres.
- Fechamento: todo dia 00:05 (America/Fortaleza) as taxas de meses anteriores viram uma `Invoice` com vencimento = hoje + `BILLING_GRACE_DAYS` (padrão 5). Fatura pendente vencida => conta **bloqueada** (402 `BILLING_BLOCKED` em tudo, exceto `/auth/*` e `/billing/*`).
- Empresa sem vendas não gera taxa nem fatura: usa de graça.
- Pagar antes: `POST /billing/invoices` fecha a taxa em aberto numa fatura na hora.
- Cancelar venda (`POST /sale/:id/cancel`) repõe estoque, abate fiado e estorna a taxa **se ainda não faturada**.

## Endpoints novos
`GET /billing/summary` · `GET /billing/invoices` · `POST /billing/invoices` · `POST /billing/invoices/:id/pay` (Pix) · `POST /billing/webhook/mercadopago` (público)
`POST /sale` · `GET /sale` · `GET /sale/:id` · `POST /sale/:id/cancel` · `POST /customer/:id/payments` (recebimento de fiado) · listagens `GET /product|customer|category`

## Variáveis de ambiente
```
MONGO_URI=mongodb://localhost:27017/erp?replicaSet=rs0   # precisa ser REPLICA SET (transações)
JWT_SECRET=...
MP_ACCESS_TOKEN=...        # conta Mercado Pago DO ERP
MP_WEBHOOK_SECRET=...      # "assinatura secreta" do webhook, no painel do MP
APP_URL=https://api.seudominio.com   # pública/HTTPS; vira notification_url
BILLING_GRACE_DAYS=5
CORS_ORIGIN=https://app.seudominio.com
```
No painel do MP, cadastre `APP_URL/billing/webhook/mercadopago` com o evento **Pagamentos**.

## Dependência nova
`npm i @nestjs/schedule`  (Node 18+ por causa do `fetch`)

## Migração de dados já existentes (mongosh)
Os nomes das coleções não mudaram. Apenas:
```js
db.customerschemas.updateMany({ debitCents: { $exists: false } },
  [{ $set: { debitCents: { $round: [{ $multiply: [{ $ifNull: ['$debitValue', 0] }, 100] }, 0] } } }]);
db.enterpriseschemas.updateMany({ debtCents: { $exists: false } }, { $set: { debtCents: 0, billing: { status: 'active' } } });
// índices únicos novos (código de produto e nome de categoria por empresa): resolva duplicados antes
```
`debit` e `debit-item` foram substituídos por `sale` (itens embutidos, valores em centavos).
