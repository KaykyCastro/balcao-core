# Subir o Balcão numa VPS

Um servidor Ubuntu 22.04/24.04 com 2 GB de RAM ou mais roda a API, o MongoDB e o site. O app do celular é publicado
pela EAS (Expo), não roda na VPS.

## 1. Domínio (DNS)
Crie registros **A** apontando para o IP da VPS:
- `seudominio.com.br` (site) e `api.seudominio.com.br` (API).
- `arquivos.seudominio.com.br` é configurado dentro da Cloudflare (domínio público do bucket R2), não aponta para a VPS.

## 2. Servidor
```bash
sudo apt update && sudo apt install -y git curl ufw
curl -fsSL https://get.docker.com | sudo sh                       # Docker (para o MongoDB)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs   # Node 22
sudo npm i -g pm2                                                 # mantém a API rodando e reinicia sozinha
sudo apt install -y caddy                                         # HTTPS automático (Let's Encrypt)
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable   # só SSH e web abertos
```

## 3. Banco (MongoDB)
```bash
git clone <repo do balcao-core> && cd balcao-core
cp .env.example .env && nano .env              # preencha (onde pegar cada valor está no próprio arquivo)
openssl rand -base64 756 > mongo-keyfile && chmod 400 mongo-keyfile && sudo chown 999:999 mongo-keyfile
docker compose -f docker-compose.prod.yml up -d
# Inicia o replica set (uma vez só):
docker compose -f docker-compose.prod.yml exec mongo mongosh -u "$(grep ^MONGO_ROOT_USER .env | cut -d= -f2)" \
  -p "$(grep ^MONGO_ROOT_PASSWORD .env | cut -d= -f2)" --authenticationDatabase admin \
  --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] })'
```
Prefere não cuidar do banco? Use o MongoDB Atlas (já é replica set, com backup) e ponha a string dele em `MONGO_URI`.

## 4. API
```bash
npm ci && npm run build
pm2 start dist/main.js --name balcao-api && pm2 save && pm2 startup   # siga o comando que o pm2 mostrar
pm2 logs balcao-api                                                    # deve aparecer "API na porta 2700"
```
- A API recusa subir em produção se faltar algo obrigatório e diz o quê.
- Primeira subida com `MONGO_AUTO_INDEX=true` (cria os índices). Depois, troque para `false` e `pm2 restart balcao-api`.
- Vindo de uma base antiga com dados pessoais em claro: `npm run encrypt:pii -- --dry`, depois `npm run encrypt:pii`.
- Atualizar depois: `git pull && npm ci && npm run build && pm2 restart balcao-api`.

## 5. Site (balcao-web)
```bash
git clone <repo do balcao-web> && cd balcao-web
cp .env.example .env && nano .env
npm ci && npm run build            # gera dist/ (só arquivos estáticos)
sudo mkdir -p /var/www/balcao && sudo cp -r dist/* /var/www/balcao/
```

## 6. HTTPS e proxy (Caddy)
`/etc/caddy/Caddyfile`:
```
api.seudominio.com.br {
  reverse_proxy 127.0.0.1:2700
}
seudominio.com.br {
  encode gzip
  # Link mágico: quem monta a prévia do link (WhatsApp, Instagram/Facebook, X, LinkedIn, Telegram…) recebe a página
  # com foto, nome e preço do produto (ou os dados da loja). Clientes e o Google recebem o site normal.
  @previa {
    path /loja/*
    header_regexp User-Agent (?i)(facebookexternalhit|facebot|whatsapp|twitterbot|linkedinbot|slackbot|telegrambot|discordbot|pinterest|skypeuripreview|redditbot|embedly|iframely|vkshare|snapchat|bitlybot|tumblr|mastodon|applebot)
  }
  handle @previa {
    rewrite * /public/share?path={path}
    reverse_proxy 127.0.0.1:2700
  }
  handle {
    root * /var/www/balcao
    try_files {path} /index.html
    file_server
  }
}
```
O site fica dentro de `handle { }` de propósito: solto, o `try_files` troca o caminho por `/index.html` antes do teste do link mágico.
`sudo systemctl reload caddy`. O Caddy emite e renova o certificado sozinho. Com o Caddy na frente, use `TRUST_PROXY=1`.

