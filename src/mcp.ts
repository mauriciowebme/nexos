/** MCP sobre POST /mcp — JSON-RPC 2.0 stateless, espelho das rotas REST. */
import { Usuario, tenantFor } from "./config";
import { HttpError, erro403 } from "./errors";
import {
  criarGaveta,
  deleteDoc,
  deleteGaveta,
  getArquivoOriginal,
  jobParaUsuario,
  listDocs,
  listGavetas,
  listJobs,
  patchArquivado,
  patchDocument,
  putDocument,
  search,
  uploadArquivo,
} from "./service";
import { enqueueIngest } from "./ingest";
import { criarAnexo, listarAnexos } from "./anexos";
import { CONFIG } from "./config";
import { healthAtual } from "./ferramentas";
import { ocrDisponivel, ocrImagem } from "./ocr";
import { criarUsuario, listarUsuarios, exigirOperador, removerUsuario } from "./usuarios";
import { escreverEsquecimento, lerEsquecimento } from "./esquecimento";
import { alvoMaquina, criarPareamento, controleDeMaquinaAtivo, listarMaquinas, rodar } from "./maquinas";
import { NOMES_MAQUINA_TOOLS, toolMaquina, wrapComando } from "./maquinas_tools";
import { eDeMaquina, ferramentaPermitida, motivoDeBloqueio } from "./mcp_acesso";
import { responderChat, salvarProvider, testarProvider, verProvider } from "./provider";
import { montarTela } from "./telas";
import { abrirPagina, baixarImagem, buscarWeb } from "./web";
import {
  atualizarFerramentas,
  atualizarServidor,
  apagarServidor,
  criarServidor,
  listarServidores,
} from "./ferramentas";

/** As ferramentas que o Chat pode chamar: todas do MCP, menos o próprio chat (recursivo).
    v3.36: com o usuário em mãos, o pacote obedece às mesmas regras do tools/list — o chat do
    comum não recebe ferramenta de operador nem o que ele mesmo desligou na tela MCP. */
export function toolsParaChat(user?: { tenant: string; operador?: boolean }): Tool[] {
  return TOOLS.filter(
    (t) =>
      t.name !== "chat" &&
      (controleDeMaquinaAtivo() || !eDeMaquina(t.name)) &&
      /* o interruptor do admin vale para o MCP de fora; o chat da casa continua com as suas
         (senão desligar o servidor MCP calaria o chat de todo mundo) */
      (!user || motivoDeBloqueio(user.tenant, user.operador, t.name) === null ||
        motivoDeBloqueio(user.tenant, user.operador, t.name) === "servidor_desligado"),
  );
}

/** Executa uma ferramenta interna no MESMO processo — é o mesmo caminho do POST /mcp, sem HTTP. */
export async function chamarToolInterna(name: string, args: Record<string, unknown>, user: Usuario) {
  if (!TOOLS.some((t) => t.name === name)) throw new Error(`tool desconhecida: ${name}`);
  const deps: McpDeps = { health: healthAtual, autenticar: () => user };
  return executarTool(name, args ?? {}, user, deps);
}

