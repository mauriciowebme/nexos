# Testes do nexos — lacunas preenchidas pela skill canônica `suite-de-testes`

> **Última atualização:** 2026-11-06 · **Dono:** Mauricio

Este arquivo é o que a canônica exige em cada repo (`docs/testes.md`): **qual modo, qual alvo,
onde entra o escopo de isolamento, papéis reais, onde a versão aparece na prova de release e qual
bloco é destrutivo**. O método (regras, esqueleto, buracos clássicos) não se repete aqui — está em
`skill_view("suite-de-testes")` e nos anexos `references/contrato.md` / `references/visual.md`.

## 1. Modo e alvo

| Item | Resposta |
|---|---|
| Modo (canônica §"Portas de alvo") | **Instância descartável** — sempre. `docker-compose.test.yml` com projeto, rede e volume próprios; banco zerado a cada rodada. |
| Subida limpa | `scripts/up-test.sh` (derruba → apaga volume → **reconstrói a imagem** → sobe → gera chaves → espera `/health` → escreve o env da rodada). |
| Arquivo de chaves/ambiente da rodada | `/opt/data/cache/scratch/nexos_test_keys.env` (o script regrava; o scratch expira em 24 h, por isso o script é o caminho, não o arquivo). |
| Porta local | `${MINIRAG_TEST_PORT:-8001}`; aqui usamos **8002** com bind **restrito** (`127.0.0.1` + gateway `172.28.0.1`) porque a suíte roda dentro de outro container e fala com a API pelo **gateway da rede do compose**. Desde 19/11 a sub-rede é **fixa no compose** (`networks.default.ipam`: `172.28.0.0/24`, gw `172.28.0.1`) — o bind precisa existir antes da subida, e o script continua lendo a gateway do docker (defensivo). **Nunca `0.0.0.0`**: assim publicado, um navegador em nuvem leu o `/health` dos testes pela internet (T059). O comando `ip` **não existe** no container do Hermes: nada no script pode depender dele (com `pipefail`, uma atribuição que falha derruba tudo em silêncio). |
| Banco espelho de produção | **Nunca** alvo da suíte (regra 1). Serve só para conferência manual pontual. |
| Produção | Jamais alvo. A suíte cria usuário, apaga documento e provoca o freio de força bruta de propósito. |

**Banco sujo derruba bloco bom** (medido 19/11): o bloco `v1.8` compara listas por `doc_id` e cai em
duas checagens (`operador lista docs de 'teste'`, `docX INTEIRO continua ativo`) quando o volume já
tem resíduo de rodada anterior — inclusive de uma suíte **cortada no meio** (a chamada de shell corta
em 420 s e `npm test` inteiro custa ~5 min). No mesmo código, com volume limpo, `v1.8` fica verde
(38 asserts em 48 s). Regra prática: **recriar com volume novo antes da bateria**, e depois de um run
cortado não confiar no seguinte sem recriar. Como a bateria não cabe numa chamada, ela roda em **três
etapas sobre o MESMO banco limpo** (`SO_BLOCOS` em lotas de 14 blocos; `v1.8` sempre no primeiro lote),
e cada etapa nomeia nominalmente os blocos pulados — verde parcial disfarçado é o pior defeito (regra 8).

## 2. Porta do juiz

HTTP real pela porta pública do serviço (Fastify) — nenhum módulo interno importado. Duas exceções
declaradas, as duas contra o ambiente de teste:

- `exec` no container do banco (`DBCONTAINER`) para conferir **estado de coluna/índice** que a rota não devolve (ex.: `silencio_s` depois do `ALTER`, hash de chave, linha de usuário renomeada).
- provedores **falsos** rodando dentro do container da API (`127.0.0.1:991x`), um por comportamento: não-stream, stream, eco, gotejamento, travamento. Mock só do **externo** — banco e filesystem do projeto nunca são mockados.

## 3. Escopo de isolamento (o que a suíte cria pela porta pública)

- **Usuário/tenant novo**: `POST /usuarios` feito pelo operador no primeiro bloco; os asserts falam só do que essa unidade criou.
- **Gavetas por bloco**: nome com prefixo da mudança (`suite-v32`, `diag-*`), nunca as gavetas de outra pessoa; nada de assert em agregado global (contagem muda).
- **Configuração do provider**: cada bloco que mexe em `/config/provider` salva o estado anterior e devolve na limpeza — inclusive o `v3.2`, que volta `silencio_s` para 0 e desliga o falso.

