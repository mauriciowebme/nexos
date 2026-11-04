# Referência: DeepSeek Harness (`dsh`) — o que já está pronto fora daqui

> **Última atualização:** 2026-11-04 · **Versão:** 3.72.0 · **Dono:** Mauricio

Investigação de 04/11/2026, lida no código do repositório (não em resumo de terceiros).
Serve de régua para **T054** (contexto atual no painel) e **T055** (velocidade em tok/s) e fica
sendo a referência da casa para qualquer trabalho de loop de agente, medidor ou compactação.

**Vida útil deste arquivo:** morre quando T054 e T055 fecharem — as decisões e os números abaixo
migram para a spec do módulo chat, e ele sai do repo (o histórico fica no `git log`).

## O que é

- Repositório `deepseek-ai/deepseek-harness` (MIT, TypeScript), criado em 13/08/2026, ~272 mil
  estrelas, com commit no próprio dia 04/11/2026. Site: `deepseek.com/harness`.
- Lema: **"Everything is a Plugin"** — adaptador de modelo, registro de ferramentas, log de sessão
  e o próprio loop do agente são plugins substituíveis por configuração. Sem núcleo privilegiado.
- Estado declarado pelo próprio projeto: *developer preview*, com quebra de compatibilidade avisada.
- Roda com `npx @deepseek-ai/dsh web` (porta 3080).

## Onde mora a cópia local

```
/opt/data/referencias/deepseek-harness     # clone raso (--depth 1), 250 MB, 20.665 arquivos
```

Fica **fora** do repo do nexos de propósito: é código de terceiros, não documentação nem código do
produto. Para atualizar: `git -C /opt/data/referencias/deepseek-harness pull --depth 1` (se o
raso reclamar, refazer o `git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git`).
Leitura por pacote em `packages/<área>/<pacote>/README.md` (seções fixas: Summary → Use this
package → Understand the implementation → Known Limitations) e o mapa geral em `docs/architecture.md`.

## O que já está pronto lá e vale como régua aqui

### 1. Medidor de contexto (a T054)

- Pacote `packages/llm/token-meter` (serviço `ctx.tokenMeter`), três projeções: `tokenUsage`,
  `contextPressure` (com `projectedTokens`, `pressureTokens`, `contextWindow`) e `contextBreakdown`
  (com `systemTokens`, `toolsTokens`, `messageTokens`).
- A medição é por **replay do log da conversa**: determinística, sem chamada a modelo, e todo
  consumidor (compactação, tela, telemetria) lê o mesmo número.
- **A heurística deles é 4 caracteres por token**, mais sobra de bloco e papel — a mesma régua da
  casa. A limitação é declarada no README, não escondida.
- Guarda da contagem real do provedor (mais firme que a que tínhamos escrito): o `usage` ancora a
  medição **só quando o envelope da chamada é idêntico ao da amostra** e o total vindo do provedor
  **não é menor** que o custo estimado completo daquela mesma chamada. Mudou ferramenta, provedor,
  modelo ou configuração da chamada → volta a estimativa inteira, sem exceção.
- A janela (o teto) vem do **adaptador do modelo** (`ctx.llm.resolveModelInfo().context`), não de
  uma configuração solta — no nexos isso já existe como janela configurada > detectada > padrão.
- Tela (`packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx`): anel com
  porcentagem **embaixo da caixa de escrever**; clicar abre um painel com a barra dividida em
  **prompt do sistema / ferramentas / mensagens** e a leitura `~18,4K / 150K`.
- **Honestidade do número:** todo valor estimado sai com til na frente; a largura da barra usa o
  percentual exato do provedor quando existe, e o detalhamento só reparte as cores. Enquanto
  numerador ou teto forem desconhecidos, o medidor **não aparece** (devolve vazio).

### 2. Velocidade de escrita (a T055)

- Cada rodada grava três carimbos: início do passo, **primeira letra**, última letra
  (`stepStartTime`, `firstTokenTime`, `completedTime`).