const PROTOCOLOS = ["2025-06-18", "2025-03-10", "2024-11-05"];
const SERVER_INFO = { name: "nexos", version: CONFIG.versao };

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOLS: Tool[] = [
  {
    name: "rodar_python",
    description:
      "Roda um script Python na pasta do usuario e devolve o que ele imprimiu. Dentro do script, as ferramentas do nexos aparecem como funcoes do modulo nexos: `import nexos` e depois nexos.web_search(query=\"...\"), nexos.search(query=\"...\"), nexos.web_open(url=\"...\"), nexos.rodar_comando(...), etc (nexos.ferramentas() lista todas). Use quando o pedido exigir repetir, comparar, filtrar, juntar resultados ou salvar arquivo - em vez de chamar ferramenta por ferramenta. Bibliotecas: declare em `dependencias` (ex: [\"openpyxl\", \"pandas==2.2.2\"]); o servidor instala so o que falta no ambiente do usuario e fica guardado para as proximas execucoes. O script roda em pasta propria do usuario, com teto de 120s (parametro segundos), sem acesso direto a internet (use as ferramentas); arquivos que ele criar ficam em scripts/saida. stdout e stderr voltam inteiros; cada chamada de ferramenta fica registrada na resposta.",
    inputSchema: {
      type: "object",
      properties: {
        codigo: { type: "string", description: "codigo Python a executar (obrigatorio)" },
        segundos: { type: "integer", description: "teto de tempo em segundos (5 a 600; padrao 120)" },
        dependencias: {
          type: "array",
          items: { type: "string" },
          description: "bibliotecas que o script precisa, ex: [\"openpyxl\", \"pandas==2.2.2\"]. Instaladas so quando faltam.",
        },
      },
      required: ["codigo"],
    },
  },
  {
    name: "health",
    description:
      "Status do servidor RAG: dimensao do modelo de embedding e numero de usuarios ativos.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "analisar_imagem",
    description:
      "Le o TEXTO de uma imagem (print, foto, captura de tela) por OCR local. Passe url (http/https) ou base64. Devolve o texto reconhecido, o motor e o tempo. Teto 8MB. Para o modelo VER a imagem (descrever, analisar), o usuario cola no chat e ela vai como visao nativa.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "endereco http(s) da imagem" },
        base64: { type: "string", description: "imagem em base64, com ou sem o prefixo data:" },
      },
    },
  },
  {
    name: "search",
    description:
      "Busca semantica na memoria do chamador. Retorna chunks com score (similaridade coseno). min_score default 0.55.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "texto da busca (max 2000 chars)" },
        k: { type: "integer", description: "maximo de resultados (1-50; default 5)" },
        min_score: { type: "number", description: "piso de similaridade 0-1 (default 0.55)" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        include_archived: {
          type: "boolean",
          description: "buscar tambem nos arquivados (revive o chunk achado)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ingest",
    description:
      "Enfileira um documento para ingestao (nao trava: responde job_id na hora). Acompanhe com ingest_status.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "id do doc (regravar o mesmo doc_id substitui o antigo)" },
        title: { type: "string" },
        content: { type: "string", description: "texto do doc (max 500000 chars)" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
      },
      required: ["doc_id", "content"],
    },
  },
  {
    name: "ingest_status",
    description:
      "Status de um job de ingestao: na_fila | processando | concluido | erro | cancelado (+ progresso de chunks).",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "integer" } },
      required: ["job_id"],
    },
  },
  {
    name: "list_docs",
    description:
      "Lista os documentos do chamador em uma memoria (doc_id, titulo, chunks, atualizado_em).",
    inputSchema: {
      type: "object",
      properties: {
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        include_archived: { type: "boolean" },
      },
    },
  },
  {
    name: "list_anexos",
    description:
      "Lista os arquivos da pasta do chamador (nome, bytes, data, maquina de origem) — os mesmos da aba Meus arquivos. Nao devolve o conteudo.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "filtro por nome" },
        limit: { type: "number", description: "1..200 (default 50)" },
      },
    },
  },
  {
    name: "delete_doc",
    description:
      "Apaga DEFINITIVAMENTE um doc (chunks + jobs na fila) na memoria do chamador. 409 se estiver processando.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
      },
      required: ["doc_id"],
    },
  },
  {
    name: "upload_file",
    description:
      "Envia um ARQUIVO (pdf, docx, xlsx, csv, html, txt, md ou imagem png/jpg/webp/tiff) em base64: guarda o original, extrai o texto e enfileira. Imagem e PDF escaneado sao lidos por OCR (aviso: OCR erra numero). Mesmo nome na mesma gaveta substitui o anterior.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "nome do arquivo com extensao (ex: contrato.pdf)" },
        conteudo_base64: { type: "string", description: "bytes do arquivo em base64 (max 15 MB)" },
        mime: { type: "string", description: "content-type, opcional (o servidor deduz pela extensao)" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        doc_id: { type: "string", description: "id do doc; vazio = derivado do nome do arquivo" },
        title: { type: "string" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["nome", "conteudo_base64"],
    },
  },
  {
    name: "get_file",
    description:
      "Devolve o ARQUIVO ORIGINAL guardado (nome, mime, tipo, tamanho e conteudo_base64). 404 quando o doc foi criado como texto puro.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["doc_id"],
    },
  },
  {
    name: "edit_doc",
    description:
      "Edita o TEXTO de um documento existente e reindexa (202). Em doc vindo de arquivo de texto, o original guardado acompanha a edicao.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        content: { type: "string", description: "texto novo (max 500000 chars)" },
        title: { type: "string" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["doc_id", "content"],
    },
  },
  {
    name: "rename_doc",
    description:
      "Renomeia o doc_id e/ou muda o titulo e/ou move para outra gaveta, sem reindexar. 409 se o doc tem job processando.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        novo_doc_id: { type: "string" },
        title: { type: "string" },
        destino_memoria: { type: "string", description: "gaveta de destino (default: a mesma)" },
        memoria: { type: "string", description: "gaveta atual (default '')" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["doc_id"],
    },
  },
  {
    name: "archive_doc",
    description: "Arquiva ou revive um documento inteiro (sem apagar nada).",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        arquivado: { type: "boolean", description: "true arquiva, false revive" },
        memoria: { type: "string", description: "gaveta dentro do login (default '')" },
        tenant: { type: "string", description: "alvo do operador; ignorado para login comum" },
      },
      required: ["doc_id", "arquivado"],
    },
  },
  {
    name: "list_gavetas",
    description:
      "Mapa de usuarios e gavetas com contagem de documentos e chunks. Operador ve tudo; login comum ve so o proprio.",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string", description: "filtra um usuario (so operador)" },
      },
    },
  },
  {
    name: "create_gaveta",
    description: "Cria uma gaveta vazia (para receber documentos depois).",
    inputSchema: {
      type: "object",
      properties: {
        memoria: { type: "string", description: "nome da gaveta" },
        tenant: { type: "string", description: "dono (so operador; comum cria na propria)" },
      },
      required: ["memoria"],
    },
  },
  {
    name: "delete_gaveta",
    description: "Apaga a gaveta inteira (chunks + fontes + arquivos originais + jobs na fila). 409 se ha job processando.",
    inputSchema: {
      type: "object",
      properties: {
        memoria: { type: "string" },
        tenant: { type: "string", description: "dono (obrigatorio quando o operador apaga gaveta alheia)" },
      },
      required: ["memoria"],
    },
  },
  {
    name: "mostrar_tela",
    description:
      "Mostra ao usuário uma TELA gerada por você (HTML + CSS + JS numa página só): o chat abre um card com preview FUNCIONAL (botão clica, campo digita, gráfico desenha), além de tela cheia, código e download. USE quando o pedido for visual ou quando o resultado ficar melhor vendo do que lendo: gráfico, painel, comparativo, tabela formatada, formulário, calculadora, simulação, mapa mental, linha do tempo. NÃO use para resposta curta de texto, e NÃO repita o HTML na sua resposta depois de chamar a ferramenta.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "título curto do card (ex.: 'Vendas por mês — 2026')" },
        html: {
          type: "string",
          description:
            "página HTML completa ou fragmento (div/svg/table) com CSS e JS INLINE. Proibido CDN ou arquivo externo: tem de funcionar offline. Use os dados reais que você tem no contexto; o que faltar, diga na própria tela.",
        },
      },
      required: ["titulo", "html"],
    },
  },
  {
    name: "web_search",
    description:
      "Busca na INTERNET (não na memória): devolve títulos, links e trechos dos resultados. Use quando a pergunta for sobre fato atual, notícia, preço, versão de software ou algo que não está na memória — e diga de onde veio. Se quiser ler uma página inteira, chame web_open com a url.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "o que procurar (max 300 chars)" },
        k: { type: "integer", description: "quantos resultados (1-10; default 5)" },
        site: { type: "string", description: "opcional: restringe a um domínio (ex.: gov.br)" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_open",
    description:
      "Abre uma URL da internet e devolve o TEXTO da página (sem menu, sem script), até 12000 caracteres. Se o site monta o conteúdo por JavaScript, isso é detectado sozinho e a página é renderizada num navegador (fica 2 a 15s). Use depois do web_search para ler a fonte que interessou, ou quando o usuário mandar um link.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "endereço http(s) da página" },
        js: { type: "boolean", description: "força a renderização por navegador (padrão: só quando o texto vier vazio)" },
      },
      required: ["url"],
    },
  },
  {
    name: "chat",
    description:
      "Pergunta para o chat do nexos. O modelo responde com o provider configurado, as instrucoes do system prompt e as ferramentas ligadas (mcp interno + servidores externos); devolve a resposta e o que foi chamado.",
    inputSchema: {
      type: "object",
      properties: {
        pergunta: { type: "string", description: "a pergunta (max 2000 chars)" },
        memoria: { type: "string", description: "gaveta do historico (default '')" },
        tenant: { type: "string", description: "dono da gaveta (so operador)" },
      },
      required: ["pergunta"],
    },
  },
  {
    name: "listar_usuarios",
    description: "Lista os usuarios do servidor (nome, papel, ativo, documentos). Somente operador.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "criar_usuario",
    description:
      "Cria um usuario e devolve a chave em claro UMA UNICA VEZ (guarde na hora). Somente operador.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "2-32 chars: letras sem acento, numeros, . _ -" },
        papel: { type: "string", enum: ["usuario", "operador"] },
      },
      required: ["nome"],
    },
  },
  {
    name: "apagar_usuario",
    description:
      "Agenda a exclusao de um usuario: login desliga na hora, os dados dele somem depois da carencia configuravel (default 30 dias). Recriar o nome dentro da janela desfaz. Somente operador.",
    inputSchema: {
      type: "object",
      properties: { nome: { type: "string" } },
      required: ["nome"],
    },
  },
  {
    name: "esquecimento",
    description:
      "Numeros do esquecimento (dias_arquivar, dias_excluir_arquivado, dias_carencia). acao=ver | definir. Somente operador.",
    inputSchema: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["ver", "definir"] },
        dias_arquivar: { type: "integer", description: "sem uso ha N dias vira ARQUIVADO (default 180 = 6 meses)" },
        dias_excluir_arquivado: { type: "integer", description: "arquivado ha mais de N dias e apagado de verdade (default 365)" },
        dias_carencia: { type: "integer", description: "janela para desfazer o apagar de um usuario (default 30)" },
      },
      required: ["acao"],
    },
  },
  {
    name: "config_provider",
    description:
      "Provider de linguagem do chat (LiteLLM/OpenAI/Ollama). acao=ver | salvar | testar. A chave nunca volta em claro.",
    inputSchema: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["ver", "salvar", "testar"] },
        tipo: { type: "string", enum: ["litellm", "openai", "ollama"] },
        base_url: { type: "string", description: "ex.: https://litellm.exemplo.com/v1" },
        modelo: { type: "string" },
        chave: { type: "string", description: "omita para manter a chave ja salva" },
        temperatura: { type: "number" },
        system_prompt: { type: "string", description: "instrucoes iniciais do modelo; vazio = nenhuma instrucao" },
        mcp_interno: { type: "boolean", description: "ligar as ferramentas do proprio nexos no chat" },
        max_rodadas: { type: "integer", description: "rodadas de ferramenta por pergunta (0-60; default 5)" },
        ativo: { type: "boolean" },
        global: { type: "boolean", description: "gravar como padrao global (so operador)" },
      },
      required: ["acao"],
    },
  },
  {
    name: "listar_mcp",
    description:
      "Servidores MCP externos cadastrados para dar ferramentas ao chat (nome, url, ativo, n de ferramentas). O cabecalho de acesso nunca volta em claro.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gerir_mcp",
    description:
      "Cuida dos servidores MCP do chat. acao=criar | atualizar | apagar | testar (testar lista as ferramentas). Somente operador.",
    inputSchema: {
      type: "object",
      properties: {
        acao: { type: "string", enum: ["criar", "atualizar", "apagar", "testar"] },
        nome: { type: "string", description: "2-32 caracteres, sem '__'" },
        url: { type: "string", description: "endereco http(s) do servidor MCP" },
        cabecalho: { type: "string", description: "Authorization: Bearer xxx ou o token cru; omita para manter" },
        ativo: { type: "boolean" },
      },
      required: ["acao", "nome"],
    },
  },
  {
    name: "list_jobs",
    description: "Fila de ingestao com resumo por status (na_fila | processando | concluido | erro | cancelado).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        tenant: { type: "string", description: "filtra um usuario (so operador)" },
        limit: { type: "integer", description: "default 50, max 200" },
      },
    },
  },
  {
    name: "gerar_pareamento",
    description:
      "Cria um token de pareamento de maquina (uso unico, expira em ~15 min). O cliente da maquina usa esse token uma vez e ganha o token definitivo. Maquina nasce presa ao usuario que gerou.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "apelido da maquina (letras, numeros, - . _)" },
        tenant: { type: "string", description: "so operador: para quem sera a maquina" },
      },
      required: ["nome"],
    },
  },
  {
    name: "maquinas_online",
    description: "Lista as maquinas do usuario com estado online (host, so, desde, ativo).",
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string", description: "so operador: mira outro usuario; sem tenant o operador ve todas" },
      },
    },
  },
  {
    name: "rodar_comando",
    description:
      "Executa um comando de shell numa maquina DO USUARIO (fora do ar ou de outro dono = erro). Responde {exit, stdout, stderr, ms}. Tudo fica auditado. background=true sobe o processo solto (devolve INICIADO_PID e o comando do servidor termina sem matar o que roda la).",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string" },
        cmd: { type: "string", description: "comando de shell (ate 4000 chars)" },
        timeout: { type: "integer", description: "segundos aguardando; default 30, max 900 (15 min)" },
        background: { type: "boolean", description: "true = inicia e devolve o PID na hora; o processo sobrevive ao fim da chamada (servidor, modelo, build). Sem timeout e sem stdout de volta." },
        tenant: { type: "string", description: "so operador: dono da maquina" },
        sessao: { type: "string", description: "nome de sessao aberta (tool sessao) — roda dentro daquela pasta" },
        env: { type: "object", description: "variaveis SO nesta execucao ({NOME: valor}); nao persistem" },
      },
      required: ["host", "cmd"],
    },
  },
  /* --------------------------------------------------- v3.8: vocabulario do tunel (20 tools) */
  {
    name: "listar_arquivos",
    description: "Lista um diretorio da maquina remota (nome, tamanho, modificacao, tipo).",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      caminho: { type: "string", description: "diretorio, ex.: C:\\\\DAM ou /opt" },
      padrao: { type: "string", description: "filtro de nome (padrao *)" },
      tenant: { type: "string", description: "so operador: dono da maquina" } }, required: ["host", "caminho"] },
  },
  {
    name: "ler_arquivo",
    description: "Le um arquivo da maquina remota. Texto: conteudo utf-8 (offset/limite em bytes). binario=true: base64 ate 800KB por chamada.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      caminho: { type: "string" },
      offset: { type: "integer", description: "byte inicial (padrao 0)" },
      limite: { type: "integer", description: "max bytes (padrao 200000, max 800000)" },
      binario: { type: "boolean", description: "true = devolver base64 cru" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "caminho"] },
  },
  {
    name: "escrever_arquivo",
    description: "Escreve um arquivo na maquina remota. TEXTO: conteudo (utf-8 cru, o servidor codifica — NUNCA cole base64 na mao). BINARIO: conteudo_base64. append=true acrescenta. Cria pastas-mae. Devolve bytes_no_arquivo. Limite 16MB.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      caminho: { type: "string" },
      conteudo: { type: "string", description: "texto cru utf-8" },
      conteudo_base64: { type: "string", description: "bytes em base64" },
      append: { type: "boolean" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "caminho"] },
  },
  {
    name: "capturar_tela",
    description: "Tira print da tela da maquina e manda a imagem para a CONVERSA (o dono ve e baixa). Windows: tela 1..4. Linux: precisa de sessao grafica (import/gnome-screenshot/scrot).",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      tela: { type: "integer", description: "monitor (1 = principal; padrao 1)" },
      tenant: { type: "string", description: "so operador" } }, required: ["host"] },
  },
  {
    name: "baixar_arquivo",
    description: "Traz um arquivo da maquina para a conversa (qualquer tipo, ate 10GB — v3.45 envia em blocos de 32MB com retomada): o dono ve/baixa no chat, video toca e download retoma. Usa canal binario, nao base64 no prompt.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      caminho: { type: "string" },
      nome: { type: "string", description: "nome mostrado (padrao = nome do arquivo)" },
      mime: { type: "string", description: "opcional; inferido pela extensao" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "caminho"] },
  },
  {
    name: "copiar_arquivo",
    description: "Copia um arquivo de UMA maquina para OUTRA (ate 10GB — v3.45: origem envia em blocos e destino baixa por stream): a origem envia ao servidor e o destino baixa. Reenvio do mesmo arquivo retoma de onde parou.",
    inputSchema: { type: "object", properties: {
      host: { type: "string", description: "maquina de ORIGEM" },
      origem: { type: "string", description: "caminho na origem" },
      host_destino: { type: "string", description: "maquina de DESTINO" },
      destino: { type: "string", description: "caminho no destino (padrao = mesmo da origem)" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "origem", "host_destino"] },
  },
  {
    name: "enviar_para_maquina",
    description: "Manda um arquivo que já está no servidor (anexo da conversa, enviado pelo navegador ou por outra máquina) para uma MAQUINA, até 10GB: o destino baixa por stream, retoma de onde parou e confere o sha256. Sem `destino`, cai em Downloads da máquina.",
    inputSchema: { type: "object", properties: {
      host: { type: "string", description: "maquina de DESTINO" },
      anexo_id: { type: "string", description: "id do anexo (veio de baixar_arquivo ou do upload do navegador)" },
      destino: { type: "string", description: "caminho completo no destino (padrao: Downloads/<nome>)" },
      conferir: { type: "boolean", description: "confere sha256 no destino (padrao true)" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "anexo_id"] },
  },
  {
    name: "buscar_arquivos",
    description: "Busca arquivos no disco da maquina: por nome (glob, recursivo) e/ou conteudo (texto fixo).",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      raiz: { type: "string", description: "onde procurar (ex.: C:\\\\ ou /opt)" },
      nome: { type: "string", description: "glob de nome (ex.: *.log)" },
      conteudo: { type: "string", description: "texto fixo dentro dos arquivos" },
      max_resultados: { type: "integer", description: "padrao 200, max 1000" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "raiz"] },
  },
  {
    name: "grep_remoto",
    description: "Busca CONTEUDO em arquivos com linhas e contexto: 'caminho:linha: texto'. RAIZ ESTREITA obrigatoria. Glob filtra; regex opcional; padrao e texto fixo.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      raiz: { type: "string", description: "pasta estreita (ex.: C:\\\\logs\\\\hoje)" },
      padrao: { type: "string" },
      glob: { type: "string", description: "filtro de nome (padrao *)" },
      contexto: { type: "integer", description: "linhas antes/depois (0-10)" },
      regex: { type: "boolean" },
      ignore_case: { type: "boolean", description: "padrao true" },
      max_resultados: { type: "integer", description: "padrao 100, max 1000" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "raiz", "padrao"] },
  },
  {
    name: "editar_no_local",
    description: "EDICAO de arquivo na maquina: busca EXATA unica (0 ocorrencias = erro, >1 sem replace_all = erro); troca texto utf-8 ate 16MB; recusa binario; casa LF->CRLF e avisa; seca=true previsualiza sem gravar.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      caminho: { type: "string" },
      busca: { type: "string", description: "texto exato unico (ou replace_all)" },
      substituicao: { type: "string", description: "texto novo (vazio = apagar)" },
      replace_all: { type: "boolean" },
      seca: { type: "boolean", description: "so mostra, nao grava" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "caminho", "busca", "substituicao"] },
  },
  {
    name: "estado_maquina",
    description: "Diagnostico num disparo: SO, uptime, RAM, CPU%, disco por unidade (Linux: load). Antes de culpar a ferramenta por escrita falha, veja o disco.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      tenant: { type: "string", description: "so operador" } }, required: ["host"] },
  },
  {
    name: "processos",
    description: "Processos: listar top por memoria (PID MEM CPU APP TITULO); matar encerra por nome exato, por PID ou por PORTA em escuta (Stop-Process/pkill) e diz quantos.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      acao: { type: "string", enum: ["listar", "matar"] },
      nome: { type: "string", description: "para matar: nome sem .exe" },
      pid: { type: "integer", description: "para matar: PID exato (alternativa a nome/porta)" },
      porta: { type: "integer", description: "para matar: quem estiver escutando nesta porta TCP" },
      top: { type: "integer", description: "padrao 15, max 100" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "acao"] },
  },
  {
    name: "metricas",
    description: "Retrato completo da maquina em UM comando: CPU%, RAM usada/total, uptime, disco por unidade, top 5 processos por memoria e GPU (VRAM, uso e temperatura quando houver nvidia-smi). Use no lugar de estado_maquina + processos + nvidia-smi.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      tenant: { type: "string", description: "so operador" } }, required: ["host"] },
  },
  {
    name: "janelas",
    description: "Janelas visiveis da maquina (Windows): listar devolve 'PID APP TITULO'; focar traz a janela cujo titulo contem 'titulo'. Mire por NOME, nunca por coordenada chutada.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      acao: { type: "string", enum: ["listar", "focar"] },
      titulo: { type: "string", description: "para focar: substring do titulo" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "acao"] },
  },
  {
    name: "area_transferencia",
    description: "Le (get) ou escreve (set) a area de transferencia da maquina. set pisa o que estava. Linux precisa xclip. Windows: se a sessao remota travar o clipboard, responde 422 dizendo que foi bloqueado.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      acao: { type: "string", enum: ["get", "set"] },
      texto: { type: "string", description: "para set" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "acao"] },
  },
  {
    name: "falar",
    description: "Sintetizador de voz da maquina fala o texto nos alto-falantes (recado sonoro). Bloqueia a fila do host ate terminar. Max 600 chars.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      texto: { type: "string" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "texto"] },
  },
  {
    name: "abrir",
    description: "Abre algo NA maquina como duplo clique: URL (navegador padrao), pasta (Explorador) ou caminho de programa. Nao espera terminar.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      alvo: { type: "string", description: "URL, pasta ou exe" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "alvo"] },
  },
  {
    name: "servicos",
    description: "Servicos Windows (systemctl no Linux): listar (glob, max N) ou start/stop/restart por nome exato. Costumam exigir admin; sem privilegio o erro vem honesto.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      acao: { type: "string", enum: ["listar", "start", "stop", "restart"] },
      nome: { type: "string" },
      filtro: { type: "string", description: "para listar: glob (padrao *)" },
      max_resultados: { type: "integer", description: "padrao 30, max 200" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "acao"] },
  },
  {
    name: "eventos",
    description: "Event log da maquina (Application+System; journalctl -p err no Linux): erros/crashes/reboots das ultimas N horas, primeira linha de cada mensagem.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      horas: { type: "integer", description: "janela (padrao 24, max 168)" },
      nivel: { type: "string", enum: ["erro", "qualquer"] },
      max_resultados: { type: "integer", description: "padrao 15, max 100" },
      tenant: { type: "string", description: "so operador" } }, required: ["host"] },
  },
  {
    name: "rede",
    description: "Rede VISTA DA MAQUINA: ping (4 probes), dns, tracado, portas (TCP em escuta com dono), espera_porta (bloqueia ate a porta abrir) ou info (IPs/gateway/DNS proprios).",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      acao: { type: "string", enum: ["ping", "dns", "tracado", "portas", "espera_porta", "info"] },
      alvo: { type: "string", description: "host/URL; em espera_porta: a porta (ex.: 5173); em info: filtra as linhas por IP, interface, gateway ou DNS" },
      timeout: { type: "integer", description: "espera_porta: segundos (padrao 30, max 900)" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "acao"] },
  },
  {
    name: "esperar_arquivo",
    description: "Bloqueia (poll 700ms) ate existir arquivo novo na pasta da maquina; devolve caminho+bytes+hora. Ideal p/ aguardar XML cair na caixa; depois leia com ler_arquivo. Max 900s.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      pasta: { type: "string" },
      padrao: { type: "string", description: "glob (padrao *)" },
      timeout: { type: "integer", description: "padrao 60, max 900" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "pasta"] },
  },
  {
    name: "power",
    description: "Energia da maquina — POR PADRAO RECUSA: exige confirmar=true. acoes: lock (seguro), logout (derruba trabalho aberto!), restart, shutdown. SEM autostart: maquina desligada fica offline ate alguem reabrir o cliente.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      acao: { type: "string", enum: ["lock", "logout", "restart", "shutdown"] },
      confirmar: { type: "boolean", description: "true = ciente do efeito" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "acao"] },
  },
  {
    name: "rodar_lote",
    description: "VARIOS comandos numa so ida ao host (economiza roundtrips): sequencia, cada um com exit proprio — falha de um nao impede o proximo. Blocos '### N exit=X'. Max 20 comandos, teto 900s, 4000 chars de texto no lote (o envelope codificado nao conta).",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      comandos: { type: "array", items: { type: "string" }, description: "1 a 20 linhas" },
      timeout: { type: "integer", description: "segundos para o lote inteiro; padrao 120, max 900" },
      sessao: { type: "string", description: "roda tudo na pasta da sessao" },
      env: { type: "object", description: "variaveis para todos do lote" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "comandos"] },
  },
  {
    name: "sessao",
    description: "Memoria de pasta por maquina (no servidor): abrir fixa nome->diretorio existente; rodar_comando/rodar_lote com sessao='nome' rodam la dentro. listar mostra; fechar remove. Vive enquanto o servidor estiver de pe.",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      acao: { type: "string", enum: ["abrir", "listar", "fechar"] },
      nome: { type: "string", description: "id da sessao (padrao: padrao)" },
      pasta: { type: "string", description: "abrir: diretorio que ja existe" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "acao"] },
  },
  {
    name: "git_remoto",
    description: "Git numa pasta da maquina remota com saida estruturada: status, diff, log, branches. ESCRITA GATEADA: add aceita path; commit/push/checkout exigem confirmar=true (governanca).",
    inputSchema: { type: "object", properties: {
      host: { type: "string" },
      repo: { type: "string", description: "caminho do repositorio na maquina" },
      acao: { type: "string", enum: ["status", "diff", "log", "branches", "add", "commit", "push", "checkout"] },
      path: { type: "string" },
      mensagem: { type: "string" },
      ref: { type: "string", description: "checkout: branch; log: quantos" },
      confirmar: { type: "boolean", description: "obrigatorio true em commit/push/checkout" },
      tenant: { type: "string", description: "so operador" } }, required: ["host", "repo", "acao"] },
  },
];