## 4. Papéis reais e o que cada um pode

| Papel | Nome na semente | Pode | Não pode |
|---|---|---|---|
| operador | `op` (nome da semente `MINIRAG_ADMIN`; o bloco v3.1 exercita a renomeação no SQL) | `POST /usuarios`, `PUT /config/provider` global, ver o escopo dos outros, painel | — |
| usuário | **`teste`** (semente `MINIRAG_USERS`) | `POST /chat`, `/gavetas`, documentos do **próprio** escopo, `PUT /config/provider` na própria linha | gerir usuário, mexer na linha global |
| sem chave | — | `/health` (desde a 3.76 devolve só `{"status":"ok"}`), `/painel/` (HTML) | tudo o resto → **401** (`/sistema` entrou aqui na 3.76); papel errado → **403** |

**O nome da semente não é intercambiável**: os blocos v1.8, MCP e v2.7 comparam `tenant === "teste"`
(uns 10 asserts). Medido 21/10: subir o ambiente com `usuario:<chave>` no lugar de `teste:<chave>`
faz três blocos inteiros caírem com cara de defeito de produto. O `up-test.sh` já semeia `teste:`.

Chave entra **só no header `Authorization`**. `?chave=` na query é ignorado pelo servidor — sonda
avulsa com query devolve 401 e não é regressão.

## 5. Prova de release (onde a versão aparece)

Primeiro bloco (`v1.8: documents, escopos e decay por documento`): `GET /sistema` (com chave) tem que
responder `versao == $VERSAO`, e a suíte **recusa** rodar sem `TESTKEY`/`OPKEY`. `$VERSAO` é lido de
`src/config.ts` pelo `up-test.sh` (ou passado por `PROVA_VS=`). É isso que impede verde contra
container velho. Na tela, a mesma versão aparece no rodapé do painel e no campo `versao` de `/sistema`.

**3.76 (T059 b):** a prova de versão saiu do `/health` porque o `/health` público deixou de anunciar
qualquer detalhe do servidor — a vitrine entrega só `{"status":"ok"}`; versão, contagem de contas e
estado dos motores passaram a `GET /sistema`, que exige chave. O bloco v1.8 prova os dois lados (o
`/health` **não** pode ter `versao`/`usuarios`/`operador`/`embedder`; `/sistema` sem chave cai em 401).
A ferramenta `health` (MCP, chat e `nexos.health()` do sandbox) continua com o payload cheio — é por
ela que se lê a versão no ar em produção, não mais pelo `/health`.

## 6. Bloco destrutivo (a ordem é essa)

| Bloco | Por que é destrutivo | Quando roda |
|---|---|---|
| `freio de força bruta (último: bloqueia o IP)` | 10 chaves erradas bloqueiam o IP por 300 s em memória; depois dele **nenhuma** rota autenticada responde para este IP | último, **só na rodada completa local**. Fora do portão de CI/push. Reset: `docker restart <api>` (o contador é memória; `sleep` não resolve) |

Ordem fixa: primeiro a prova de versão, por último o freio (regra 4).

## 7. Rodar

```bash
scripts/up-test.sh                       # sobe limpo e imprime a linha de export
set -a; . /opt/data/cache/scratch/nexos_test_keys.env; set +a

SO_BLOCOS="v3.2" npm test                # blocos afetados — antes de pedir OK do deploy (~1min)
npm test                                 # SUÍTE COMPLETA — uma vez antes do push (~6min)

# CI/portão de push: conjunto rápido e NÃO destrutivo
SO_BLOCOS="v3.0,v3.1,v3.2" npm test
```

**`CONTAINER` é obrigatória no ambiente.** Sem ela os blocos que sobem provedor falso dentro do
container entram no atalho "precisa do container", marcam 1 check e **passam em milissegundos**:
verde sem nada rodado. Julgue a corrida pela duração de cada bloco (segundos) e pela tabela de
cobertura impressa no fim — não pelo ✓.

## 8. Coberto × não coberto

A suíte **imprime isso sozinha no fim de cada rodada** (nomes dos blocos pulados pelo filtro inclusos).