- Projeção durável (`packages/session/session-stats/src/projection.ts`) soma por passo:
  - `ttftMs += máx(0, primeiraLetra − inícioDoPasso)` — tempo até a primeira letra;
  - `decodeMs += máx(0, últimaLetra − primeiraLetra)` — tempo em que o modelo esteve escrevendo.
- Velocidade exibida: `tok/s = tokensDeSaída ÷ (decodeMs / 1000)`, somando só os passos que têm
  tempo de escrita. Ou seja: **sem o tempo até a primeira letra e sem a espera das ferramentas** —
  exatamente o desenho da T055.
- As pílulas do cabeçalho separam **três números diferentes**: `llmMs` (passo inteiro do modelo),
  `toolMs` (ferramenta) e `ttftMs` (primeira letra) — e o tempo do modelo nunca entra na velocidade.
- **O tempo até a primeira letra é métrica própria**, mostrada ao lado da velocidade. Isso faltava
  no desenho da T055.
- Os números viajam em **projeção durável**: paginar a conversa ou compactar não muda o que está
  na tela. Sem a projeção, existe um repli da janela visível como reserva, com os mesmos campos.

### 3. Compactação (comparação direta com `src/compactar.ts`)

- Gatilho: `piso(mínimo(janela × 0,8 ; janela − tetoDeSaída − reserva))`, com reserva padrão de
  **65.536 tokens**; retém os mais novos **16%** de (janela − tetoDeSaída) verbatim; tem override
  por modelo e novas tentativas configuráveis.
- Eles **gastam uma chamada de modelo** para resumir, e **recuperam de erro de estouro**: ao receber
  erro de contexto, condensam e refazem a chamada. O nexos é determinístico (custo zero) e não tem
  essa recuperação — diferença declarada, não defeito de nenhum dos dois.
- Existe `/compact` manual, que não gasta turno do agente e devolve quantos itens foram condensados
  e quantos tokens economizados; recusa enquanto houver compactação rodando ou turno em curso.
- Nenhum deles consegue reduzir prompt de sistema, ferramentas nem prefixo da conversa, nem dividir
  uma unidade indivisível (uma chamada de ferramenta gigante).
- **Diferença estrutural que importa para a T054:** no `dsh` a compactação é **gravada no log**
  (evento que substitui o histórico), então o medidor é estável entre turnos; no nexos ela é
  **re-feita a cada turno**. Por isso a tela do nexos tem de dizer "do último envio".

### 4. Ferramenta que devolve demais (ideia ainda não numerada aqui)

- `packages/spill/spill-policy` + `spill-local`: o resultado acima do orçamento vira **arquivo
  privado da conversa** no disco; o modelo recebe cabeça + cauda **e o caminho** para reler com
  leitura ou busca. No nexos o corte de resultado hoje descarta o resto — o texto volta a existir
  só se a ferramenta for chamada de novo.

## Decisões já fechadas

| # | Decisão | Data |
|---|---|---|
| D1 | O `dsh` passa a ser a **referência da casa** para medidor de contexto, velocidade de escrita e compactação. Antes de inventar desenho, olhar o pacote correspondente lá. | 04/11/2026 |
| D2 | T055 ganha **tempo até a primeira letra** como métrica própria, ao lado do tok/s. | 04/11/2026 |
| D3 | T054 marca número estimado com **`~`** na tela, e só mostra o medidor quando numerador **e** teto são conhecidos. | 04/11/2026 |
| D4 | A contagem real do provedor (passo 2 da T055) só substitui a estimativa quando o **envelope da chamada é idêntico** e o total não é menor que o estimado; mudou ferramenta/modelo/config, volta a estimativa. | 04/11/2026 |

## O que NÃO copiamos (declarado para ninguém tentar depois)

- A arquitetura de plugins (Cordis, perfis, bundles, costuras de capacidade): é o produto deles, não
  o do nexos.
- O log de sessão append-only como fonte do contexto: o nexos guarda histórico em banco e **não
  persiste a compactação**; trocar isso é outro trabalho, e a T054 existe justamente para conviver
  com essa diferença em vez de negá-la.