### Domínio próprio das lojas (minhaloja.com.br)
O lojista liga em **Loja online → Sua loja → Domínio próprio**. O Caddy emite o HTTPS de cada domínio na primeira visita,
mas só se a API disser que o domínio é de uma loja ativa (`/public/domains/allow`). No **começo** do `/etc/caddy/Caddyfile`:
```
{
  on_demand_tls {
    ask http://127.0.0.1:2700/public/domains/allow
  }
}
```
E, **depois** dos blocos acima, um bloco para "qualquer outro domínio" (as lojas):
```
https:// {
  tls {
    on_demand
  }
  handle_path /api/* {
    reverse_proxy 127.0.0.1:2700
  }
  @previa {
    header_regexp User-Agent (?i)(facebookexternalhit|facebot|whatsapp|twitterbot|linkedinbot|slackbot|telegrambot|discordbot|pinterest|skypeuripreview|redditbot|embedly|iframely|vkshare|snapchat|bitlybot|tumblr|mastodon|applebot)
  }
  handle @previa {
    rewrite * /public/share?host={host}&path={path}
    reverse_proxy 127.0.0.1:2700
  }
  handle {
    root * /var/www/balcao
    encode gzip
    try_files {path} /index.html
    file_server
  }
}
```
- `root` é a mesma pasta do site (o `dist` do balcao-web). O site percebe que está num domínio de loja e mostra só ela.
- `/api` no domínio da loja vai para a API (o cookie do comprador fica no domínio da loja; o CSRF aceita a mesma origem).
- No `.env` da API: `DOMAIN_TARGET_IPS=<IP público da VPS>` (o registro A que o lojista cria) e, opcional,
  `DOMAIN_TARGET_HOST=lojas.seudominio.com.br` (crie esse nome no seu DNS apontando para a VPS; vira o CNAME do www).
- No `.env` do site, `VITE_SITE_URL` precisa estar preenchido: é como o site sabe qual é o endereço da plataforma.
- Para conferir o link mágico: `curl -A WhatsApp/2 https://seudominio.com.br/loja/<slug>/p/<id>` deve trazer `og:title` com o nome e o preço.
- Depois de mudar o Caddyfile: `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.


## 7. Serviços externos (depois que os domínios responderem em HTTPS)
- **Mercado Pago:** na aplicação, Redirect URL `https://seudominio.com.br/app/loja/mercadopago` e Webhook
  `https://api.seudominio.com.br/billing/webhook/mercadopago/assinatura` (eventos de assinaturas).
- **Google:** URI de redirecionamento `https://api.seudominio.com.br/auth/google/callback`.
- **Cloudflare R2:** CORS do bucket liberando PUT e GET de `https://seudominio.com.br`.
- **E-mail:** SPF e DKIM do domínio no DNS (o provedor mostra os registros).

## 8. Backup do banco (todo dia)
```bash
sudo mkdir -p /var/backups/balcao
( crontab -l; echo '0 3 * * * docker compose -f /caminho/balcao-core/docker-compose.prod.yml exec -T mongo mongodump --archive --gzip -u USUARIO -p SENHA --authenticationDatabase admin > /var/backups/balcao/$(date +\%F).gz && find /var/backups/balcao -mtime +14 -delete' ) | crontab -
```
Copie os backups para fora da VPS (ex.: um bucket R2 privado). Backup sem a `SECRETS_KEY` não abre os dados criptografados:
guarde a chave junto, em lugar seguro.

## 9. Dados legais (antes de abrir para o público)
Em `balcao-web/src/config/terms.ts`, preencha `PROVIDER`: nome ou razão social, CPF/CNPJ, endereço, foro e o
encarregado de dados (`dpoName`, `dpoEmail`). Eles aparecem nos Termos, na Política de Privacidade e no Acordo de
Tratamento de Dados. Ponha o mesmo e-mail em `PRIVACY_EMAIL` no `.env` da API. Peça a um advogado para revisar os textos.

## 10. Conferir
- `https://api.seudominio.com.br/health` responde.
- Criar conta, receber o código por e-mail, entrar.
- Ligar a loja online com o Mercado Pago de teste; fazer um pedido.
- `pm2 logs balcao-api`: sem erros; avisos `IsolamentoLojas` mostram consultas a revisar antes do `TENANT_GUARD=strict`.