| # | Não coberto | Por quê | Como fechar quando importar |
|---|---|---|---|
| 1 | **Tela real** (clique, render, ordem dos botões, fila do chat) | camada de contrato não abre navegador | camada visual (`references/visual.md` + canônica `e2e-cdp-browser-harness`), **rodada quando o dono pedir** — foi assim na v3.1 (rolagem medida no browser) |
| 2 | **Provedor de IA real** (LiteLLM/llama.cpp, visão de verdade) e **SSE atrás do Caddy** | credencial/custo/ambiente | checagem opcional marcada `lento` + smoke no domínio depois do deploy |
| 3 | **Pertinência do resultado** (o trecho certo no topo, resposta certa) | contrato prova presença, não correção | conjunto pequeno de avaliação com esperado na 1ª posição |
| 4 | **Matriz rota × papel completa** | só as rotas críticas são varridas hoje | gerar a lista de rotas do Fastify e conferir 401/403 em todas |
| 5 | **Degradação** (disco cheio, banco cai no meio do job, payload gigante) | exige ambiente que quebra de propósito | 2–3 testes de queda dos críticos (embedder fora já tem) |
| 6 | **Carga / concorrência / latência por etapa** | outra ferramenta | só com múltiplos clientes reais simultâneos |
| 7 | **Infra** (build em host limpo sem cache, backup/restore, migração entre versões) | fora do processo da app | checklist de publicação + teste pontual de restore |
| 8 | **Segurança de cadeia** (dependências, CSP/CORS, rotação de credencial) | não é teste funcional | scan agendado separado |

**Também não coberto por decisão**: o *resultado* de uma ferramenta de escrita repetida na mesma
rodada (o modelo chamar `criar_usuario` duas vezes) — hoje a suíte prova que a chamada acontece e
que o segredo some da tela, não que a escrita é idempotente.

## 9. Estado da suíte hoje

42 blocos nomeados (o runner reporta `tests 43` porque conta o teste-raiz da suíte junto), **693 checagens**
(somadas na saída real das rodadas de 18/11/2026 — v3.75.0 — **+5** da rodada de 19/11/2026, v3.76.0: o bloco
`v1.8` foi de 33 a 38 checagens com as travas do T059 b). A corrida inteira custa ~9 min
de runner e **estoura o teto de 420 s de uma chamada de terminal**: o que fecha o portão são as **três partes**
por `SO_BLOCOS`, cada uma precedida de `scripts/up-test.sh` (com a imagem já no cache, a subida custa ~50 s):

| Parte | `SO_BLOCOS` (trechos exatos) | Rodada medida |
|---|---|---|
| A1 | `v1.8:,MCP: JSON-RPC,v3.36:,v3.37:,v1.10:,arquivos: upload,imagem: OCR,v2.7:,v2.8:,v2.9:` | 10 blocos = 11 testes / 255 checagens em 200 s |
| A2 | `v3.0:,v3.1:,v3.2:,v3.3:,v3.4:,v3.5:,v3.6:,v3.7:,v3.9:,v3.13.1:,v3.15:` | 11 blocos = 12 testes / 179 checagens em 181 s |
| B | `v3.8:,v3.18:,v3.19:,v3.60:,v3.23:,v3.24:,v3.42 fala,v3.43:,v3.45:,v3.46:,v3.50:,v3.51:,v3.52:,v3.53:,v3.58:,v3.67:,v3.69:,v3.70 resgate,v3.71 settings,v3.74 guarda,freio de força bruta` | 21 blocos = 22 testes / 254 checagens em 164 s |

**Duas metades não cabem mais** (a divisão de 06/11 estava nos 298 s): medido em 18/11, uma metade de 21 blocos
foi cortada aos **410 s com 19 blocos concluídos** — os blocos de ingestão/OCR são caros (`v1.8` 56 s,
`arquivos` 54 s, `v3.37` 33 s, `v3.1` 36 s) e não há como partir um bloco ao meio. Assinatura de corrida cortada:
`tests N / pass N-1 / cancelled 1` + "Promise resolution is still pending" — verde falso, refazer.

