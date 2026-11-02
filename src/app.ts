/** Fastify: rotas REST, MCP, painel estático e /health. */
import fs from "node:fs";
import path from "node:path";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CONFIG, tenantFor } from "./config";
import {
  alvoMaquina,
  apagarMaquina,
  controleDeMaquinaAtivo,
  criarPareamento,
  criarRecebimento, consumirRecebimento,
  gerarClienteBinario, emitirBilheteCliente, resgatarBilheteCliente,
  revogarChaveCliente,
  gravarControleDeMaquina,
  listarLog,
  listarMaquinas,
  mudarMaquina,
  rodar,
} from "./maquinas";
import { consumirUpload, consumirUploadDeArquivo } from "./maquinas_tools";
import { abrirAnexo, abrirEnvio, apagarAnexoDe, conferirChave, estadoDoEnvio, gravarBloco, listarAnexos } from "./anexos";
import { HttpError, iso } from "./errors";
import { authenticate, ipCliente } from "./auth";
import { embedderDim, embedderDisponivel } from "./embed";
import { detectarOcr, ocrDisponivel } from "./ocr";
import { enqueueIngest, IngestBody } from "./ingest";
import { runDecay } from "./decay";
import { faxina } from "./faxina";
import { escreverEsquecimento } from "./esquecimento";
import {
  atualizarFerramentas,
  atualizarServidor,
  apagarServidor,
  criarServidor,
  definirHealth,
  listarServidores,
} from "./ferramentas";
import { mcpHandler, TOOLS } from "./mcp";
import {
  ajustavelPeloUsuario,
  gravarMcpLiberadoParaTodos,
  gravarPermissao,
  grupoDaFerramenta,
  mcpLiberadoParaTodos,
  motivoDeBloqueio,
} from "./mcp_acesso";
import { contarUso, configPublica, dadosPainel } from "./dashboard";
import {
  atualizarUsuario,
  criarUsuario,
  exigirOperador,
  listarUsuarios,
  nomesOperadores,
  nomesUsuarios,
  novaChaveUsuario,
  removerUsuario,
} from "./usuarios";
import {
  buscarMensagensChat,
  cortarParaReenviar,
  historicoChat,
  limparChat,
  responderChat,
  truncarParaRegenerar,
  salvarProvider,
  salvarInstrucoes,
  testarProvider,
  verProvider,
} from "./provider";
import {
  listarProvedores,
  salvarProvedor,
  definirPadrao,
  apagarProvedor,
  provarModelos,
} from "./provedores";
import { assinarTarefa, criarTarefa, cancelarTarefa, enfileirarFala, listarTarefas, notificarTarefa, rodarTarefa, verTarefa } from "./tarefa";
import multipart from "@fastify/multipart";
import { LIMITE_BYTES } from "./conversor";
import {
  cancelJob,
  deleteDoc,
  deleteGaveta,
  exportGaveta,
  getArquivoOriginal,
  getDocument,
  jobParaUsuario,
  listDocs,
  criarGaveta,
  atualizarGavetaMeta,
  listGavetas,
  listJobs,
  nomeArquivo,
  patchArquivado,
  patchDocument,
  putDocument,
  retryJob,
  search,
  uploadArquivo,
} from "./service";

/* --------------------------------------------------------------- validação */

function vString(v: unknown, campo: string, opts: {
  obrigatorio?: boolean; min?: number; max?: number; def?: string;
} = {}): string {
  if (v === undefined || v === null) {
    if (opts.obrigatorio) throw new HttpError(422, `campo obrigatorio: ${campo}`);
    return opts.def ?? "";
  }
  if (typeof v !== "string") throw new HttpError(422, `${campo} deve ser texto`);
  if (opts.min !== undefined && v.length < opts.min) {
    throw new HttpError(422, `${campo}: minimo de ${opts.min} caractere(s)`);
  }
  if (opts.max !== undefined && v.length > opts.max) {
    throw new HttpError(422, `${campo}: maximo de ${opts.max} caracteres`);
  }
  return v;
}

function vInt(v: unknown, campo: string, def: number, min: number, max: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new HttpError(422, `${campo} deve ser inteiro`);
  if (n < min || n > max) throw new HttpError(422, `${campo} deve estar entre ${min} e ${max}`);
  return n;
}

function vFloat(v: unknown, campo: string, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(422, `${campo} deve estar entre 0 e 1`);
  return n;
}

function vBool(v: unknown, def = false): boolean {
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "boolean") return v;
  return ["1", "true", "sim", "yes", "on"].includes(String(v).trim().toLowerCase());
}

function corpo(req: FastifyRequest): Record<string, any> {
  const b = req.body;
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new HttpError(422, "corpo deve ser um objeto JSON");
  }
  return b as Record<string, any>;
}

/* ------------------------------------------------------------------- app */

