# Próximos passos — Nexos

> **Última atualização:** 2026-10-31 · **Versão:** 3.55.0 · **Dono:** Mauricio

Este arquivo tem **só o que está em aberto** — as tarefas entregues foram removidas na limpeza de
30/10 (o histórico fica no `git log`). Execução de qualquer T### exige OK explícito do Mauricio.

## Índice

| T### | Nome | Módulo | Prioridade | Status | Link |
|---|---|---|---|---|---|
| T052 | Sandbox Python com as ferramentas do nexos + biblioteca + agenda | sandbox + ferramentas | 🟠 Alta | 🟢 Etapas 1 e 2 na v3.51.0 (falta a agenda) | [#t052](#t052) |
| T053 | Sandbox: isolamento por conta, rede pelo proxy e cota | sandbox | 🟠 Alta | 🟢 Camadas 1–3 na v3.53.0; falta a tela de bibliotecas | [#t053](#t053) |

## Correções já no ar

| Versão | O que corrigiu | Como foi achado |
|---|---|---|
| 3.55.0 | O painel mostrava **rodadas do agente**, **memória da conversa** e **últimas intactas na compactação** dentro do formulário do provider, como se fossem daquele serviço. No banco elas já eram da conta (`provider_config`), como as instruções do modelo. Agora vivem no card **"instruções e comportamento do modelo"**, salvam pelo mesmo botão e pela mesma rota (`PUT /config/instrucoes`, que passou a aceitar os três com as faixas 0–60, 0–100 e 0–40). No formulário do provider ficou só o que é do serviço e do modelo: tipo, modelo, URL, chave, temperatura, janela, reserva e espera. | Pedido do dono ao ver a tela: "tirando a temperatura, as outras coisas deveriam estar junto de onde configura o system prompt, porque são gerais". |
| 3.54.0 | Quatro defeitos da varredura das 57: `ingest_status` sem `job_id` estourava o Postgres (`invalid input syntax for type bigint: "NaN"`) e agora responde 422 pedindo o parâmetro; `edit_doc` sem título apagava o título do chunk (busca devolvia `title: ""`) e agora herda o atual; reindexar documento arquivado o desarquivava em silêncio (chunk novo nascia com `archived_at` NULL) e agora preserva o estado; `upload_file` não devolvia `anexo_id`, então `enviar_para_maquina` não encadeava — agora devolve e o arquivo aparece em `list_anexos`. O cliente também passou a decodificar a saída do Windows em cp850 ("não" saía como "n\uFFFDo"). | Varredura completa das 57 ferramentas na JPPC (31/10), chamando cada uma de verdade. |
| 3.52.0 | `analisar_imagem` baixava a imagem sem user-agent (sites exigentes, como o Wikimedia, devolviam 400) e aceitava endereço interno (dava para pedir `127.0.0.1:8001`, o embedder). Agora usa o mesmo UA de navegador do `web_open` e passa pela mesma trava de endereço interno, inclusive a cada salto de redirecionamento. | Teste de todas as 57 ferramentas (30/10), chamando cada uma de verdade. |

---

### T052 — Sandbox Python com as ferramentas do nexos

| Campo | Conteúdo |
|---|---|
| **Módulo** | sandbox (novo) + ferramentas + agenda |
| **Prioridade** | 🟠 Alta — é o que separa "assistente que conversa" de "assistente que constrói" |
| **Status** | 🟢 **Etapas 1 e 2 entregues** — v3.50.0 (executor + ponte) e v3.51.0 (pasta por usuário, venv e bibliotecas). Falta a agenda. |
| **Pedido** | "a ideia seria ter tipo um sandbox pra poder o usuário pedir 'faz tal coisa' que você não consiga, aí você poderia usar o Python que conseguiria usar as ferramentas — por exemplo, faz uma busca programada na web, aí vai lá e cria um script e roda isso" |
| **Problema que resolve** | Hoje o modelo só tem `rodar_comando` (shell cru) e uma ferramenta por vez. Quando o pedido exige repetir, comparar, testar condição ou juntar resultados, ele improvisa PowerShell/bash a cada resposta, gasta contexto e erra. Foi exatamente o que aconteceu em 30/10: para contornar o upload quebrado, o modelo tentou base64, HttpListener e certutil em vez de resolver. |
| **Desenho** | Quatro peças. (1) **Executor**: processo separado por execução, pasta própria, teto de tempo, memória e saída; stdlib por padrão. (2) **Ponte**: dentro do sandbox existe `import nexos`, com as ferramentas do servidor e da máquina como funções (`web_search`, `web_open`, `search`, `rodar_comando`, `baixar_arquivo`, `ler_arquivo`...). Cada função checa a permissão **do usuário que pediu** — o script nunca herda mais poder que quem pediu. (3) **Biblioteca**: script aprovado vira ferramenta nomeada (descrição + parâmetros) e entra no `tools/list`; roda de novo sem gastar modelo. (4) **Agenda**: rodar sozinho (de hora em hora, todo dia) e entregar o resultado no chat. |
| **Limites de segurança** | Sem rede direta: a internet só é alcançada pelas ferramentas, então tudo continua passando pelo mesmo controle e pelo mesmo log. `pip install` só com confirmação do operador. Sandbox liberado primeiro só para operador; liberação por usuário depois. Nada de acesso à pasta de dados do servidor. |
| **Por que Python** | Já existe dos dois lados: servidor 3.11.18 (roda embedder e OCR) e a máquina do trabalho com 3.12.10. Se a máquina não tiver, usar o *embeddable* (zip ~11 MB) dentro da pasta de trabalho, sem admin e sem instalar no sistema. |
| **Ganho colateral** | As ferramentas de arquivo que quebraram em 30/10 (upload em PowerShell) podem passar a usar o caminho Python, que não depende do .NET da máquina. |
| **Prova exigida na execução** | Um pedido real que hoje falha ("busca programada na web sobre X, junta e salva"): o modelo escreve o script, roda no sandbox, o arquivo aparece e o resumo volta no chat. Depois o mesmo script vira ferramenta e roda por agenda, sem modelo. Suíte completa verde e o sandbox recusando script de usuário sem permissão. |

## Etapas da T052

| Etapa | O que entrega | Estado |
|---|---|---|
| 1. Executor + ponte | `rodar_python` no `tools/list`; `import nexos` com as ferramentas permitidas; teto de 120 s; saída cortada em 120 KB; pasta temporária apagada; rede direta bloqueada no Python | ✅ v3.50.0 |
| 2a. Pasta + venv + bibliotecas | `/app/dados/usuarios/<conta>/` com `venv/`, `scripts/saida/`, `dependencias.txt` e `pip-cache/`; o script declara `dependencias` e o servidor instala só o que falta; teto de 2 GB por conta; pip é o único processo com rede | ✅ v3.51.0 |
| 2b. Biblioteca de scripts | script aprovado vira ferramenta nomeada (descrição + parâmetros) e entra no `tools/list` | 📋 falta |
| 3. Agenda | rodar sozinho (de hora em hora / todo dia) e entregar no chat | 📋 falta |

**Limite conhecido da etapa 1:** o bloqueio de rede é no Python (`socket` substituído por
`sitecustomize.py`); um script que chame `subprocess` com `curl` ainda alcança a rede. O limite
de verdade continua sendo o container — o confinamento por processo fica na etapa 2.

### T053 — Sandbox: liberdade com isolamento

| Campo | Conteúdo |
|---|---|
| **Módulo** | sandbox |
| **Pedido** | "o mais liberdade possível com o mais seguro possível sem vazamentos" |
| **Entregue na v3.53.0** | (1) o script roda como **uid próprio por conta** (20000–29999, nunca root) e a pasta da conta é 700 — outra conta recebe "permissão negada"; (2) a internet passa **só pelo proxy local** (`HTTP_PROXY`/`HTTPS_PROXY`), que recusa qualquer destino interno e registra o que passou e o que foi negado; (3) **teto de memória** por `ulimit -v` (512 MB, `NEXOS_SANDBOX_MEM_MB`); (4) o retorno traz `rede` com os destinos. |
| **Limite conhecido** | o bloqueio de socket é no Python (`sitecustomize`); um script que chame `subprocess` com `curl`, ou `ctypes`, ainda alcança a rede. Fechar isso exige barreira de SO (namespace de rede ou regra por uid), e o container atual não tem `CAP_SYS_ADMIN`/`CAP_NET_ADMIN` — medido: `bwrap` e `unshare -U` respondem "Operation not permitted". Alternativa: serviço executor separado com rede própria (custo: um serviço a mais). |
| **Falta** | tela do que está instalado por conta, com botão de apagar; `pip` livre com registro; agenda da T052. |

## Ideias ainda não numeradas

- **Suíte testar o caminho Windows**: hoje a suíte roda em Linux e nunca exercita o upload por
  PowerShell — foi por isso que os três defeitos de 30/10 passaram. Um teste que rode na máquina
  real (ou um duplo do cliente Windows) fecha essa lacuna.