**As chaves são lidas DEPOIS da subida.** `up-test.sh` regrava `nexos_test_keys.env`; rodar
`set -a; . …/nexos_test_keys.env` antes do script deixa a rodada com a chave da rodada anterior e os blocos
caem em cascata (medido: 7 blocos vermelhos com `fail 7`, o primeiro em 292 ms — cara de defeito de produto).
Ordem fixa: `up-test.sh` → `set -a; . env; set +a` → `npm test`.

**`npm` do PATH é um wrapper com `--prefix` global** (`/opt/data/.local/bin/npm`): `npm test` dentro do repo
morre em `Missing script: "build:tests"`. No nexos, rode com `PATH=/usr/local/bin:$PATH`.

**Rodada de 19/11/2026 (v3.76.0, T059 b) — verde nas três partes**, com lotas de 14 blocos em vez das de cima
(o corte é escolha, desde que cada parte nomeie os pulados e o primeiro lote leve o `v1.8` com banco limpo):
A `v1.8:,MCP:,v3.36,v3.37,v1.10,arquivos:,imagem:,v2.7:,v2.8:,v2.9:,v3.0:,v3.1:,v3.2:,v3.3:` → 15 testes /
261 s; B `v3.4:,v3.5:,v3.6:,v3.7:,v3.9,v3.13.1,v3.15,v3.8:,v3.18:,v3.19:,v3.60:,v3.23:,v3.24:,v3.42` →
15 testes / 191 s; C `v3.43:,v3.45:,v3.46:,v3.50:,v3.51:,v3.52:,v3.53:,v3.58:,v3.67:,v3.69:,v3.70 resgate,`
`v3.71 settings,v3.74 guarda,freio de força bruta` → 15 testes / 90 s. `pass 15 / fail 0` em cada parte,
nessa ordem sobre o mesmo volume limpo. Primeira tentativa sem recriar o volume: `v1.8` vermelho por resíduo
(ver §1) — refazer com banco limpo resolveu, nenhum código mudou entre as duas.

Checagens por bloco (somam as 693): v1.8 38 (era 33; +5 na 3.76) · MCP 27 · v3.36 MCP por conta 15 · v3.37 SO do Windows 4 · v1.10 24 · arquivos 20 ·
imagem/OCR 10 · v2.7 painel/usuarios/chat 42 · v2.8 prompt/MCP interno/externo/rodadas/segredo 39 ·
v2.9 markdown/streaming/fila 41 · v3.0 memória/orçamento/escopo 39 · v3.1 boot/chave repetida 3 ·
v3.2 silêncio 9 · v3.3 tarefa 17 · v3.4 perfis 11 · v3.5 esquecimento-faxina 19 · **v3.6 maquinas 35** (v3.75: +5) ·
v3.7 chave-cliente 14 · v3.9 painel 7 · v3.13.1 cliente atravessa o deploy 9 ·
v3.15 rastro do turno 16 · v3.8 vocab e falas 11 · v3.18 básico de chat 36 · v3.19 provedores 27 ·
v3.60 padrão e memória 6 · v3.23 telas 12 · v3.24 código ao vivo 5 · v3.42 steering 11 ·
v3.43 túnel grande 5 · v3.45 arquivo grande 11 · v3.46 navegador -> máquina 11 · v3.50 8 · v3.51 10 ·
v3.52 7 · v3.53 13 · v3.58 8 · v3.67 8 · v3.69 comportamento da conta 5 · v3.70 resgate 11 ·
v3.71 settings nos lugares certos 20 · **v3.74 guarda do laço 27** · rate-limit 2.


## 10. O que a suíte NÃO prova do rastro (T041/v3.34)

A trilha do turno tem contrato no bloco `v3.15` (linhas, ordem, tipos), mas três coisas só se
provam olhando a tela com o navegador de verdade:

| O que | Como foi medido |
|---|---|
| **Ordem cronológica por `em`** | turno real com 2 ferramentas: `em` de cada linha não-decrescente, e a tela desenha nessa ordem mesmo se os eventos chegarem trocados |
| **Linha viva da ferramenta** | `ferramenta_inicio` abre "Consultando X… Ns" e o evento de fim fecha a MESMA linha (não cria outra) |
| **40px de toque no celular** | `getBoundingClientRect()` do cabeçalho a 390px de largura |
| **"Preparando…" antes do 1º sinal** | nenhum texto solto enquanto o provedor não manda nada; some quando o rastro existe |

Se um dia isso puder rodar sem navegador, vira bloco da suíte.