const eDaMaquinas = (n: string): boolean => eDeMaquina(n);

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const falha = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const toolOk = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  isError: false,
});
const toolErro = (text: string) => ({ content: [{ type: "text", text }], isError: true });

function initialize(params: Row) {
  const pedido = params.protocolVersion as string | undefined;
  const versao = pedido && PROTOCOLOS.includes(pedido) ? pedido : PROTOCOLOS[0];
  return {
    protocolVersion: versao,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions:
      "RAG semantico multi-tenant com processador de documentos. Tools: search (busca), " +
      "ingest (texto na fila), ingest_status (progresso), list_docs, delete_doc, health, " +
      "upload_file (pdf/docx/xlsx/csv/html/txt/md em base64), get_file (original guardado), " +
      "edit_doc (edita texto e reindexa), rename_doc (renomeia/move/titulo), archive_doc, " +
      "list_gavetas, create_gaveta, delete_gaveta, list_jobs, chat (usa as ferramentas ligadas), " +
      "listar_usuarios e criar_usuario (operador), config_provider (provider do chat), " +
      "listar_mcp e gerir_mcp (servidores MCP que dão ferramentas ao chat), " +
      "web_search (busca na internet) e web_open (texto de uma página).",
  };
}

type Row = Record<string, any>;

/** v3.41 — imagem → texto por OCR local. A visao de verdade (modelo olhando) acontece
 *  quando a pessoa cola a imagem no chat; aqui o alvo e extrair texto de print/foto. */
