# nexos como servidor MCP

> **Última atualização:** 28/10/2026 · **Versão:** 3.35.1 · **Medido no ambiente de teste**

O nexos é **três coisas ao mesmo tempo**, e é bom que isso esteja escrito num lugar só:

| Papel | Quem usa | Como se fala com ele |
|---|---|---|
| **Agente** | a pessoa conversando na tela | chat (stream), com o modelo e as ferramentas ligadas |
| **Central de memória** | quem precisa guardar e buscar | REST (`/documents`, `/search`, `/gavetas`) e as ferramentas do MCP |
| **Provedor de conexões** | outros agentes (Hermes, Claude, Cursor, scripts) | **MCP** em `POST /mcp` — JSON-RPC 2.0 sobre HTTP, sem sessão e sem SSE |

Este documento é sobre o terceiro papel: **usar o nexos como servidor MCP**. O mecanismo de dentro
(camada `src/mcp.ts`, mesmo processo, sem HTTP interno) está descrito no README.

---

## 1. Quem pode se conectar

**Todo usuário ativo.** Não existe cadastro separado de "cliente MCP": o usuário **é** a identidade MCP.
A chave do usuário é a credencial, e o escopo das ferramentas é o tenant dele.

```
POST https://nexos.techupsistemas.com/mcp
Authorization: Bearer <chave do usuário>
Content-Type: application/json
```

Duas regras que confundem e por isso ficam ditas:

- **Chave de cliente não serve.** As chaves da aba *Chaves de cliente* (usadas por sistemas como o
  IA_GO) são credencial de aplicação: abrem REST de documentos, **nunca** painel, chat ou MCP (401).
- **Não há segunda autenticação.** A chave que abre a tela é a mesma que abre o MCP.

Para criar um usuário: painel → Usuários, ou, para o operador, a ferramenta `criar_usuario`
(a chave volta em claro **uma única vez**).

---

## 2. Fluxo de conversa (JSON-RPC 2.0)

```jsonc
// 1. initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
// → { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "nexos", version: "3.35.1" } }

// 2. notifications/initialized  (aceito com 202, sem corpo)
{"jsonrpc":"2.0","method":"notifications/initialized"}

// 3. tools/list
{"jsonrpc":"2.0","id":2,"method":"tools/list"}

// 4. tools/call
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"search","arguments":{"query":"que horas é a reunião","memoria":"empresa42"}}}
// → { content: [{ type: "text", text: "<JSON do retorno>" }] }
```

Erro de ferramenta vem como `result` com `isError: true` (linguagem do MCP). Erro de
autenticação/protocolo vem como JSON-RPC: `-32001` (auth), `-32601` (método), `-32700` (parse).

**Exemplo colável:**

```bash
curl -X POST https://nexos.techupsistemas.com/mcp \
  -H "Authorization: Bearer $MINIRAG_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health","arguments":{}}}'
```

---

## 3. As ferramentas — e o que cada conta recebe

Medido em 30/10/2026 (v3.50.0), conta **operador** com o controle de máquinas ligado:
**57 ferramentas** no `tools/list`. Conta comum vê **51** (as 6 de operador saem da lista).

| Grupo | Quantas | Ferramentas |
|---|---|---|
| Operação e assistente | 11 | `rodar_python`, `health`, `analisar_imagem`, `list_anexos`, `mostrar_tela`, `web_search`, `web_open`, `chat`, `config_provider`, `list_jobs`, `maquinas_online` |
| Documentos | 10 | `search`, `ingest`, `ingest_status`, `list_docs`, `delete_doc`, `upload_file`, `get_file`, `edit_doc`, `rename_doc`, `archive_doc` |
| Gavetas | 3 | `list_gavetas`, `create_gaveta`, `delete_gaveta` |
| Usuários e MCP | 6 | `listar_usuarios`, `criar_usuario`, `apagar_usuario`, `esquecimento`, `listar_mcp`, `gerir_mcp` |
| Pareamento | 1 | `gerar_pareamento` |
| Máquinas (túnel) | 26 | só existem com o **controle de máquinas** ligado pelo operador |

**`rodar_python` (T052)** — o modelo escreve um script e roda no servidor. Dentro dele,
`import nexos` dá as ferramentas como funções (`nexos.web_search(query="...")`,
`nexos.search(...)`, `nexos.rodar_comando(...)`); `nexos.ferramentas()` lista as disponíveis.
Cada chamada passa pela mesma checagem de permissão de quem pediu, e volta na resposta com
nome, ok e tempo. Teto de 120 s (parâmetro `segundos`), saída cortada em 120 KB.
Só de operador.

**Isolamento (v3.53)** — o script roda como um usuário próprio por conta (uid 20000–29999),
nunca root:

| Camada | Regra |
|---|---|
| Arquivos | a pasta da conta responde "permissão negada" a outra conta; o script não lista nem abre o diretório alheio |
| Rede | internet **só** pelo proxy local (`HTTP_PROXY`/`HTTPS_PROXY`); socket direto é recusado, e o proxy barra qualquer destino que resolva para endereço interno |
| Memória | `ulimit -v` (512 MB por padrão, `NEXOS_SANDBOX_MEM_MB`) |
| Tempo e saída | 120 s e 120 KB, como antes |

O retorno traz `rede`: a lista de destinos que passaram pelo proxy e os que foram negados
(com o motivo).

**Cada conta tem a sua pasta** (v3.51) em `/app/dados/usuarios/<conta>/`:

| Caminho | O que é |
|---|---|
| `venv/` | bibliotecas daquela conta (criado na primeira execução) |
| `scripts/saida/` | arquivos que os scripts geram — ficam entre execuções |
| `scripts/ferramentas/` | scripts salvos como ferramenta (etapa 2b, ainda não entregue) |
| `dependencias.txt` | o que já foi instalado, com data |
| `pip-cache/` | downloads guardados |

Para usar uma biblioteca, o script **declara** o que precisa no parâmetro `dependencias`
(`["openpyxl", "pandas==2.2.2"]`); o servidor instala só o que falta e guarda. Teto de **2 GB**
por conta (`NEXOS_SANDBOX_TETO_MB`). O `pip` é o único processo com rede; o script continua
sem rede direta e alcança a internet só pelas ferramentas. Nome com URL ou opção
(`git+https://…`) é recusado.

**O que o operador controla (e vale para todo mundo):**

1. **Ferramentas internas** (`mcp_interno`) — desligado, o chat não recebe ferramenta nenhuma.
2. **Controle das máquinas** — desligado, as 20 ferramentas de máquina **desaparecem do `tools/list`**
   e a chamada é recusada (409).
3. **Servidores MCP externos** — cada um vira `<servidor>__<ferramenta>` no chat.

**O que é do papel, não do cadastro:** cinco ferramentas são só de operador e devolvem **403** para
usuário comum: `listar_usuarios`, `criar_usuario`, `apagar_usuario`, `esquecimento`, `gerir_mcp`.

> ⚠️ **Hoje o `tools/list` não filtra por papel**: um usuário comum vê as 49 na lista e descobre o
> limite só ao chamar (403). A lista diz a verdade sobre o *servidor*, não sobre a *conta*.

**O que cada conta vê dos próprios dados:** tudo é filtrado pelo tenant do usuário — as gavetas,
documentos e máquinas que ele enxerga são as dele. O operador pode apontar `tenant` em várias
ferramentas para agir na conta de outro; para usuário comum esse campo é ignorado.

---

## 4. O nexos como cliente MCP (o sentido inverso)

Em **Configurações → Ferramentas (MCP)** o operador cadastra servidores externos por URL. Cada
ferramenta deles entra no chat como `<nome-do-servidor>__<ferramenta>` (o nome do servidor não pode
conter `__`). A chave de acesso fica guardada no servidor e volta mascarada (`••••xy98`).

---

## 5. Limites conhecidos

- **Sem SSE e sem sessão**: cada POST é independente; não há notificação de progresso.
- **`get_file` devolve base64** dentro do JSON-RPC — 15 MB viram ~20 MB de texto. Em massa, use a REST
  (`GET /documents/{id}/arquivo`), que devolve o binário puro.
- **A ferramenta `chat` fica fora da lista injetada no próprio chat** (evita o modelo chamar a si
  mesmo); pelo MCP ela continua disponível.
- **Timeouts** contam no cliente: `upload_file` e `ingest` de arquivo grande podem passar de 30 s.
- **`ingest_status` exige `job_id`**: sem ele (ou com valor não inteiro) responde `422` pedindo o id;
  o id sai de `ingest`/`upload_file`/`edit_doc` ou de `list_jobs`.
- **`upload_file` devolve `anexo_id`** além de `doc_id`/`job_id`: o mesmo arquivo entra no RAG e no canal de
  anexos, então dá para encadear direto com `enviar_para_maquina` (sem passar por `list_anexos`).
- **`edit_doc` sem `title` herda o título atual** — a edição não apaga o título, e documento arquivado
  continua arquivado depois de reindexar.
- **Saída de comando no Windows**: o cliente decodifica cp850 quando os bytes não são UTF-8 válido, então
  acentuação de `cmd.exe` chega legível.

---

## 6. Receita rápida — Hermes Agent

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  nexos:
    url: https://nexos.techupsistemas.com/mcp
    headers:
      Authorization: Bearer ${MINIRAG_KEY}
    timeout: 120
```

Depois de reiniciar o agente, as ferramentas aparecem como `mcp_nexos_search`, `mcp_nexos_ingest`
etc. A chave sai do ambiente (`MINIRAG_KEY`), nunca do arquivo.
