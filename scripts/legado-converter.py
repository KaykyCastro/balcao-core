#!/usr/bin/env python3
"""
Converte o backup SQLite do sistema antigo (tabelas Categoria, Produto, Usuario, Venda, ItemVenda, Pagamento) para o
formato que o `import-legado.js` grava no Balcão. Só lê o backup (modo somente leitura) e não fala com rede nenhuma.

Uso:  python3 -I scripts/legado-converter.py <backup.db> <pasta-de-saida>
Saída: dados.json (para importar), relatorio.md (o que foi corrigido) e nao-migrado.csv (CPF e observações dos
clientes, que o Balcão não tem onde guardar; fica com a loja).

Regras:
- Dinheiro vira centavos inteiros (arredonda o resíduo de ponto flutuante: 273,7000000000002 → 27370).
- Desconto "valor" = quanto sai do preço (nunca passa do preço no backup); "percentual" = % do preço.
- Estoque negativo vira 0. Telefone fica só com os números (10 ou 11 dígitos; com 55 na frente, tira o 55).
- Dívida do fiado: vale a do cadastro do cliente (o saldo que a loja via), não a soma das vendas.
"""
import csv, json, re, sqlite3, sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(f'file:{src}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
rows = lambda q: db.execute(q).fetchall()
cents = lambda v: max(0, int(round(float(v or 0) * 100)))
digits = lambda s: re.sub(r'\D', '', s or '')
clean = lambda s: re.sub(r'\s+', ' ', (s or '').strip())
problems = defaultdict(list)

def iso(s):
    d = datetime.fromisoformat(s.replace('Z', '+00:00'))
    return d.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

# Categorias
cats = [{'ref': r['id'], 'nome': clean(r['nome'])[:60]} for r in rows('select * from Categoria order by id')]

# Produtos
prods = []
for r in rows('select * from Produto order by id'):
    preco = cents(r['preco'])
    promo, pct = None, 0.0
    if r['tipoDesconto'] == 'valor' and r['desconto']:
        off = cents(r['desconto'])
        if 0 < off < preco: promo = preco - off; pct = round(off * 100 / preco, 2)
        else: problems['desconto inválido (ignorado)'].append(f"{r['nome']} (código {r['code']})")
    elif r['tipoDesconto'] == 'percentual' and r['desconto']:
        pct = float(r['desconto'])
        if 0 < pct < 100: promo = int(round(preco * (1 - pct / 100)))
        else: pct = 0.0; problems['desconto inválido (ignorado)'].append(f"{r['nome']} (código {r['code']})")
    est = int(r['estoque'] or 0)
    if est < 0: problems['estoque negativo → 0'].append(f"{r['nome']} (código {r['code']}): {est}"); est = 0
    prods.append({'ref': r['id'], 'nome': clean(r['nome'])[:120], 'codigo': clean(r['code']), 'categoriaRef': r['categoriaId'],
                  'precoCentavos': preco, 'precoPromoCentavos': promo, 'descontoPct': pct, 'estoque': est})
dup = [n for n, c in Counter(p['nome'].lower() for p in prods).items() if c > 1]
if dup: problems['nomes de produto repetidos (códigos diferentes, importados assim mesmo)'].append(f'{len(dup)} nomes')

# Clientes
clientes, nao_migrado = [], []
for r in rows('select * from Usuario order by id'):
    tel = digits(r['telefone'])
    if len(tel) == 13 and tel.startswith('55'): tel = tel[2:]
    if tel and len(tel) not in (10, 11):
        problems['telefone sem DDD ou incompleto (importado como estava, conferir)'].append(f"{clean(r['nome'])}: {len(tel)} dígitos")
    div = cents(r['divida'])
    clientes.append({'ref': r['id'], 'nome': clean(r['nome'])[:120], 'telefone': tel[:20], 'endereco': clean(r['endereco'])[:300], 'dividaCentavos': div})
    if (r['cpf'] or '').strip() or (r['observacao'] or '').strip():
        nao_migrado.append({'cliente': clean(r['nome']), 'cpf': clean(r['cpf']), 'observacao': clean(r['observacao'])})

# Vendas
itens = defaultdict(list)
for r in rows('select * from ItemVenda order by id'): itens[r['vendaId']].append(r)
METODO = {'PIX': ('pix', None), 'DINHEIRO': ('cash', None), 'CARTAO_CREDITO': ('card', 'credito'), 'CARTAO_DEBITO': ('card', 'debito'), 'FIADO': ('fiado', None)}
vendas = []
for r in rows('select * from Venda order by id'):
    met, cartao = METODO.get(r['metodo'], ('other', None))
    if r['metodo'] not in METODO: problems['forma de pagamento desconhecida → "outro"'].append(f"venda {r['id']}: {r['metodo']}")
    its = [{'produtoRef': i['produtoId'], 'quantidade': int(i['quantidade']), 'precoUnitCentavos': cents(i['preco'])} for i in itens[r['id']]]
    total = cents(r['total']); soma = sum(i['quantidade'] * i['precoUnitCentavos'] for i in its)
    if not its: problems['vendas sem itens (importadas só com o total)'].append(f"venda {r['id']}")
    elif soma != total and abs(soma - total) > 5: problems['total diferente da soma dos itens (vale o total)'].append(f"venda {r['id']}: itens {soma/100:.2f} × total {total/100:.2f}")
    if met == 'fiado' and not r['usuarioId']: problems['vendas no fiado sem cliente (ficam sem cliente)'].append(f"venda {r['id']}")
    vendas.append({'ref': r['id'], 'data': iso(r['data']), 'metodo': met, 'cartao': cartao, 'clienteRef': r['usuarioId'], 'totalCentavos': total, 'itens': its})

# Pagamentos do fiado
pags = [{'ref': r['id'], 'clienteRef': r['usuarioId'], 'valorCentavos': cents(r['valor']), 'data': iso(r['data'])} for r in rows('select * from Pagamento order by data')]
pags = [p for p in pags if p['valorCentavos'] > 0]

# Conferência do fiado: vendas no fiado − pagamentos × dívida do cadastro
fi = defaultdict(int)
for v in vendas:
    if v['metodo'] == 'fiado' and v['clienteRef']: fi[v['clienteRef']] += v['totalCentavos']
for p in pags: fi[p['clienteRef']] -= p['valorCentavos']
dif = [c for c in clientes if abs(fi.get(c['ref'], 0) - c['dividaCentavos']) > 1]

dados = {'versao': 1, 'fonte': {'arquivo': src.name, 'convertidoEm': datetime.now(timezone.utc).isoformat()},
         'categorias': cats, 'produtos': prods, 'clientes': clientes, 'vendas': vendas, 'pagamentos': pags}
(out / 'dados.json').write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding='utf-8')
with open(out / 'nao-migrado.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.DictWriter(f, fieldnames=['cliente', 'cpf', 'observacao']); w.writeheader(); w.writerows(nao_migrado)

brl = lambda c: f"R$ {c/100:,.2f}".replace(',', 'X').replace('.', ',').replace('X', '.')
fat = sum(v['totalCentavos'] for v in vendas)
lines = [f"# Migração: {src.name}", '', '## Totais', '',
         f"- Categorias: {len(cats)}", f"- Produtos: {len(prods)} ({sum(1 for p in prods if p['precoPromoCentavos'])} com preço promocional)",
         f"- Clientes: {len(clientes)} ({sum(1 for c in clientes if c['dividaCentavos'])} com fiado em aberto, total {brl(sum(c['dividaCentavos'] for c in clientes))})",
         f"- Vendas: {len(vendas)} ({vendas[0]['data'][:10]} a {vendas[-1]['data'][:10]}), faturamento {brl(fat)}",
         f"- Pagamentos de fiado: {len(pags)} ({brl(sum(p['valorCentavos'] for p in pags))})", '',
         '## Conferência do fiado', '',
         f"A dívida importada é a do cadastro de cada cliente. Em {len(dif)} cliente(s) ela não bate com (vendas no fiado − pagamentos) do histórico, "
         "o que é esperado quando havia dívida antes do início do histórico ou ajustes manuais. Confira com a loja se quiser.", '',
         '## Correções e avisos', '']
for k, v in problems.items():
    lines.append(f"- **{k}**: {len(v)}")
    lines += [f"  - {x}" for x in v[:15]] + ([f"  - … e mais {len(v) - 15}"] if len(v) > 15 else [])
lines += ['', '## Não migrado', '', f"- CPF e observação de {len(nao_migrado)} cliente(s): o cadastro de cliente do Balcão não tem esses campos. Estão em `nao-migrado.csv` para a loja guardar.",
          '- Usuários/senhas do sistema antigo: não existem no backup e não são migrados.']
(out / 'relatorio.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('\n'.join(lines[:12]))