async function analisarImagem(args: Row) {
  if (!ocrDisponivel()) throw new Error("OCR fora do ar no servidor (o mesmo servico do embedder)");
  const url = String(args.url ?? "").trim();
  const b64Cru = String(args.base64 ?? "").trim();
  let buf: Buffer;
  let origem: string;
  if (url) {
    if (!/^https?:\/\//i.test(url)) throw new Error("url precisa ser http(s)");
    buf = (await baixarImagem(url)).buffer;
    origem = url;
  } else if (b64Cru) {
    buf = Buffer.from(b64Cru.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, ""), "base64");
    if (!buf.length) throw new Error("base64 invalido");
    origem = "base64";
  } else {
    throw new Error("passe url ou base64");
  }
  if (buf.length > 8 * 1024 * 1024)
    throw new Error(`imagem de ${(buf.length / 1024 / 1024).toFixed(1)}MB passa do teto de 8MB`);
  const r = await ocrImagem(buf);
  return {
    ok: true, origem, bytes: buf.length, motor: r.motor, paginas: r.paginas, ms: r.ms,
    chars: r.texto.length, texto: r.texto.slice(0, 20000),
  };
}

async function executarTool(
  name: string,
  args: Row,
  user: Usuario,
  deps: { health: () => unknown },
) {
  switch (name) {
    case "rodar_python": {
      if (!user.operador) throw erro403("somente o operador pode rodar scripts");
      const codigo = String(args.codigo ?? "");
      if (!codigo.trim()) throw new Error("parametros invalidos: campo obrigatorio: codigo");
      const { rodarPython } = await import("./sandbox");
      return rodarPython(codigo, user, {
        segundos: args.segundos === undefined ? undefined : Number(args.segundos),
        dependencias: args.dependencias,
      });
    }
    case "health":
      return deps.health();
    case "analisar_imagem":
      return analisarImagem(args);
    case "mostrar_tela":
      /* valida e normaliza; a camada do chat (ferramentas.ts) lê o HTML por fora do texto */
      return montarTela({ titulo: args.titulo, html: args.html });
    case "web_search":
      return buscarWeb({
        query: String(args.query ?? ""),
        k: args.k === undefined ? undefined : Number(args.k),
        site: args.site === undefined ? undefined : String(args.site),
      });
    case "web_open":
      return abrirPagina(String(args.url ?? ""), { js: args.js === true });
    case "search":
      if (typeof args.query !== "string" || !args.query.trim()) {
        throw new Error("parametros invalidos: campo obrigatorio: query");
      }
      return search(args as never, user);
    case "ingest":
      if (typeof args.doc_id !== "string" || typeof args.content !== "string") {
        throw new Error("parametros invalidos: doc_id e content sao obrigatorios");
      }
      return enqueueIngest(args as never, user.tenant);
    case "ingest_status": {
      /* v3.54: sem job_id o Number(vazio) virava NaN e o erro saía do Postgres
         ("invalid input syntax for type bigint") — valida antes. */
      const bruto = args.job_id;
      const jobId = Number(bruto);
      if (
        bruto === undefined || bruto === null || String(bruto).trim() === "" ||
        !Number.isInteger(jobId) || jobId <= 0
      ) {
        throw new HttpError(422, "ingest_status: job_id obrigatorio (inteiro positivo) — veja o id em list_jobs");
      }
      return jobParaUsuario(jobId, user, undefined);
    }
    case "list_docs":
      return listDocs(
        { memoria: args.memoria ?? "", include_archived: Boolean(args.include_archived) },
        user,
      );
    case "list_anexos":
      return listarAnexos(user, { q: String(args.q ?? ""), limit: Number(args.limit ?? 50) });
    case "delete_doc":
      return deleteDoc(args.doc_id, args.memoria ?? "", args.tenant ?? null, user);
    case "upload_file": {
      if (typeof args.nome !== "string" || typeof args.conteudo_base64 !== "string") {
        throw new Error("parametros invalidos: nome e conteudo_base64 sao obrigatorios");
      }
      const b64 = args.conteudo_base64.replace(/^data:[^;]+;base64,/, "");
      if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new Error("conteudo_base64 invalido");
      const buf = Buffer.from(b64, "base64");
      if (!buf.length) throw new Error("conteudo_base64 vazio");
      const enviado = await uploadArquivo(
        {
          nome: args.nome,
          mime: args.mime ?? null,
          conteudo: buf,
          memoria: args.memoria ?? "",
          tenant: args.tenant ?? null,
          doc_id: args.doc_id ?? null,
          title: args.title ?? null,
        },
        user,
      );
      /* v3.54: o mesmo arquivo também vira ANEXO (canal navegador→máquina).
         Antes só existia como documento e enviar_para_maquina não tinha id. */
      const anexo = await criarAnexo(user, buf, {
        nome: String(args.nome),
        mime: args.mime ? String(args.mime) : undefined,
        tenant: args.tenant ? String(args.tenant) : undefined,
      });
      return { ...enviado, anexo_id: anexo.id, anexo };
    }
    case "get_file": {
      const a = await getArquivoOriginal(args.doc_id, args.memoria ?? "", args.tenant ?? null, user);
      return {
        doc_id: args.doc_id,
        nome: a.nome,
        mime: a.mime,
        tipo: a.tipo,
        tamanho: a.tamanho,
        conteudo_base64: Buffer.from(a.conteudo).toString("base64"),
      };
    }
    case "edit_doc":
      return putDocument(
        args.doc_id,
        {
          content: args.content,
          title: args.title ?? null,
          memoria: args.memoria ?? "",
          tenant: args.tenant ?? null,
        },
        user,
      );
    case "rename_doc":
      return patchDocument(
        args.doc_id,
        {
          novo_doc_id: args.novo_doc_id ?? null,
          title: args.title,
          destino_memoria: args.destino_memoria ?? null,
          tenant: args.tenant ?? null,
        },
        args.memoria ?? "",
        user,
      );
    case "archive_doc":
      return patchArquivado(
        args.doc_id,
        Boolean(args.arquivado),
        args.memoria ?? "",
        args.tenant ?? null,
        user,
      );
    case "list_gavetas":
      return listGavetas(user, args.tenant ?? undefined);
    case "create_gaveta":
      return criarGaveta(tenantFor(user, args.tenant ?? null), args.memoria);
    case "delete_gaveta":
      return deleteGaveta(args.memoria, args.tenant ?? null, user);
    case "chat":
      if (typeof args.pergunta !== "string" || !args.pergunta.trim()) {
        throw new Error("parametros invalidos: campo obrigatorio: pergunta");
      }
      return responderChat(user, {
        pergunta: args.pergunta,
        memoria: args.memoria ?? "",
        tenant: args.tenant ?? null,
      });
    case "listar_usuarios":
      exigirOperador(user);
      return { usuarios: await listarUsuarios() };
    case "criar_usuario":
      exigirOperador(user);
      if (typeof args.nome !== "string") throw new Error("parametros invalidos: campo obrigatorio: nome");
      return criarUsuario(args.nome, args.papel);
    case "apagar_usuario":
      exigirOperador(user);
      if (typeof args.nome !== "string") throw new Error("parametros invalidos: campo obrigatorio: nome");
      return removerUsuario(args.nome);
    case "esquecimento": {
      exigirOperador(user);
      const acao = String(args.acao ?? "ver");
      if (acao === "ver") return lerEsquecimento();
      if (acao === "definir") return escreverEsquecimento(args);
      throw new Error("acao invalida: use ver | definir");
    }
    case "config_provider": {
      const acao = String(args.acao ?? "ver");
      if (acao === "ver") return verProvider(user, args.tenant ?? null);
      if (acao === "salvar") return salvarProvider(user, args);
      if (acao === "testar") return testarProvider(user, args);
      throw new Error("acao invalida: use ver | salvar | testar");
    }
    case "listar_mcp":
      return { servidores: await listarServidores() };
    case "gerir_mcp": {
      exigirOperador(user);
      const acao = String(args.acao ?? "");
      if (acao === "criar") return criarServidor(args);
      if (acao === "atualizar") return atualizarServidor(String(args.nome ?? ""), args);
      if (acao === "apagar") return apagarServidor(String(args.nome ?? ""));
      if (acao === "testar") return atualizarFerramentas(String(args.nome ?? ""), user);
      throw new Error("acao invalida: use criar | atualizar | apagar | testar");
    }
    case "list_jobs":
      return listJobs(
        {
          status: args.status ?? undefined,
          tenant: args.tenant ?? null,
          limit: args.limit === undefined ? undefined : Number(args.limit),
        },
        user,
      );
    case "gerar_pareamento":
      return criarPareamento(user, alvoMaquina(user, args.tenant), String(args.nome ?? ""));
    case "maquinas_online": {
      const alvo = user.operador ? String(args.tenant ?? "").trim() || null : user.tenant;
      return listarMaquinas(alvo);
    }
    case "rodar_comando": {
      const cmdEnrolado = await wrapComando(user, args, String(args.cmd ?? ""));
      return rodar(
        user,
        alvoMaquina(user, args.tenant),
        String(args.host ?? ""),
        cmdEnrolado,
        args.timeout === undefined || args.timeout === null ? undefined : Number(args.timeout),
        "mcp",
        20000,
        args.background === true,
      );
    }
    default:
      if ((NOMES_MAQUINA_TOOLS as readonly string[]).includes(name)) return toolMaquina(user, name, args, "mcp");
      throw new Error(`tool desconhecida: ${name}`);
  }
}