export function criarApp(): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(4 * 1024 * 1024, CONFIG.maxContentChars * 3),
    trustProxy: true,
  });

  /* v3.45: o corpo binário chega como STREAM (nunca vira Buffer gigante na RAM).
     É o que permite mandar 10 GB em blocos: o bloco é escrito no disco enquanto
     chega, com pressão de retorno (pipeline), e a memória fica em poucos MB. */
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ detail: err.detail });
    }
    const status = (err as any).statusCode;
    if (status === 413) {
      return reply.code(413).send({ detail: "corpo maior que o limite do servidor" });
    }
    if (status && status < 500) {
      return reply.code(status).send({ detail: (err as Error).message });
    }
    if ((err as any).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.code(400).send({ detail: "corpo nao e JSON valido" });
    }
    process.stdout.write(`[nexos] erro ${req.method} ${req.url}: ${(err as Error).stack}\n`);
    return reply.code(500).send({ detail: "erro interno" });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ detail: "Not Found" });
  });

  // CORS (mesmas origens configuradas da v1.x)
  app.addHook("onRequest", async (req, reply) => {
    const origem = req.headers.origin;
    if (origem && CONFIG.corsOrigins.includes(origem)) {
      reply.header("access-control-allow-origin", origem);
      reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
      reply.header("access-control-allow-headers", "Authorization, Content-Type");
      reply.header("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  /* upload de arquivo: multipart só na rota /arquivos (teto = 15 MB do conversor) */
  void app.register(multipart, { limits: { fileSize: LIMITE_BYTES, files: 1, fields: 10 } });

  const ip = (req: FastifyRequest) =>
    ipCliente(req.headers as Record<string, unknown>, req.ip ?? "?");

  const usuario = (req: FastifyRequest) =>
    authenticate(req.headers.authorization, ip(req));

  const health = () => ({
    status: "ok",
    dim: embedderDim(),
    usuarios: nomesUsuarios().length,
    operador: nomesOperadores().length > 0,
    versao: CONFIG.versao,
    embedder: embedderDisponivel() ? "ok" : "fora",
    ocr: ocrDisponivel() === null ? "?" : ocrDisponivel() ? "ok" : "fora",
  });

  /* ------------------------------------------------------------- básicas */

  definirHealth(health); // ferramenta interna do chat usa o mesmo health da rota
  app.get("/health", async () => health());

  /* v3.27 (dono, 27/10): a SPA passou a ser servida na RAIZ e a tela mora no hash
     (#/chat, #/painel, #/buscar...). Antes a raiz pulava para /painel/ e o endereço
     ficava /painel/ mesmo mostrando o Chat — a URL mentia sobre a tela. Os assets
     continuam em /painel/assets (base fixa do vite), que funciona de qualquer path. */
  app.get("/", async (_req, reply) => {
    const arquivo = path.join(CONFIG.painelDir, "index.html");
    if (!fs.existsSync(arquivo)) return reply.code(404).send({ detail: "Not Found" });
    return reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      /* v3.65 — o HTML manda na versão: sem cache-control o navegador guardava o index
         por heurística e o celular continuava rodando o pacote antigo depois do deploy
         (foi assim que uma correção publicada pareceu não ter entrado). */
      .header("cache-control", "no-cache, must-revalidate")
      .send(fs.createReadStream(arquivo));
  });

  /* -------------------------------------------------------------- ingest */

  app.post("/ingest", async (req, reply) => {
    const u = usuario(req);
    const b = corpo(req);
    const body: IngestBody = {
      doc_id: vString(b.doc_id, "doc_id", { obrigatorio: true, min: 1, max: 500 }),
      title: b.title === undefined || b.title === null ? null : vString(b.title, "title", { max: 500 }),
      content: vString(b.content, "content", {
        obrigatorio: true, min: 1, max: CONFIG.maxContentChars,
      }),
      memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
      tenant: b.tenant ?? null,
    };
    const r = await enqueueIngest(body, (await import("./config")).tenantFor(u, b.tenant as string));
    return reply.code(202).send(r);
  });

  /* ------------------------------------------------------ arquivo original */

  /** POST /arquivos (multipart, campo "arquivo"): guarda o original, converte e enfileira. */
  app.post("/arquivos", async (req, reply) => {
    const u = usuario(req);
    if (!req.isMultipart()) {
      throw new HttpError(422, "envie como multipart/form-data no campo 'arquivo' (ou use POST /ingest com texto)");
    }
    const campos: Record<string, string> = {};
    let enviado: { nome: string; mime: string; buf: Buffer } | null = null;
    try {
      for await (const parte of req.parts()) {
        if (parte.type === "file") {
          if (enviado) {
            await parte.toBuffer(); // segundo arquivo: descarta (1 por request)
            continue;
          }
          const pedacos: Buffer[] = [];
          for await (const pedaco of parte.file) pedacos.push(pedaco as Buffer);
          enviado = {
            nome: (parte.filename ?? "").trim(),
            mime: parte.mimetype ?? "",
            buf: Buffer.concat(pedacos),
          };
        } else if (typeof parte.value === "string") {
          campos[parte.fieldname] = parte.value;
        }
      }
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
        throw new HttpError(413, `arquivo maior que ${Math.round(LIMITE_BYTES / 1024 / 1024)} MB`);
      }
      throw e;
    }
    if (!enviado) throw new HttpError(422, "nenhum arquivo recebido no campo 'arquivo'");
    if (!enviado.nome) throw new HttpError(422, "arquivo sem nome — envie com o nome do arquivo");

    const r = await uploadArquivo(
      {
        nome: enviado.nome,
        mime: enviado.mime,
        conteudo: enviado.buf,
        memoria: campos.memoria ?? "",
        tenant: campos.tenant ?? null,
        doc_id: campos.doc_id ?? null,
        title: campos.title ?? null,
      },
      u,
    );
    return reply.code(r.substituiu ? 200 : 201).send(r);
  });

  app.get("/ingest/:jobId", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const qs = req.query as Record<string, string>;
    return jobParaUsuario(Number(p.jobId), u, qs.tenant ?? "");
  });

  /* -------------------------------------------------------------- search */

  app.post("/search", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    const body = {
      query: vString(b.query, "query", { obrigatorio: true, min: 1, max: CONFIG.maxQueryChars }),
      k: vInt(b.k, "k", CONFIG.topK, 1, 50),
      min_score: vFloat(b.min_score, "min_score", CONFIG.minScore),
      memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
      include_archived: vBool(b.include_archived),
      tenant: b.tenant ?? null,
    };
    const r = await search(body, u);
    if (r.total) void contarUso("buscas");
    return r;
  });

  /* ---------------------------------------------------------------- docs */

  app.get("/docs", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return listDocs(
      {
        memoria: s.memoria ?? "",
        include_archived: vBool(s.include_archived),
        tenant: s.tenant ?? "",
        q: s.q ?? "",
        limit: s.limit ? Number(s.limit) : 0,
        offset: s.offset ? Number(s.offset) : 0,
      },
      u,
    );
  });

  app.delete("/docs/:docId", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return deleteDoc(p.docId, s.memoria ?? "", s.tenant ?? "", u);
  });

  /* ----------------------------------------------------------- agregados */

  app.post("/gavetas", async (req, reply) => {
    const u = usuario(req);
    const b = corpo(req);
    const memoria = vString(b.memoria, "memoria", { obrigatorio: true, min: 1, max: 120 });
    const tenant = tenantFor(u, (b.tenant as string) ?? null);
    return reply.code(201).send(await criarGaveta(tenant, memoria));
  });

  app.get("/gavetas", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return listGavetas(u, s.tenant ?? "");
  });

  /** v3.18 (T015/T019): metadados da gaveta — renomear, fixar, arquivar. */
  app.put("/gavetas/meta", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    return atualizarGavetaMeta(u, {
      memoria: vString(b.memoria, "memoria", { obrigatorio: true, max: 128 }),
      tenant: b.tenant ?? null,
      titulo: typeof b.titulo === "string" ? b.titulo : undefined,
      fixada: typeof b.fixada === "boolean" ? b.fixada : undefined,
      arquivada: typeof b.arquivada === "boolean" ? b.arquivada : undefined,
    });
  });

  app.get("/jobs", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return listJobs(
      {
        status: s.status ?? "",
        tenant: s.tenant ?? "",
        limit: s.limit ? Number(s.limit) : 50,
      },
      u,
    );
  });

  /* ---------------------------------------------------- gaveta: zip/delete */

  app.get("/gavetas/:memoria/export.zip", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const { buffer, nome } = await exportGaveta(p.memoria, s.tenant ?? "", u);
    return reply
      .code(200)
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${nome}.zip"`)
      .send(buffer);
  });

  app.delete("/gavetas/:memoria", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return deleteGaveta(p.memoria, s.tenant ?? "", u);
  });

  /* ----------------------------------------------------------- documents */

  app.get("/documents/:docId", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return getDocument(p.docId, s.memoria ?? "", s.tenant ?? "", u);
  });

  app.get("/documents/:docId/raw", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const d = await getDocument(p.docId, s.memoria ?? "", s.tenant ?? "", u);
    const nome = nomeArquivo(d.title ?? d.doc_id, "documento");
    return reply
      .code(200)
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${nome}.txt"`)
      .send(d.content);
  });

  app.get("/documents/:docId/arquivo", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const a = await getArquivoOriginal(p.docId, s.memoria ?? "", s.tenant ?? "", u);
    const nome = nomeArquivo(a.nome || p.docId, "documento");
    return reply
      .code(200)
      .header("content-type", a.mime || "application/octet-stream")
      .header("content-disposition", `attachment; filename="${nome}"`)
      .header("content-length", String(a.conteudo.length))
      .send(a.conteudo);
  });

  app.put("/documents/:docId", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const b = corpo(req);
    const r = await putDocument(
      p.docId,
      {
        content: vString(b.content, "content", {
          obrigatorio: true, min: 1, max: CONFIG.maxContentChars,
        }),
        title: b.title === undefined || b.title === null ? null : vString(b.title, "title", { max: 500 }),
        memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
        tenant: b.tenant ?? null,
      },
      u,
    );
    return reply.code(202).send(r);
  });

  app.patch("/documents/:docId/arquivado", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const b = corpo(req);
    if (typeof b.arquivado !== "boolean") throw new HttpError(422, "arquivado deve ser booleano");
    return patchArquivado(p.docId, b.arquivado, s.memoria ?? "", b.tenant ?? null, u);
  });

  app.patch("/documents/:docId", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    const b = corpo(req);
    return patchDocument(
      p.docId,
      {
        title: b.title === undefined || b.title === null ? null : vString(b.title, "title", { max: 500 }),
        novo_doc_id:
          b.novo_doc_id === undefined || b.novo_doc_id === null
            ? null
            : vString(b.novo_doc_id, "novo_doc_id", { max: 200 }),
        destino_memoria:
          b.destino_memoria === undefined || b.destino_memoria === null
            ? null
            : vString(b.destino_memoria, "destino_memoria", { max: 128 }),
        tenant: b.tenant ?? null,
      },
      s.memoria ?? "",
      u,
    );
  });

  /* ---------------------------------------------------------------- jobs */

  app.post("/jobs/:jobId/cancel", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return cancelJob(Number(p.jobId), s.tenant ?? "", u);
  });

  app.post("/jobs/:jobId/retry", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const s = req.query as Record<string, string>;
    return retryJob(Number(p.jobId), s.tenant ?? "", u);
  });

  /* --------------------------------------------------------------- decay */

  app.post("/decay", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    const dias = b.dias === undefined || b.dias === null ? null : vInt(b.dias, "dias", 0, 0, 36500);
    const min = b.min_acessos === undefined || b.min_acessos === null
      ? null
      : vInt(b.min_acessos, "min_acessos", 0, 0, 1_000_000);
    const alvo = (await import("./config")).isOperador(u) ? null : u.tenant;
    const res = await runDecay(dias, min, alvo);
    // v3.5: "forçar agora" também roda a faxina (contas com carência vencida e
    // arquivados mortos pela janela). Mesmo escopo do decay.
    const expurgo = await faxina(alvo);
    return { ...res, expurgo };
  });

  /* ------------------------------------------------------------- maquinas */
  /* v3.6: o túnel absorvido. REST e MCP batem na MESMA função; máquina nasce
     presa ao usuário (comum sempre no próprio; operador mira com ?tenant). */

  /* cliente já com a chave do usuário assada dentro (v3.7): um arquivo, dois cliques */
  app.get("/maquinas/cliente/:plataforma", async (req, reply) => {
    const s = req.params as Record<string, string>;
    const q = req.query as Record<string, string>;
    const plat = s.plataforma === "win" || s.plataforma === "linux" ? s.plataforma : null;
    if (!plat) throw new HttpError(404, "plataforma: win | linux");
    /* v3.10.1: ?bilhete= autoriza UM download por navegação (sem header) — o que
       evita o bloqueio de "download automático" do Edge/Chrome */
    let alvo: string;
    if (q.bilhete) {
      const b = resgatarBilheteCliente(String(q.bilhete));
      if (!b || b.plat !== plat) throw new HttpError(403, "bilhete inválido ou vencido — gere de novo");
      alvo = b.tenant;
    } else {
      alvo = alvoMaquina(usuario(req), q.tenant ?? null);
    }
    const { buf, arquivo } = await gerarClienteBinario(alvo, plat, String(q.nome ?? ""));
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(buf.length))
      .header("content-disposition", `attachment; filename="${arquivo}"`)
      .send(buf);
  });

  /* bilhete para o navegador baixar sem blob (v3.10.1) */
  app.post("/maquinas/cliente/:plataforma/bilhete", async (req) => {
    const u = usuario(req);
    const s = req.params as Record<string, string>;
    const q = req.query as Record<string, string>;
    const plat = s.plataforma === "win" || s.plataforma === "linux" ? s.plataforma : null;
    if (!plat) throw new HttpError(404, "plataforma: win | linux");
    const alvo = alvoMaquina(u, q.tenant ?? null);
    const { bilhete, segundos } = emitirBilheteCliente(alvo, plat);
    return { bilhete, segundos, url: `/maquinas/cliente/${plat}?bilhete=${bilhete}` };
  });

  app.delete("/maquinas/chave/:id", async (req) => {
    const u = usuario(req);
    const s = req.params as Record<string, string>;
    return revogarChaveCliente(u, s.id);
  });

  app.get("/maquinas", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    const alvo = u.operador ? String(s.tenant ?? "").trim() || null : u.tenant;
    return listarMaquinas(alvo);
  });

  app.post("/maquinas", async (req, reply) => {
    const u = usuario(req);
    const b = corpo(req);
    const alvo = alvoMaquina(u, (b.tenant as string) ?? (req.query as Record<string, string>).tenant ?? null);
    return reply.status(201).send(await criarPareamento(u, alvo, String(b.nome ?? "")));
  });

  app.patch("/maquinas/:host", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const alvo = alvoMaquina(u, (req.query as Record<string, string>).tenant ?? null);
    return mudarMaquina(u, alvo, decodeURIComponent(p.host), corpo(req));
  });

  app.delete("/maquinas/:host", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const alvo = alvoMaquina(u, (req.query as Record<string, string>).tenant ?? null);
    return apagarMaquina(alvo, decodeURIComponent(p.host));
  });

  app.post("/maquinas/:host/run", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const b = corpo(req);
    const alvo = alvoMaquina(u, (b.tenant as string) ?? null);
    return rodar(
      u,
      alvo,
      decodeURIComponent(p.host),
      String(b.cmd ?? ""),
      b.timeout === undefined || b.timeout === null ? undefined : Number(b.timeout),
      "rest",
    );
  });

  app.get("/maquinas/log", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    const alvo = u.operador ? String(s.tenant ?? "").trim() || null : u.tenant;
    return listarLog(alvo, s.host ?? null, s.limit === undefined ? 50 : Number(s.limit));
  });

  /* Cliente da máquina (fase 3): o binário é público — não há segredo dentro
     dele; o segredo está no token que o usuário cola ao rodar, e a parede do
     pareamento continua na chave da tela. O auto-update do cliente lê a
     versão daqui e baixa o exe por estas rotas (sem auth, same motivo). */
  const BIN_CLI = process.env.NEXOS_CLIENTE_DIR ?? path.join(process.cwd(), "agente", "bin");
  app.get("/maquina/atualizacao", async () => ({
    versao: CONFIG.versao,
    cliente: {
      win: fs.existsSync(path.join(BIN_CLI, "nexos-cliente-win.exe")) || fs.existsSync(path.join(BIN_CLI, "minirag-cliente-win.exe")),
      linux: fs.existsSync(path.join(BIN_CLI, "nexos-cliente-linux")) || fs.existsSync(path.join(BIN_CLI, "minirag-cliente-linux")),
    },
  }));

  app.get("/maquina/cliente/:plataforma", async (req, reply) => {
    const p = req.params as Record<string, string>;
    const nome =
      p.plataforma === "win" ? "nexos-cliente-win.exe" : p.plataforma === "linux" ? "nexos-cliente-linux" : null;
    if (!nome) throw new HttpError(404, "plataforma: win | linux");
    // v3.47.2: o nome oficial é nexos-*; o antigo continua aceito enquanto houver
    // cliente/roteiro velho apontando para ele.
    const arq = [path.join(BIN_CLI, nome), path.join(BIN_CLI, nome.replace("nexos-cliente", "minirag-cliente"))]
      .find((f) => fs.existsSync(f)) ?? path.join(BIN_CLI, nome);
    if (!fs.existsSync(arq)) throw new HttpError(404, "binário ainda não publicado neste servidor");
    const st = fs.statSync(arq);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(st.size)) // stream cru viria chunked; o HEAD do teste e o navegador pedem tamanho
      .header("content-disposition", `attachment; filename="${nome}"`)
      .send(fs.createReadStream(arq));
  });

  /* Canal one-time de upload (ferramenta escrever_arquivo): os bytes ficam AQUI;
     a maquina-alvo baixa por curl com chave de 5 min casada com o host dela. */
  app.get("/maquina/u", async (req, reply) => {
    const s = req.query as Record<string, string>;
    /* v3.45: upload de ARQUIVO GRANDE — chave aponta para o arquivo no disco e a
       resposta sai por stream (antes era Buffer do Map: só cabia o que a RAM aguentava) */
    const grande = consumirUploadDeArquivo(String(s.k ?? ""), String(s.host ?? ""));
    if (grande) {
      /* v3.46: `Range` para o destino RETOMAR (`curl -C -`) depois de uma queda.
         Sem isso o curl com -C - escreveria o arquivo inteiro em cima do parcial. */
      const faixa = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "").trim());
      if (faixa && grande.bytes > 0) {
        let ini = faixa[1] ? Number(faixa[1]) : 0;
        let fim = faixa[2] ? Number(faixa[2]) : grande.bytes - 1;
        if (!Number.isFinite(ini) || ini < 0) ini = 0;
        if (!Number.isFinite(fim) || fim >= grande.bytes) fim = grande.bytes - 1;
        if (ini > fim) return reply.code(416).header("content-range", `bytes */${grande.bytes}`).send();
        return reply
          .code(206)
          .header("content-type", "application/octet-stream")
          .header("content-length", String(fim - ini + 1))
          .header("content-range", `bytes ${ini}-${fim}/${grande.bytes}`)
          .header("accept-ranges", "bytes")
          .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(grande.nome)}`)
          .send(fs.createReadStream(grande.caminho, { start: ini, end: fim }));
      }
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(grande.bytes))
        .header("accept-ranges", "bytes")
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(grande.nome)}`)
        .send(fs.createReadStream(grande.caminho));
    }
    const dados = consumirUpload(String(s.k ?? ""), String(s.host ?? ""));
    if (!dados) throw new HttpError(404, "chave expirada, ja usada, ou maquina errada");
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(dados.length))
      .send(dados);
  });

  /* canal de VOLTA: a máquina manda o arquivo/print em BLOCOS.
     `id` + `k` vêm assinados pelo SERVIDOR (a ferramenta que dispara o comando
     conhece tenant/host/caminho/tamanho); `offset` diz onde este bloco encaixa.
     Se a conexão cair, o próximo POST com o mesmo id continua do byte atual —
     nada recomeça do zero. Nenhum bloco é bufferizado: `pipeline` escreve no
     disco conforme chega. */
  app.post("/maquina/r", async (req, reply) => {
    const s = req.query as Record<string, string>;
    const id = String(s.id ?? "").slice(0, 64);
    const host = String(s.host ?? "");
    const tenant = String(s.tenant ?? host);
    const offset = Math.max(0, Number(s.offset ?? 0) || 0);
    const total = Math.max(0, Number(s.total ?? 0) || 0);
    if (!id) throw new HttpError(422, "id do envio obrigatorio");
    if (!host) throw new HttpError(422, "host obrigatorio");
    await conferirChave(tenant, host, id, String(s.k ?? ""));

    const corpo = req.body as unknown as NodeJS.ReadableStream | undefined;
    if (!corpo || typeof (corpo as { pipe?: unknown }).pipe !== "function")
      throw new HttpError(422, "corpo binario ausente (content-type application/octet-stream)");

    await abrirEnvio({
      id, tenant, host,
      nome: String(s.nome ?? "arquivo"), mime: s.mime, bytesEsperados: total,
    });
    const r = await gravarBloco(id, offset, corpo as never, total);
    return reply.status(201).send({ id, host, tenant, bytes: r.bytes, completo: r.completo, total });
  });

  /* "de onde eu continuo?" — a máquina pergunta antes de reenviar depois de uma queda */
  app.get("/maquina/r/status", async (req, reply) => {
    const s = req.query as Record<string, string>;
    const id = String(s.id ?? "").slice(0, 64);
    const host = String(s.host ?? "");
    const tenant = String(s.tenant ?? host);
    if (!id || !host) throw new HttpError(422, "id e host obrigatorios");
    await conferirChave(tenant, host, id, String(s.k ?? ""));
    const e = await estadoDoEnvio(id);
    return reply.send({ id, host, tenant, bytes: e.bytes, completo: e.completo, nome: e.nome });
  });

  /* v3.46: o NAVEGADOR manda arquivo grande (botão de anexar do compositor).
     É o MESMO canal de blocos da máquina, mas autenticado pela chave do usuário:
     o tenant vem da sessão, nunca da query. `offset` diz onde o bloco encaixa;
     reenviar o mesmo `id` continua do byte que o servidor já tem (retomada). */
  app.post("/anexos/enviar", async (req, reply) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    const id = String(s.id ?? "").trim().slice(0, 64);
    const offset = Math.max(0, Number(s.offset ?? 0) || 0);
    const total = Math.max(0, Number(s.total ?? 0) || 0);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new HttpError(422, "id do envio invalido");
    const corpo = req.body as unknown as NodeJS.ReadableStream | undefined;
    if (!corpo || typeof (corpo as { pipe?: unknown }).pipe !== "function")
      throw new HttpError(422, "corpo binario ausente (content-type application/octet-stream)");
    await abrirEnvio({
      id, tenant: u.tenant, host: "web",
      nome: String(s.nome ?? "arquivo"), mime: s.mime, bytesEsperados: total,
    });
    const r = await gravarBloco(id, offset, corpo as never, total);
    return reply.status(201).send({ id, bytes: r.bytes, completo: r.completo, total });
  });

  /* "de onde eu continuo?" — o navegador pergunta antes de recomeçar um envio */
  app.get("/anexos/enviar/status", async (req, reply) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    const id = String(s.id ?? "").trim().slice(0, 64);
    if (!id) throw new HttpError(422, "id obrigatorio");
    const e = await estadoDoEnvio(id);
    if (!e.tenant || (e.tenant !== u.tenant && !u.operador))
      return reply.send({ id, bytes: 0, completo: false, nome: "" });
    return reply.send({ id, bytes: e.bytes, completo: e.completo, nome: e.nome });
  });

  /* v3.48 (T050) — a pasta FÍSICA do usuário na tela Arquivos: lista as fichas
     (nome, tamanho, data, máquina de origem) e apaga uma por vez. Operador vê
     todos os usuários e filtra por `tenant`; o comum só enxerga o próprio. */
  app.get("/anexos", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return listarAnexos(u, {
      q: s.q ?? "",
      limit: s.limit ? Number(s.limit) : 50,
      offset: s.offset ? Number(s.offset) : 0,
      tenant: s.tenant ?? "",
    });
  });

  app.delete("/anexos/:id", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    await apagarAnexoDe(p.id, u);
    return reply.send({ apagado: true, id: p.id });
  });

  /* o chat busca o anexo com a chave no header (o <img> puro não manda header).
     v3.45: sai por STREAM e aceita `Range` — vídeo de 10 GB toca sem carregar
     nada na memória e o download retoma de onde parou (206). */
  app.get("/anexos/:id", async (req, reply) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const a = await abrirAnexo(p.id, u);
    const disposicao = `inline; filename*=UTF-8''${encodeURIComponent(a.nome)}`;
    const faixa = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "").trim());
    if (!faixa) {
      return reply
        .header("content-type", a.mime)
        .header("content-length", String(a.bytes))
        .header("accept-ranges", "bytes")
        .header("content-disposition", disposicao)
        .send(fs.createReadStream(a.caminho));
    }
    let ini = faixa[1] ? Number(faixa[1]) : 0;
    let fim = faixa[2] ? Number(faixa[2]) : a.bytes - 1;
    if (!Number.isFinite(ini) || ini < 0) ini = 0;
    if (!Number.isFinite(fim) || fim >= a.bytes) fim = a.bytes - 1;
    if (ini > fim) return reply.code(416).header("content-range", `bytes */${a.bytes}`).send();
    return reply
      .code(206)
      .header("content-type", a.mime)
      .header("content-length", String(fim - ini + 1))
      .header("content-range", `bytes ${ini}-${fim}/${a.bytes}`)
      .header("accept-ranges", "bytes")
      .header("content-disposition", disposicao)
      .send(fs.createReadStream(a.caminho, { start: ini, end: fim }));
  });

  /* ------------------------------------------------------------- painel */

  /** Números do acervo em uma chamada (o Painel não faz 6 requisições). */
  /* v3.4: Painel é do admin. O usuário comum não tem o módulo na tela nem pela API. */
  app.get("/dashboard", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const s = req.query as Record<string, string>;
    return dadosPainel(u, s.tenant ?? "");
  });

  /** Limites e esquecimento para a tela de Configurações (sem segredo). */
  app.get("/config", async (req) => {
    usuario(req);
    return configPublica();
  });

  /** v3.5: os três números do esquecimento, graváveis só pelo ADMIN. */
  app.put("/config/esquecimento", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return escreverEsquecimento(corpo(req));
  });

  /* ----------------------------------------------------------- usuários */

  app.get("/usuarios", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return { usuarios: await listarUsuarios() };
  });

  app.post("/usuarios", async (req, reply) => {
    const u = usuario(req);
    exigirOperador(u);
    const b = corpo(req);
    const r = await criarUsuario(vString(b.nome, "nome", { obrigatorio: true, max: 64 }), b.papel);
    return reply.code(201).send(r);
  });

  app.patch("/usuarios/:nome", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const p = req.params as Record<string, string>;
    const b = corpo(req);
    return atualizarUsuario(p.nome, { ativo: b.ativo, papel: b.papel });
  });

  /** Gera chave nova: o operador para qualquer um, o comum só para si. */
  app.post("/usuarios/:nome/chave", async (req) => {
    const u = usuario(req);
    const p = req.params as Record<string, string>;
    const alvo = p.nome.trim().toLowerCase();
    if (!u.operador && alvo !== u.tenant) throw new HttpError(403, "voce so pode trocar a sua propria chave");
    return novaChaveUsuario(alvo);
  });

  app.delete("/usuarios/:nome", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const p = req.params as Record<string, string>;
    return removerUsuario(p.nome);
  });

  /* ----------------------------------------------------- provider do chat */

  app.get("/config/provider", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return verProvider(u, s.tenant ?? "");
  });

  /* v3.4: provider é decisão de admin. O comum LÊ o seu (o Chat precisa saber se está
   * ligado); quem ESCREVE é só o operador — para si, para o tenant-alvo via body.tenant,
   * ou o padrão global (global:true). Sem Config na tela do comum, ele usa o que o admin definir. */
  app.put("/config/provider", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return salvarProvider(u, corpo(req) as Parameters<typeof salvarProvider>[1]);
  });

  /* v3.35 — instruções do modelo são da CONTA (valem para todos os providers e modelos), não
   * um campo de cada provider. Rota própria para o card da tela salvar só isso. */
  app.put("/config/instrucoes", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return salvarInstrucoes(u, corpo(req) as Parameters<typeof salvarInstrucoes>[1]);
  });

  app.post("/config/provider/testar", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return testarProvider(u, corpo(req));
  });

  /* ------------------------------------------- provedores nomeados (v3.19)
   * O operador cadastra cada servico uma vez (nome + URL + chave); a lista de
   * modelos vem do proprio servico (GET /models, com fallback /v1/models e
   * /api/tags do Ollama). Qualquer usuario escolhe qual usar na conversa. */

  app.get("/provedores", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return { provedores: await listarProvedores(u, s.tenant ?? null) };
  });

  app.put("/provedores", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const p = await salvarProvedor(u, corpo(req));
    return { ok: true, provedor: p };
  });

  app.patch("/provedores/padrao", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const b = corpo(req);
    const id = Number(b.id);
    if (!Number.isFinite(id)) throw new HttpError(422, "id e obrigatorio");
    return { ok: true, provedor: await definirPadrao(u, id, b.tenant ?? null) };
  });

  app.delete("/provedores/:id", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isFinite(id)) throw new HttpError(422, "id invalido");
    return await apagarProvedor(u, id);
  });

  /** AUTO-DESCOBERTA: pede a lista de modelos ao servico; com id, grava o cache. */
  app.post("/provedores/modelos", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return await provarModelos(u, corpo(req));
  });

  /* ------------------------------------------------------- servidores MCP */

  app.get("/config/mcp", async (req) => {
    usuario(req);
    return {
      servidores: await listarServidores(),
      controle_maquinas: controleDeMaquinaAtivo(),
      usuarios_habilitado: mcpLiberadoParaTodos(),
    };
  });

  // interruptor GLOBAL do controle de máquina: desliga chat + MCP externo + REST de uma vez
  app.patch("/config/mcp/maquinas", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const b = corpo(req);
    if (typeof b.ativo !== "boolean") throw new HttpError(422, "ativo (true/false) é obrigatório");
    await gravarControleDeMaquina(b.ativo);
    return { controle_maquinas: b.ativo };
  });

  app.post("/config/mcp", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    return criarServidor(corpo(req));
  });

  app.patch("/config/mcp/:nome", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const s = req.params as Record<string, string>;
    return atualizarServidor(s.nome, corpo(req));
  });

  app.delete("/config/mcp/:nome", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const s = req.params as Record<string, string>;
    return apagarServidor(s.nome);
  });

  app.post("/config/mcp/testar", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const b = corpo(req);
    return atualizarFerramentas(String(b.nome ?? ""), u);
  });

  /* v3.36 — interruptor do admin: "contas comuns podem usar o nexos como servidor MCP".
     Desligado, só o operador continua entrando (senão ninguém conserta nada). */
  app.patch("/config/mcp/usuarios", async (req) => {
    const u = usuario(req);
    exigirOperador(u);
    const b = corpo(req);
    if (typeof b.ativo !== "boolean") throw new HttpError(422, "ativo (true/false) é obrigatório");
    await gravarMcpLiberadoParaTodos(b.ativo);
    return { usuarios_habilitado: b.ativo };
  });

  /* v3.36 — a tela MCP do usuário: como conectar + o que ESTA conta alcança hoje. */
  app.get("/mcp/catalogo", async (req) => {
    const u = usuario(req);
    return {
      caminho: "/mcp",
      habilitado: mcpLiberadoParaTodos() || u.operador,
      papel: u.operador ? "operador" : "usuario",
      controle_maquinas: controleDeMaquinaAtivo(),
      ferramentas: TOOLS.map((t) => {
        const motivo = motivoDeBloqueio(u.tenant, u.operador, t.name);
        return {
          nome: t.name,
          descricao: t.description,
          grupo: grupoDaFerramenta(t.name),
          permitida: motivo === null,
          ajustavel: ajustavelPeloUsuario(u.operador, t.name),
          motivo,
        };
      }),
    };
  });

  /* v3.36 — o próprio usuário liga/desliga o que quer liberar para os agentes dele. */
  app.put("/mcp/ferramentas", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    const nome = String(b.ferramenta ?? "").trim();
    if (!TOOLS.some((t) => t.name === nome)) throw new HttpError(404, `ferramenta desconhecida: ${nome}`);
    if (typeof b.permitida !== "boolean") throw new HttpError(422, "permitida (true/false) é obrigatório");
    await gravarPermissao(u.tenant, u.operador, nome, b.permitida);
    return {
      ferramenta: nome,
      permitida: b.permitida,
      motivo: motivoDeBloqueio(u.tenant, u.operador, nome),
    };
  });

  /* ------------------------------------------------------------------ chat */

  app.post("/chat", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    const r = await responderChat(u, {
      pergunta: vString(b.pergunta, "pergunta", { obrigatorio: true, min: 1, max: CONFIG.maxQueryChars }),
      memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
      tenant: b.tenant ?? null,
      /* v3.19: escolha na hora da conversa ("" = padrão da casa) */
      provedor: vString(b.provedor, "provedor", { max: 40, def: "" }),
      modelo: vString(b.modelo, "modelo", { max: 100, def: "" }),
      /* v3.41: imagem colada no chat (validação e teto ficam em responderChat) */
      imagens: (b.imagens as { mime: string; base64: string }[] | undefined) ?? [],
      /* v3.46: arquivos grandes que o navegador subiu em blocos (só o id viaja) */
      anexos: (b.anexos as { id: string; nome?: string; bytes?: number }[] | undefined) ?? [],
    });
    void contarUso("chats");
    return r;
  });

  /** v3.3: tarefa de chat que roda no servidor — grava a linha `rodando`, dispara o
   *  responderChat sem bloquear e devolve 201 {id}. O INSERT é awaitado: a linha está
   *  commitada antes do `rodar` ler; o queueMicrotask só tira o loop do caminho da resposta. */
  app.post("/chat/tarefa", async (req, reply) => {
    const u = usuario(req);
    const b = corpo(req);
    const pergunta = vString(b.pergunta, "pergunta", { obrigatorio: true, min: 1, max: CONFIG.maxQueryChars });
    const memoria = vString(b.memoria, "memoria", { max: 128, def: "" });
    const id = await criarTarefa(
      u,
      {
        pergunta: pergunta.trim(),
        memoria: memoria.trim(),
        tenant: b.tenant ?? null,
        /* v3.19 */
        provedor: vString(b.provedor, "provedor", { max: 40, def: "" }),
        modelo: vString(b.modelo, "modelo", { max: 100, def: "" }),
        /* v3.46: arquivos grandes do navegador — só o id viaja; o conteúdo fica no disco */
        anexos: (b.anexos as { id: string; nome?: string; bytes?: number }[] | undefined) ?? [],
      },
      rodarTarefa,
    );
    void contarUso("chats"); // paridade de métrica com POST /chat
    reply.code(201).send({ id });
  });

  /** v3.3: consultas de tarefa (reanexar). Lista só as RODANDO da gaveta; estado
   *  de uma pelo id SEM filtro de tenant = vazamento de parcial entre tenants. */
  app.get("/chat/tarefas", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return listarTarefas(u, { memoria: (s.memoria ?? "").trim(), tenant: s.tenant ?? null });
  });

  app.get("/chat/tarefa/:id", async (req, reply) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    const t = await verTarefa(u, String((req.params as Record<string, string>).id), s.tenant ?? null);
    if (!t) {
      reply.code(404).send({ detail: "tarefa não encontrada" });
      return;
    }
    return { id: t.id, status: t.status, parcial: t.parcial, ferramentas: t.ferramentas, aviso: t.aviso, provedor: t.provedor, modelo: t.modelo };
  });

  /** v3.3: SSE reanexável da tarefa — replay do parcial + deltas ao vivo + fim/erro.
   *  Ordem anti-corrida ASSINAR-DEPOIS-RELER: o ouvinte entra ANTES de qualquer leitura;
   *  eventos disparados no vão viram snapshot da releitura, duplicatas caem no dedupe
   *  do client (R2 — texto.length <= parcial.length descarta). Mesmo padrão do
   *  POST /chat/stream: hijack, vivo via close da RESPOSTA, pulso 10s.
   *  Depois do hijack nada pode lançar erro — existência foi checada ANTES. */
  app.get("/chat/tarefa/:id/stream", async (req, reply) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    const id = String((req.params as Record<string, string>).id);
    if (!(await verTarefa(u, id, s.tenant ?? null))) {
      reply.code(404).send({ detail: "tarefa não encontrada" });
      return;
    }

    reply.hijack();
    const bruto = reply.raw;
    bruto.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, must-revalidate",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let vivo = true;
    bruto.on("close", () => {
      vivo = false; // cliente foi embora: para de escrever, a TAREFA continua no servidor
    });
    const enviar = (e: unknown): void => {
      if (!vivo || bruto.writableEnded || bruto.destroyed) return;
      try {
        bruto.write(`data: ${JSON.stringify(e)}\n\n`);
      } catch {
        vivo = false;
      }
    };
    const pulso = setInterval(() => {
      if (!vivo || bruto.writableEnded || bruto.destroyed) return;
      try {
        bruto.write(": ping\n\n");
      } catch {
        vivo = false;
      }
    }, 10_000);
    let off = () => {};
    const fechar = (): void => {
      clearInterval(pulso);
      off();
      if (!bruto.writableEnded) {
        try {
          bruto.end();
        } catch {
          /* conexão já caída */
        }
      }
    };
    /* 1. assina ANTES de ler */
    off = assinarTarefa(id, (e) => {
      enviar(e);
      const tipo = (e as { tipo?: string }).tipo;
      if (tipo === "fim" || tipo === "erro") fechar(); // stream vivo tem que FECHAR no fim
    });
    if (!vivo) {
      fechar();
      return;
    }
    /* 2. releitura = snapshot (cobre eventos do vão entre assinatura e leitura) */
    const t = await verTarefa(u, id, s.tenant ?? null);
    if (!t) {
      enviar({ tipo: "erro", detalhe: "a tarefa não existe mais" });
      fechar();
      return;
    }
    /* 3. corrida: tarefa terminou/falhou enquanto a conexão se montava */
    if (t.status === "terminou") {
      enviar({ tipo: "parcial", texto: t.parcial });
      enviar({ tipo: "fim", dados: { resposta: t.parcial, ferramentas: t.ferramentas, aviso: t.aviso, telas: t.telas ?? [], anexos: t.anexos ?? [] } });
      fechar();
      return;
    }
    if (t.status === "falhou") {
      enviar({ tipo: "parcial", texto: t.parcial });
      enviar({ tipo: "erro", detalhe: t.aviso ?? "a tarefa falhou" });
      fechar();
      return;
    }
    /* 4. rodando: snapshot do parcial e segue ao vivo pelo ouvinte */
    enviar({ tipo: "parcial", texto: t.parcial });
  });

  /** Chat com streaming (SSE): o texto chega em pedaços, como o modelo escreve.
   *  Depois de `hijack()` nada pode lançar erro — tudo vira evento `erro` no fluxo. */
  app.post("/chat/stream", async (req, reply) => {
    const u = usuario(req); // auth e validação ANTES de assumir a conexão crua
    const b = corpo(req);
    const pergunta = vString(b.pergunta, "pergunta", { obrigatorio: true, min: 1, max: CONFIG.maxQueryChars });
    const memoria = vString(b.memoria, "memoria", { max: 128, def: "" });
    const tenant = b.tenant ?? null;
    /* v3.19: provedor/modelo escolhidos na tela do chat */
    const provedor = vString(b.provedor, "provedor", { max: 40, def: "" });
    const modelo = vString(b.modelo, "modelo", { max: 100, def: "" });

    reply.hijack();
    const bruto = reply.raw;
    bruto.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, must-revalidate",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    /* NO `req.raw` para saber se ainda dá para escrever: em POST com corpo lido o
     * "close" da requisição chega cedo e o fluxo inteiro seria jogado fora.
     * O sinal certo é o "close" da RESPOSTA (conexão derrubada pelo navegador). */
    let vivo = true;
    bruto.on("close", () => {
      vivo = false;
    });
    const enviar = (e: unknown): void => {
      if (!vivo || bruto.writableEnded || bruto.destroyed) return;
      try {
        bruto.write(`data: ${JSON.stringify(e)}\n\n`);
      } catch {
        vivo = false;
      }
    };
    /* espera do modelo local passa de 10 s; o pulso mantém a conexão viva nos proxies */
    const pulso = setInterval(() => {
      if (!vivo || bruto.writableEnded || bruto.destroyed) return;
      try {
        bruto.write(": ping\n\n");
      } catch {
        vivo = false;
      }
    }, 10_000);
    try {
      const dados = await responderChat(
        u,
        { pergunta, memoria, tenant, provedor, modelo, imagens: b.imagens as { mime: string; base64: string }[] | undefined,
          anexos: (b.anexos as { id: string; nome?: string; bytes?: number }[] | undefined) ?? [] },
        enviar,
      );
      enviar({ tipo: "fim", dados });
      void contarUso("chats");
    } catch (e) {
      enviar({ tipo: "erro", detalhe: (e as Error).message ?? "o chat falhou" });
    } finally {
      clearInterval(pulso);
      if (!bruto.writableEnded) {
        try {
          bruto.end();
        } catch {
          /* conexão já caída */
        }
      }
    }
  });

  app.get("/chat", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return historicoChat(u, {
      memoria: s.memoria ?? "",
      tenant: s.tenant ?? "",
      limit: s.limit ? Number(s.limit) : 40,
    });
  });

  app.delete("/chat", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return limparChat(u, { memoria: s.memoria ?? "", tenant: s.tenant ?? "" });
  });

  /* ------------------------------------------- v3.18: básico que faltava no chat */

  /** T001: "parar" — aborta a chamada do provider; o parcial já está gravado no fim da tarefa. */
  /** v3.42 — fala no MEIO do turno (steering, o jeito do Hermes): não enfileira conversa,
   *  entra na próxima rodada da tarefa viva. Tarefa já encerrada: 409, para a tela poder
   *  cair no envio normal em vez de perder o texto. */
  app.post("/chat/tarefa/:id/fala", async (req, reply) => {
    const u = usuario(req);
    const b = corpo(req) as Record<string, unknown>;
    /* o tenant vem na QUERY (padrão das rotas de tarefa: cancelar, stream) — o corpo
       traria `tenant` e a tela mandaria um dos dois; aceitar os dois evita 404 falso */
    const s = req.query as Record<string, string>;
    const texto = vString(b.texto, "texto", { obrigatorio: true, min: 1, max: 4000 });
    const t = await verTarefa(u, String((req.params as Record<string, string>).id), s.tenant ?? (b.tenant as string | null) ?? null);
    if (!t) {
      reply.code(404).send({ detail: "tarefa não encontrada" });
      return;
    }
    if (String(t.status) !== "rodando" || !enfileirarFala(String(t.id), texto)) {
      reply.code(409).send({ detail: "a tarefa já não está rodando" });
      return;
    }
    notificarTarefa(String(t.id), { tipo: "steer", texto });
    return { ok: true };
  });

  app.post("/chat/tarefa/:id/cancelar", async (req, reply) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    const r = await cancelarTarefa(u, String((req.params as Record<string, string>).id), s.tenant ?? null);
    if (!r.achou) {
      reply.code(404).send({ detail: "tarefa não encontrada" });
      return;
    }
    return { ok: true, vivia: r.vivia };
  });

  /** T002: regenerar — corta o último par e devolve a pergunta; a tela reenvia pelo caminho normal. */
  app.post("/chat/regenerar", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    return truncarParaRegenerar(u, {
      memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
      tenant: b.tenant ?? null,
    });
  });

  /** T003: editar e reenviar — corta da pergunta escolhida para frente (a tela reenvia depois). */
  app.post("/chat/reenviar-corte", async (req) => {
    const u = usuario(req);
    const b = corpo(req);
    return cortarParaReenviar(u, {
      memoria: vString(b.memoria, "memoria", { max: 128, def: "" }),
      tenant: b.tenant ?? null,
      id: Number(b.id),
    });
  });

  /** T021: buscar dentro do histórico do tenant (trechos, mais novas primeiro). */
  app.get("/chat/mensagens", async (req) => {
    const u = usuario(req);
    const s = req.query as Record<string, string>;
    return buscarMensagensChat(u, s.q ?? "", s.limit ? Number(s.limit) : 50, s.tenant ?? null);
  });

  /* ----------------------------------------------------------------- MCP */

  app.post("/mcp", async (req, reply) => {
    const r = await mcpHandler(req.body, {
      health,
      autenticar: () =>
        authenticate((req.headers.authorization as string) ?? "", ip(req)),
    });
    if (r.status === 202) return reply.code(202).send();
    return reply.code(r.status).send(r.body);
  });

  /* -------------------------------------------------------------- painel */

  const tipos: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };

  app.get("/painel", async (_req, reply) =>
    reply.code(302).header("location", "/#/painel").send(),
  );

  app.get("/painel/*", async (req, reply) => {
    const wildcard = (req.params as Record<string, string>)["*"] ?? "";
    /* v3.27: /painel/ (link antigo) vira atalho para a tela do Painel no endereço novo.
       Os assets (/painel/assets/...) continuam sendo servidos daqui. */
    if (wildcard === "") return reply.code(302).header("location", "/#/painel").send();
    const rel = wildcard;
    const alvo = path.resolve(CONFIG.painelDir, rel);
    if (!alvo.startsWith(path.resolve(CONFIG.painelDir))) {
      return reply.code(404).send({ detail: "Not Found" });
    }
    let arquivo = alvo;
    if (fs.existsSync(arquivo) && fs.statSync(arquivo).isDirectory()) {
      arquivo = path.join(arquivo, "index.html");
    }
    if (!fs.existsSync(arquivo)) {
      // SPA: rota desconhecida cai no index
      arquivo = path.join(CONFIG.painelDir, "index.html");
      if (!fs.existsSync(arquivo)) return reply.code(404).send({ detail: "Not Found" });
    }
    const ext = path.extname(arquivo).toLowerCase();
    /* v3.65 — HTML sempre revalida; asset com hash no nome pode ficar para sempre. */
    const cache = path.basename(arquivo) === "index.html" ? "no-cache, must-revalidate" : "public, max-age=31536000, immutable";
    return reply
      .code(200)
      .header("content-type", tipos[ext] ?? "application/octet-stream")
      .header("cache-control", cache)
      .send(fs.createReadStream(arquivo));
  });

  return app;
}

export { iso };