export type McpDeps = {
  health: () => unknown;
  autenticar: () => Usuario; // lança HttpError 401/429
};

/** Resposta com status HTTP próprio (auth falhou = 401, não 200). */
type RespostaHttp = { httpStatus: number; body: unknown };
const comStatus = (httpStatus: number, body: unknown): RespostaHttp => ({ httpStatus, body });
const ehRespostaHttp = (v: unknown): v is RespostaHttp =>
  typeof v === "object" && v !== null && "httpStatus" in (v as Record<string, unknown>);

/** Despacha uma mensagem JSON-RPC. null = notificação (202 sem corpo). */
export async function despachar(msg: any, deps: McpDeps): Promise<unknown | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return falha(msg && typeof msg === "object" ? msg.id : null, -32600, "requisicao JSON-RPC 2.0 invalida");
  }
  const { method, id } = msg;
  const params: Row = msg.params ?? {};

  if (method.startsWith("notifications/")) return null;
  if (method === "initialize") return ok(id, initialize(params));
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") {
    /* v3.36: a lista agora diz a verdade da CONTA, não só a do servidor — sai o que o papel
       não alcança, o que o controle de máquinas desligou e o que o próprio usuário desligou. */
    let user: Usuario;
    try {
      user = deps.autenticar();
    } catch (e) {
      const err = e as HttpError;
      return comStatus(err.status ?? 401, falha(id, -32001, err.detail ?? String(e)));
    }
    const visiveis = TOOLS.filter((t) => ferramentaPermitida(user.tenant, user.operador, t.name));
    return ok(id, { tools: visiveis });
  }

  if (method === "tools/call") {
    let user: Usuario;
    try {
      user = deps.autenticar();
    } catch (e) {
      const err = e as HttpError;
      return comStatus(err.status ?? 401, falha(id, -32001, err.detail ?? String(e)));
    }
    /* v3.36: a recusa daqui é só das duas camadas NOVAS (interruptor do admin e a lista do
       próprio usuário). Papel e controle de máquinas continuam recusando dentro da ferramenta,
       com a frase de sempre (o gate único não se duplica). */
    const motivo = motivoDeBloqueio(user.tenant, user.operador, String(params.name ?? ""));
    if (motivo === "desligada" || motivo === "servidor_desligado") {
      const frase =
        motivo === "servidor_desligado"
          ? "o uso do MCP está desligado para contas comuns; fale com o operador"
          : "esta ferramenta está desligada na sua tela MCP";
      return comStatus(403, falha(id, -32001, frase));
    }
    try {
      const resultado = await executarTool(params.name, params.arguments ?? {}, user, deps);
      return ok(id, toolOk(resultado));
    } catch (e) {
      if (e instanceof HttpError) return ok(id, toolErro(`erro ${e.status}: ${e.detail}`));
      return ok(id, toolErro(String((e as Error).message ?? e)));
    }
  }
  return falha(id, -32601, `metodo nao suportado: ${method}`);
}

/** POST /mcp — uma mensagem ou lote; resposta JSON pura. */
export async function mcpHandler(corpo: any, deps: McpDeps) {
  if (Array.isArray(corpo)) {
    const respostas: unknown[] = [];
    let status = 200;
    for (const item of corpo) {
      const r = await despachar(item, deps);
      if (r === null) continue;
      if (ehRespostaHttp(r)) {
        status = r.httpStatus;
        respostas.push(r.body);
      } else {
        respostas.push(r);
      }
    }
    return respostas.length ? { status, body: respostas } : { status: 202, body: null };
  }
  const r = await despachar(corpo, deps);
  if (r === null) return { status: 202, body: null };
  if (ehRespostaHttp(r)) return { status: r.httpStatus, body: r.body };
  return { status: 200, body: r };
}