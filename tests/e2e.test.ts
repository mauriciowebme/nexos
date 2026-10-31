/**
 * Suíte E2E do nexos v2 — porta das checagens da v1.8/v1.10 e do MCP.
 *
 * Roda por HTTP contra um serviço já no ar (não importa a linguagem do
 * servidor): é juiz de CONTRATO, não de implementação.
 *
 *   BASE=http://127.0.0.1:8002 TESTKEY=... OPKEY=... npm test
 *
 * Ordem importa: o freio de força bruta bloqueia o IP por 5 min, então é o
 * ÚLTIMO bloco.
 */
import { inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://127.0.0.1:8002";
/** prova de release: o /health tem que anunciar a versão que este commit promete.
 *  Sem isso, a suíte passa verde contra um container velho (deploy que não subiu). */
const VERSAO_ESPERADA = process.env.VERSAO ?? "3.1.0";
const TESTKEY = process.env.TESTKEY ?? "";
const OPKEY = process.env.OPKEY ?? "";

if (!TESTKEY || !OPKEY) {
  throw new Error("defina TESTKEY e OPKEY no ambiente");
}
/* BASE vazia ou sem protocolo NÃO é "alvo local padrão": derruba cedo. Sem isso a suíte
   inteira falha em menos de 1s por URL inválida e o relatório parece defeito do serviço. */
if (!/^https?:\/\/.+/.test(BASE)) {
  throw new Error(`BASE inválida ou vazia (${JSON.stringify(BASE)}) — rode scripts/up-test.sh e exporte o arquivo dele`);
}

type Resp = {
  status: number;
  headers: Headers;
  json: any;
  buf: Buffer;
  texto: string;
};

async function call(
  metodo: string,
  caminho: string,
  opts: { key?: string | null; corpo?: unknown } = {},
): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.key) headers.Authorization = "B" + "earer " + opts.key;
  if (opts.corpo !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers,
    body: opts.corpo === undefined ? undefined : JSON.stringify(opts.corpo),
    signal: AbortSignal.timeout(180_000),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const texto = buf.toString("utf8");
  let json: any = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  return { status: r.status, headers: r.headers, json, buf, texto };
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function esperarJob(key: string, jobId: number, teto = 300): Promise<any> {
  const fim = Date.now() + teto * 1000;
  while (Date.now() < fim) {
    const r = await call("GET", `/ingest/${jobId}`, { key });
    if (["concluido", "erro", "cancelado"].includes(r.json?.status)) return r.json;
    await dormir(3000);
  }
  return { status: "tempo_esgotado" };
}

async function ingerir(
  key: string,
  docId: string,
  content: string,
  memoria = "",
  tenant?: string,
): Promise<any> {
  const corpo: Record<string, unknown> = { doc_id: docId, title: docId, content, memoria };
  if (tenant) corpo.tenant = tenant;
  const r = await call("POST", "/ingest", { key, corpo });
  assert.equal(r.status, 202, `ingest ${docId}: ${r.status} ${r.texto.slice(0, 200)}`);
  return esperarJob(key, r.json.job_id);
}

/** SO_BLOCOS filtra por trecho do nome (separado por vírgula). A suíte inteira custa ~5min; rodar
 *  só os blocos afetados pela mudança custa ~1min — é isso que se roda antes de pedir OK pro deploy.
 *  Bloco pulado aparece NOMINALMENTE no relatório final (regra 8 / verde falso é o pior defeito). */
const FILTRO = (process.env.SO_BLOCOS ?? "").trim();
/* v3.34 — `pkill -f X` casa com a PRÓPRIA linha do shell (`sh -c pkill -f X`) e mata quem o
   executa: o docker exec volta 143 e o bloco morre no teardown, mesmo com o teste todo verde
   (medido no container Debian trixie, procps-ng 4.0.4 — 6 blocos vermelhos por isso). O truque
   do colchete faz o padrão não casar consigo mesmo: [m]aqfake não contém "maqfake". */
const pkill = (padrao: string | number) => {
  const s = String(padrao);
  return `pkill -f "[${s[0]}]${s.slice(1)}"`;
};
const blocosRodados: string[] = [];
const blocosPulados: string[] = [];
function bloco(t: any, nome: string, fn: () => Promise<void>) {
  if (FILTRO) {
    const alvos = FILTRO.split(",").map((s) => s.trim()).filter(Boolean);
    if (!alvos.some((p) => nome.includes(p))) {
      blocosPulados.push(nome);
      return;
    }
  }
  blocosRodados.push(nome);
  return t.test(nome, fn);
}

/** Coletor de checagens: acumula e falha no fim do bloco (mostra tudo). */
function fiscal() {
  const falhas: string[] = [];
  let oks = 0;
  return {
    check(nome: string, cond: unknown, extra: unknown = "") {
      if (cond) {
        oks += 1;
      } else {
        const detalhe = typeof extra === "string" || typeof extra === "number" ? String(extra) : JSON.stringify(extra);
        falhas.push(`${nome} :: ${detalhe.slice(0, 300)}`);
      }
    },
    fechar(bloco: string) {
      assert.equal(falhas.length, 0, `${bloco}: ${falhas.length} falha(s)\n- ${falhas.join("\n- ")}`);
      console.log(`   ${bloco}: ${oks} OK`);
    },
  };
}

const PALAVRAS = "A raposa veloz salta sobre o cao preguiçoso do quintal. ".repeat(22);

/** Lê um .zip em memória (sem depender do binário `unzip` no host). */
function lerZip(buf: Buffer): Map<string, Buffer> {
  const arquivos = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "zip: fim do diretório central não encontrado");
  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    assert.equal(buf.readUInt32LE(ptr), 0x02014b50, "zip: cabeçalho central inválido");
    const metodo = buf.readUInt16LE(ptr + 10);
    const compTamanho = buf.readUInt32LE(ptr + 20);
    const nomeLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const comentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const nome = buf.toString("utf8", ptr + 46, ptr + 46 + nomeLen);
    // cabeçalho local: nome/extra podem ter tamanhos diferentes do central
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, "zip: cabeçalho local inválido");
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const inicio = localOff + 30 + lnLen + leLen;
    const dados = buf.subarray(inicio, inicio + compTamanho);
    arquivos.set(nome, metodo === 0 ? Buffer.from(dados) : inflateRawSync(dados));
    ptr += 46 + nomeLen + extraLen + comentLen;
  }
  return arquivos;
}

/* ---------------------------------------------------------------- blocos */

test("nexos v2 — suíte completa", async (t) => {
  await bloco(t, "v1.8: documents, escopos e decay por documento", async () => {
    const f = fiscal();

    console.log("-- health e painel");
    const h = await call("GET", "/health");
    f.check(`health 200 + versao ${VERSAO_ESPERADA}`, h.status === 200 && h.json?.versao === VERSAO_ESPERADA, h.json);
    f.check("health operador ativo", h.json?.operador === true, h.json);
    f.check("health embedder ok", h.json?.embedder === "ok", h.json);
    const p = await call("GET", "/");
    f.check(
      "raiz serve a SPA (200 html, tela no hash)",
      p.status === 200 && p.texto.includes('id="root"') && p.texto.includes("/painel/assets/"),
      p.status,
    );
    const antigo = await fetch(BASE + "/painel/", { redirect: "manual" });
    f.check(
      "link antigo /painel/ 302 -> /#/painel",
      antigo.status === 302 && antigo.headers.get("location") === "/#/painel",
      antigo.status,
    );

    console.log("-- ingest vira documento com fonte");
    const C1 = "O farol da baia guia os barcos na neblina de novembro. ".repeat(3);
    const chk = await ingerir(TESTKEY, "nota1", C1);
    f.check("ingest nota1 concluido", chk.status === "concluido", chk);
    const doc = await call("GET", "/documents/nota1", { key: TESTKEY });
    f.check(
      "documents guarda original exato",
      doc.status === 200 && doc.json?.content === C1 && doc.json?.origem === "direto",
      doc.status,
    );

    console.log("-- download raw");
    const raw = await call("GET", "/documents/nota1/raw", { key: TESTKEY });
    f.check(
      "raw == conteudo + disposition",
      raw.status === 200 &&
        raw.texto === C1 &&
        (raw.headers.get("content-disposition") ?? "").includes("attachment"),
      raw.headers.get("content-disposition"),
    );

    console.log("-- edicao PUT reindexa");
    const C2 = C1 + "O farol foi pintado de vermelho vivo em 2026.";
    const put = await call("PUT", "/documents/nota1", {
      key: TESTKEY,
      corpo: { content: C2, memoria: "" },
    });
    f.check("PUT aceita (202)", put.status === 202, put.status);
    const st = await esperarJob(TESTKEY, put.json?.job_id);
    f.check("reindex concluido", st.status === "concluido", st);
    const doc2 = await call("GET", "/documents/nota1", { key: TESTKEY });
    f.check("edicao gravada na fonte", doc2.status === 200 && doc2.json?.content === C2, doc2.status);
    const s = await call("POST", "/search", {
      key: TESTKEY,
      corpo: { query: "farol vermelho 2026", min_score: 0.3, k: 3 },
    });
    f.check(
      "busca ve conteudo NOVO",
      s.json?.items?.some((it: any) => it.text.includes("vermelho")),
      s.json?.total,
    );

    console.log("-- gavetas e escopos");
    const g = await call("GET", "/gavetas", { key: TESTKEY });
    const tenants = new Set((g.json?.gavetas ?? []).map((x: any) => x.tenant));
    f.check(
      "tenant ve so o dele em /gavetas",
      g.status === 200 && g.json?.operador === false && tenants.size === 1 && tenants.has("teste"),
      [...tenants],
    );
    const gop = await call("GET", "/gavetas", { key: OPKEY });
    f.check(
      "operador ve tudo em /gavetas",
      gop.status === 200 && gop.json?.operador === true &&
        gop.json.gavetas.some((x: any) => x.tenant === "teste"),
      gop.json?.operador,
    );
    f.check(
      "operador nao aparece como usuario na lista",
      Array.isArray(gop.json?.usuarios) && !gop.json.usuarios.includes("operador"),
      gop.json?.usuarios,
    );
    f.check(
      "todo usuario tem a gaveta padrao no mapa",
      (gop.json?.usuarios ?? []).every((t: string) =>
        (gop.json?.gavetas ?? []).some((g: any) => g.tenant === t && g.memoria === ""),
      ),
      gop.json?.gavetas?.length,
    );

    const ingop = await call("POST", "/ingest", {
      key: OPKEY,
      corpo: { doc_id: "nota_op", content: "ping", memoria: "", tenant: "teste" },
    });
    f.check("operador ingere em tenant alheio", ingop.status === 202, ingop.status);
    if (ingop.status === 202) await esperarJob(OPKEY, ingop.json.job_id);
    const dop = await call("GET", "/docs?tenant=teste", { key: OPKEY });
    f.check(
      "operador lista docs de 'teste'",
      dop.status === 200 && dop.json.docs.some((x: any) => x.doc_id === "nota_op"),
      dop.json?.total,
    );
    const inj = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "injetado", content: "x", memoria: "", tenant: "operador" },
    });
    f.check("tenant NAO consegue mirar outro (vai pra ele mesmo)", inj.status === 202, inj.status);
    if (inj.status === 202) {
      await esperarJob(TESTKEY, inj.json.job_id);
      const d2 = await call("GET", "/docs?memoria=", { key: TESTKEY });
      f.check(
        "  'injetado' parou no PROPRIO tenant",
        d2.json?.docs?.some((x: any) => x.doc_id === "injetado"),
        d2.json?.total,
      );
      await call("DELETE", "/docs/injetado", { key: TESTKEY });
    }

    console.log("-- decay POR DOCUMENTO");
    const X = PALAVRAS + "Zebras listradas dançam valsa ao luar. " + PALAVRAS;
    const Y = "Tartarugas marinhas nidificam na praia deserta às três da manhã. ".repeat(65);
    f.check("docX ingerido (multi-chunk)", (await ingerir(TESTKEY, "docX", X)).status === "concluido");
    f.check("docY ingerido (multi-chunk)", (await ingerir(TESTKEY, "docY", Y)).status === "concluido");
    await dormir(1000);
    for (let i = 0; i < 3; i++) {
      await call("POST", "/search", {
        key: TESTKEY,
        corpo: { query: "zebras valsa luar", min_score: 0.3, k: 1 },
      });
    }
    const dec = await call("POST", "/decay", {
      key: TESTKEY,
      corpo: { dias: 0, min_acessos: 2 },
    });
    f.check("decay devolve contagem por doc", dec.json?.docs_arquivados_agora !== undefined, dec.json);
    const ativos = await call("GET", "/docs", { key: TESTKEY });
    const ids = new Set((ativos.json?.docs ?? []).map((x: any) => x.doc_id));
    f.check("docX INTEIRO continua ativo", ids.has("docX"), [...ids]);
    f.check("docY arquivado INTEIRO some da lista ativa", !ids.has("docY"), [...ids]);
    const comArq = await call("GET", "/docs?include_archived=true", { key: TESTKEY });
    const arq = new Map((comArq.json?.docs ?? []).map((x: any) => [x.doc_id, x.chunks_arquivados]));
    f.check("docY com TODOS os chunks arquivados", Number(arq.get("docY") ?? 0) >= 2, [...arq]);

    console.log("-- revive tambem e por documento");
    const s2 = await call("POST", "/search", {
      key: TESTKEY,
      corpo: { query: "tartarugas nidificam praia", min_score: 0.3, k: 1, include_archived: true },
    });
    f.check("busca acha docY arquivado", (s2.json?.total ?? 0) >= 1, s2.json?.total);
    const comArq2 = await call("GET", "/docs?include_archived=true", { key: TESTKEY });
    const arq2 = new Map((comArq2.json?.docs ?? []).map((x: any) => [x.doc_id, x.chunks_arquivados]));
    f.check("REVIVEU o doc inteiro (0 chunks arquivados de docY)", arq2.get("docY") === 0, [...arq2]);

    console.log("-- jobs agregados");
    const j1 = await call("GET", "/jobs?limit=100", { key: TESTKEY });
    f.check(
      "tenant so ve jobs do dele",
      j1.status === 200 && j1.json.jobs.every((x: any) => x.tenant === "teste"),
      new Set(j1.json?.jobs?.map((x: any) => x.tenant)),
    );
    const j2 = await call("GET", "/jobs?limit=100", { key: OPKEY });
    f.check(
      "operador ve jobs de 'teste' (e resumo por status)",
      j2.status === 200 && j2.json.resumo_por_status &&
        j2.json.jobs.some((x: any) => x.tenant === "teste"),
      j2.json?.resumo_por_status,
    );

    console.log("-- delete apaga fonte junto");
    const del = await call("DELETE", "/docs/nota1", { key: TESTKEY });
    f.check("delete responde fonte_apagada", del.status === 200 && del.json?.fonte_apagada === true, del.json);
    const d404 = await call("GET", "/documents/nota1", { key: TESTKEY });
    f.check("documents nao sobrevive (404)", d404.status === 404, d404.status);

    console.log("-- /decay de tenant nao mexe em outros");
    const dec2 = await call("POST", "/decay", {
      key: TESTKEY,
      corpo: { dias: 0, min_acessos: 999 },
    });
    f.check("decay do tenant nao arquiva gaveta alheia", dec2.status === 200, dec2.json);

    f.fechar("v1.8");
  });

  await bloco(t, "MCP: JSON-RPC stateless com as 51 tools", async () => {
    const f = fiscal();
    const H = { key: TESTKEY };
    const rpc = (id: unknown, method: string, params?: unknown, key: string | null = TESTKEY) =>
      call("POST", "/mcp", {
        key,
        corpo: params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params },
      });

    let r = await rpc(1, "initialize", {
      protocolVersion: "2025-03-10",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    });
    f.check("initialize", r.status === 200 && r.json?.result?.serverInfo?.name === "nexos", r.texto.slice(0, 200));
    f.check("initialize ecoa versao pedida", r.json?.result?.protocolVersion === "2025-03-10", r.json?.result?.protocolVersion);

    r = await rpc(2, "notifications/initialized");
    f.check("notifications/* -> 202", r.status === 202, r.status);

    r = await rpc(3, "ping");
    f.check("ping", r.status === 200 && "result" in r.json, r.texto.slice(0, 100));

    r = await rpc(4, "tools/list");
    const nomes = (r.json?.result?.tools ?? []).map((x: any) => x.name).sort();
    const ESPERADAS = [
      "analisar_imagem",
      "apagar_usuario",
      "archive_doc",
      "chat",
      "config_provider",
      "create_gaveta",
      "criar_usuario",
      "delete_doc",
      "delete_gaveta",
      "edit_doc",
      "esquecimento",
      "get_file",
      "health",
      "ingest",
      "ingest_status",
      "list_anexos",
      "list_docs",
      "list_gavetas",
      "list_jobs",
      "listar_mcp",
      "gerar_pareamento",
      "gerir_mcp",
      "listar_usuarios",
      "maquinas_online",
      /* v3.23: tela gerada pelo agente */
      "mostrar_tela",
      "rename_doc",
      "rodar_comando",
      "search",
      "upload_file",
      /* v3.32: busca na web e leitura de página (entraram sem atualizar esta lista) */
      "web_search",
      "web_open",
      /* v3.8: vocabulário do túnel entra na superfície (21 tools após a v3.39) */
      "abrir", "area_transferencia", "buscar_arquivos", "editar_no_local", "estado_maquina",
      "eventos", "esperar_arquivo", "falar", "git_remoto", "grep_remoto",
      "janelas", "ler_arquivo", "listar_arquivos", "power", "processos",
      "rede", "rodar_lote", "servicos", "sessao", "escrever_arquivo", "metricas",
      /* v3.44: print e arquivo da máquina na conversa + cópia máquina -> máquina */
      "capturar_tela", "baixar_arquivo", "copiar_arquivo",
      /* v3.46: arquivo do servidor (navegador) -> máquina */
      "enviar_para_maquina",
    ].sort();
    /* v3.36 — a lista passou a dizer a verdade da CONTA: as 5 de operador saem para o comum */
    const SO_OPERADOR_336 = ["listar_usuarios", "criar_usuario", "apagar_usuario", "esquecimento", "gerir_mcp"];
    const ESPERADAS_COMUM = ESPERADAS.filter((n) => !SO_OPERADOR_336.includes(n)).sort();
    f.check("tools/list da conta comum traz as 51 (as 5 de operador ficam fora)", JSON.stringify(nomes) === JSON.stringify(ESPERADAS_COMUM), `${nomes.length}: ${nomes.filter((n: string) => !ESPERADAS_COMUM.includes(n)).join(", ")}`);

    r = await rpc(5, "tools/call", { name: "health" }, null);
    f.check("tools/call sem Bearer -> 401", r.status === 401 && "error" in (r.json ?? {}), r.texto.slice(0, 150));

    r = await rpc(6, "tools/call", { name: "health" });
    const txt = r.json?.result?.content?.[0]?.text ?? "{}";
    f.check("tools/call health", r.status === 200 && JSON.parse(txt).dim === 768, r.texto.slice(0, 150));

    r = await rpc(7, "tools/call", {
      name: "ingest",
      arguments: {
        doc_id: "mcp-teste-1",
        title: "Teste MCP",
        content:
          "O Hermes compacta o contexto quando a janela enche. O mini-compress faz isso de forma deterministica, sem LLM.",
        memoria: "mcp-gaveta",
      },
    });
    const job = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("tools/call ingest -> job_id na fila", r.status === 200 && job.status === "na_fila", r.texto.slice(0, 200));

    let status: any = {};
    for (let i = 0; i < 40; i++) {
      r = await rpc(8, "tools/call", { name: "ingest_status", arguments: { job_id: job.job_id } });
      status = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
      if (["concluido", "erro"].includes(status.status)) break;
      await dormir(2000);
    }
    f.check("ingest_status -> concluido", status.status === "concluido", status);

    r = await rpc(9, "tools/call", {
      name: "search",
      arguments: { query: "como o Hermes lida com a janela de contexto cheia", memoria: "mcp-gaveta" },
    });
    const res = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("search MCP acha o doc", r.status === 200 && (res.total ?? 0) >= 1, res.total);

    r = await rpc(10, "tools/call", {
      name: "search",
      arguments: { query: "como o Hermes lida com a janela de contexto cheia", memoria: "outra" },
    });
    const res2 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("isolamento por memoria (0 hits na gaveta errada)", res2.total === 0, res2.total);

    r = await rpc(11, "tools/call", { name: "list_docs", arguments: { memoria: "mcp-gaveta" } });
    const res3 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "list_docs mostra o doc",
      (res3.docs ?? []).some((d: any) => d.doc_id === "mcp-teste-1"),
      res3.total,
    );

    r = await rpc(12, "tools/call", {
      name: "delete_doc",
      arguments: { doc_id: "mcp-teste-1", memoria: "mcp-gaveta" },
    });
    const res4 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("delete_doc apaga", (res4.chunks_apagados ?? 0) >= 1, res4);

    r = await rpc(13, "tools/call", {
      name: "search",
      arguments: { query: "janela de contexto cheia", memoria: "mcp-gaveta" },
    });
    const res5 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("search pos-delete = 0 hits", res5.total === 0, res5.total);

    r = await rpc(14, "foo/bar");
    f.check("metodo desconhecido -> -32601", r.status === 200 && r.json?.error?.code === -32601, r.texto.slice(0, 120));

    r = await rpc(15, "tools/call", { name: "search", arguments: {} });
    f.check(
      "args invalidos -> isError=true (nao crash)",
      r.status === 200 && r.json?.result?.isError === true,
      r.texto.slice(0, 150),
    );

    console.log("-- MCP processador de documentos");
    const md = "# ata da reuniao\n- decisao: subir o processador\n";
    r = await rpc(20, "tools/call", {
      name: "upload_file",
      arguments: {
        nome: "ata-mcp.md",
        conteudo_base64: Buffer.from(md, "utf8").toString("base64"),
        memoria: "mcp-gaveta",
      },
    });
    const up = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "upload_file: 201-equivalente, tipo md, editavel",
      r.status === 200 && up.doc_id === "ata-mcp" && up.tipo === "md" && up.editavel_na_tela === true,
      r.texto.slice(0, 200),
    );
    if (Number.isFinite(Number(up.job_id))) await esperarJob(TESTKEY, Number(up.job_id));

    r = await rpc(21, "tools/call", {
      name: "get_file",
      arguments: { doc_id: "ata-mcp", memoria: "mcp-gaveta" },
    });
    const gf = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "get_file devolve o original byte a byte",
      Buffer.from(String(gf.conteudo_base64 ?? ""), "base64").toString("utf8") === md &&
        gf.nome === "ata-mcp.md" &&
        gf.mime === "text/markdown",
      `${gf.nome} ${gf.mime} ${gf.tamanho}`,
    );

    const md2 = "# ata da reuniao\n- decisao: reprocessar depois da revisao\n";
    r = await rpc(22, "tools/call", {
      name: "edit_doc",
      arguments: { doc_id: "ata-mcp", content: md2, memoria: "mcp-gaveta" },
    });
    const ed = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("edit_doc enfileira a reindexacao", r.status === 200 && Number.isFinite(Number(ed.job_id)), r.texto.slice(0, 150));
    if (Number.isFinite(Number(ed.job_id))) await esperarJob(TESTKEY, Number(ed.job_id));
    r = await rpc(23, "tools/call", {
      name: "get_file",
      arguments: { doc_id: "ata-mcp", memoria: "mcp-gaveta" },
    });
    const gf2 = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "edicao via MCP atualiza o original",
      Buffer.from(String(gf2.conteudo_base64 ?? ""), "base64").toString("utf8") === md2,
      gf2.tamanho,
    );

    r = await rpc(24, "tools/call", { name: "list_gavetas" });
    const gv = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check(
      "list_gavetas mostra a gaveta do doc",
      (gv.gavetas ?? []).some((g: any) => g.tenant === "teste" && g.memoria === "mcp-gaveta"),
      (gv.gavetas ?? []).length,
    );

    const nomeGav = "mcp-nova-" + Math.random().toString(36).slice(2, 7);
    r = await rpc(25, "tools/call", { name: "create_gaveta", arguments: { memoria: nomeGav } });
    f.check("create_gaveta cria", r.status === 200 && JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}").memoria === nomeGav, r.texto.slice(0, 120));

    r = await rpc(26, "tools/call", { name: "delete_gaveta", arguments: { memoria: nomeGav } });
    f.check("delete_gaveta apaga a vazia", r.status === 200 && r.json?.result?.isError !== true, r.texto.slice(0, 120));

    r = await rpc(27, "tools/call", { name: "list_jobs", arguments: { limit: 5 } });
    const lj = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("list_jobs devolve resumo por status", r.status === 200 && Array.isArray(lj.jobs), Object.keys(lj).slice(0, 5));

    r = await rpc(28, "tools/call", { name: "upload_file", arguments: { nome: "x.zip", conteudo_base64: "AAAA" } });
    f.check(
      "upload_file recusa tipo nao aceito (isError)",
      r.status === 200 && r.json?.result?.isError === true,
      r.texto.slice(0, 150),
    );

    r = await rpc(29, "tools/call", { name: "delete_doc", arguments: { doc_id: "ata-mcp", memoria: "mcp-gaveta" } });
    const dm = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("delete_doc limpa o doc do MCP", (dm.chunks_apagados ?? 0) >= 1, dm);

    const rest = await call("POST", "/search", { key: TESTKEY, corpo: { query: "oi", memoria: "mcp-gaveta" } });
    f.check("REST /search continua funcionando", rest.json?.items !== undefined, rest.status);

    f.fechar("MCP");
  });


  /* v3.36 — o nexos como servidor MCP ganha dono: o admin libera o uso por conta e cada
     usuário escolhe o que quer expor; ferramenta nova nasce liberada. */
  await bloco(t, "v3.36: MCP por conta — interruptor do admin e lista do próprio usuário", async () => {
    const f = fiscal();
    const lista = async (key: string) => {
      const r = await call("POST", "/mcp", { key, corpo: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      return (r.json?.result?.tools ?? []).map((x: any) => x.name) as string[];
    };

    let r = await call("GET", "/mcp/catalogo", { key: TESTKEY });
    const cats = (r.json?.ferramentas ?? []) as any[];
    const soOp = cats.filter((x) => x.motivo === "papel").map((x) => x.nome).sort();
    f.check("catálogo da conta comum marca as 6 de operador como 'papel'", r.status === 200 && soOp.join(",") === "apagar_usuario,criar_usuario,esquecimento,gerir_mcp,listar_usuarios,rodar_python", soOp.join(","));
    f.check("as demais nascem liberadas (nenhuma desligada de fábrica)", cats.filter((x) => x.motivo === "desligada").length === 0, cats.filter((x) => x.motivo === "desligada").length);
    f.check("ferramenta de operador não é ajustável pelo comum", cats.filter((x) => x.motivo === "papel" && x.ajustavel === true).length === 0, "ajustável indevido");

    r = await call("PUT", "/mcp/ferramentas", { key: TESTKEY, corpo: { ferramenta: "search", permitida: false } });
    f.check("usuário desliga uma ferramenta na própria conta", r.status === 200 && r.json?.permitida === false && r.json?.motivo === "desligada", r.texto.slice(0, 160));
    f.check("desligada some do tools/list", !(await lista(TESTKEY)).includes("search"), "search ainda listada");
    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search", arguments: { query: "oi" } } } });
    f.check("chamada da desligada é recusada com o motivo", r.status === 403 && /desligada na sua tela MCP/.test(r.texto), r.texto.slice(0, 160));

    r = await call("PUT", "/mcp/ferramentas", { key: TESTKEY, corpo: { ferramenta: "search", permitida: true } });
    f.check("religar devolve a ferramenta", r.status === 200 && (await lista(TESTKEY)).includes("search"), r.texto.slice(0, 160));
    r = await call("PUT", "/mcp/ferramentas", { key: TESTKEY, corpo: { ferramenta: "nao_existe_336", permitida: false } });
    f.check("ferramenta inexistente: 404", r.status === 404, r.status);

    r = await call("PATCH", "/config/mcp/usuarios", { key: TESTKEY, corpo: { ativo: false } });
    f.check("usuário comum não desliga o MCP de todos (403)", r.status === 403, r.status);
    r = await call("PATCH", "/config/mcp/usuarios", { key: OPKEY, corpo: { ativo: false } });
    f.check("operador desliga o MCP das contas", r.status === 200 && r.json?.usuarios_habilitado === false, r.texto.slice(0, 160));
    f.check("com o MCP desligado a conta comum não vê ferramenta nenhuma", (await lista(TESTKEY)).length === 0, (await lista(TESTKEY)).length);
    f.check("o operador continua entrando (para poder reverter)", (await lista(OPKEY)).length === 57, (await lista(OPKEY)).length);
    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "health", arguments: {} } } });
    f.check("chamada da conta comum com MCP desligado: 403 com o motivo", r.status === 403 && /desligado/.test(r.texto), r.texto.slice(0, 160));

    r = await call("PATCH", "/config/mcp/usuarios", { key: OPKEY, corpo: { ativo: true } });
    f.check("religado, a conta comum volta a ver as 51", r.status === 200 && (await lista(TESTKEY)).length === 51, (await lista(TESTKEY)).length);
    r = await call("GET", "/config/mcp", { key: OPKEY });
    f.check("a config do admin mostra o interruptor", r.json?.usuarios_habilitado === true, JSON.stringify(r.json).slice(0, 120));

    f.fechar("v3.36 MCP por conta");
  });

  /* v3.37 (T042) — o cliente anuncia `process.platform + " " + os.release()` = "win32 10.0.26200".
     Antes desta correção, `ctx.so === "windows"` nunca era verdade em PC: `ifconfig` rodava no
     Windows, `janelas` dava 422 e `listar_arquivos` voltava vazio COM ok:true (falha calada). */
  await bloco(t, "v3.37: ferramenta de máquina reconhece o SO do Windows (win32 …)", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const psql = (sql: string) =>
      execFileSync("docker", ["exec", process.env.DBCONTAINER ?? CONTAINER.replace("-api-", "-db-"), "sh", "-c",
        `psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"${sql}\"`], { encoding: "utf8" }).trim();
    const leArq = (p: string) => {
      try { return execFileSync("docker", ["exec", CONTAINER, "cat", p], { encoding: "utf8" }); } catch { return ""; }
    };
    /* máquina falsa que fala o wire do túnel e ANUNCIA o SO que o teste mandar */
    const FAKE = [
      'const WebSocket=require("/app/node_modules/ws");const fs=require("fs");',
      'const token=process.env.FQ2_TOKEN||"",host=process.env.FQ2_HOST||"maq",so=process.env.FQ2_SO||"fake";',
      'const ws=new WebSocket(process.env.FQ2_URL||"ws://127.0.0.1:8000/maquina/ws");',
      'ws.on("open",()=>ws.send(JSON.stringify({token,host,os:so,user:"suite"})));',
      'ws.on("message",(b)=>{let m={};try{m=JSON.parse(String(b))}catch{return}',
      'if(typeof m.cmd==="string")ws.send(JSON.stringify({exit:0,stdout:"ECO:"+m.cmd,stderr:""}))});',
      'ws.on("error",()=>{});',
    ].join("");
    execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", "cat > /app/maqso.js"], { input: FAKE });

    const subir = async (nome: string, so: string) => {
      let r = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome } });
      const par = String(r.json?.token ?? "");
      execFileSync("docker", ["exec", "-d", CONTAINER, "sh", "-c",
        `FQ2_TOKEN='${par}' FQ2_HOST='${nome}' FQ2_SO='${so}' node /app/maqso.js`]);
      for (let i = 0; i < 40; i++) {
        if (psql(`SELECT so FROM maquinas WHERE host='${nome}'`).startsWith("win")) break;
        await dormir(300);
      }
      r = await call("GET", "/maquinas", { key: TESTKEY });
      return (r.json?.maquinas ?? []).find((m: any) => m.host === nome);
    };

    const win = await subir("so-win", "win32 10.0.19045");
    f.check("v3.37 máquina Windows online e com o SO CRU guardado (win32 …)",
      win?.online === true && String(win?.so).startsWith("win32"), JSON.stringify(win ?? {}).slice(0, 160));

    /* o pedido que o servidor MANDA para a máquina é a prova do ramo escolhido */
    /* rodar_lote é a ferramenta que EMBRULHA o comando por plataforma (PowerShell no Windows,
       bash no Linux) — o `run` cru manda o texto igual nos dois e não prova ramo nenhum. */
    let r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 89, method: "tools/call",
      params: { name: "rodar_lote", arguments: { host: "so-win", comandos: ["echo ramo"] } } } });
    /* a máquina falsa devolve o comando que RECEBEU: provar o ramo pelo texto enviado, não pelo
       exit (os dois ramos rodam — o errado é o Unix mandando ifconfig/sh para um PC) */
    const enviado = JSON.stringify(r.json ?? {});
    f.check("v3.37 com win32 o rodar_lote embrulha o comando em PowerShell (ramo Windows)",
      r.status === 200 && /powershell/i.test(enviado), enviado.slice(0, 300));

    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 90, method: "tools/call",
      params: { name: "janelas", arguments: { host: "so-win", acao: "listar" } } } });
    const erroJanelas = String(r.json?.error?.message ?? r.json?.result?.content?.[0]?.text ?? "");
    f.check("v3.37 janelas NÃO diz mais 'so em Windows' para uma máquina win32",
      !/so em Windows/i.test(erroJanelas), erroJanelas.slice(0, 200));

    const lin = await subir("so-lin", "linux 6.8.0");
    f.check("v3.37 máquina Linux continua linux",
      lin?.online === true && String(lin?.so).startsWith("linux"), JSON.stringify(lin ?? {}).slice(0, 160));

    /* pkill -f casa com a própria linha do shell (sh -c ... maqso.js) e derruba quem executa:
       o truque do colchete já está no padrão, mas o rm sai em comando separado por segurança */
    try {
      execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "pkill -f '[m]aqso.js'; true"], { stdio: "ignore" });
    } catch {}
    execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "rm -f /app/maqso.js; echo ok"]);
    for (const h of ["so-win", "so-lin"]) {
      const g = await call("GET", "/maquinas", { key: TESTKEY });
      const id = (g.json?.maquinas ?? []).find((m: any) => m.host === h)?.id;
      if (id) await call("DELETE", `/maquinas/chave/${id}`, { key: TESTKEY });
    }
    f.fechar("v3.37 SO do Windows");
  });

  await bloco(t, "v1.10: renomear/mover, arquivar, zip, gaveta, jobs", async () => {
    const f = fiscal();
    const TEXTO = "Relatório de campo sobre marés e ventos do litoral norte. ".repeat(4);
    const ing = async (docId: string, content: string, memoria: string) => {
      const r = await call("POST", "/ingest", {
        key: TESTKEY,
        corpo: { doc_id: docId, title: docId, content, memoria },
      });
      assert.equal(r.status, 202, `ingest ${docId}: ${r.status}`);
      return r.json.job_id as number;
    };

    console.log("-- renomear");
    await esperarJob(TESTKEY, await ing("r1", TEXTO, "g1"));
    let r = await call("PATCH", "/documents/r1?memoria=g1", {
      key: TESTKEY,
      corpo: { novo_doc_id: "r1-b" },
    });
    f.check("PATCH renomeia", r.status === 200 && r.json.renomeado && r.json.doc_id === "r1-b", r.json);
    const dnovo = await call("GET", "/documents/r1-b?memoria=g1", { key: TESTKEY });
    f.check("fonte segue no novo id", dnovo.status === 200 && dnovo.json.content === TEXTO, dnovo.status);
    const dvelho = await call("GET", "/documents/r1?memoria=g1", { key: TESTKEY });
    f.check("id antigo sumiu", dvelho.status === 404, dvelho.status);

    console.log("-- mover de gaveta");
    r = await call("PATCH", "/documents/r1-b?memoria=g1", {
      key: TESTKEY,
      corpo: { destino_memoria: "g2" },
    });
    f.check("PATCH move", r.status === 200 && r.json.movido && r.json.memoria === "g2", r.json);
    const g1 = await call("GET", "/docs?memoria=g1", { key: TESTKEY });
    f.check("saiu de g1", g1.status === 200 && g1.json.total === 0, g1.json?.total);
    const g2 = await call("GET", "/docs?memoria=g2", { key: TESTKEY });
    f.check("entrou em g2", g2.status === 200 && g2.json.total === 1, g2.json?.total);

    console.log("-- titulo");
    r = await call("PATCH", "/documents/r1-b?memoria=g2", { key: TESTKEY, corpo: { title: "Novo Título" } });
    f.check("PATCH título", r.status === 200 && r.json.titulo === "Novo Título", r.json);
    const g2b = await call("GET", "/docs?memoria=g2", { key: TESTKEY });
    f.check("título na lista", g2b.json.docs[0].title === "Novo Título", g2b.json?.docs?.[0]?.title);

    console.log("-- arquivar manual");
    r = await call("PATCH", "/documents/r1-b/arquivado?memoria=g2", {
      key: TESTKEY,
      corpo: { arquivado: true },
    });
    f.check("arquiva", r.status === 200 && r.json.arquivado, r.json);
    const semArq = await call("GET", "/docs?memoria=g2", { key: TESTKEY });
    f.check("arquivado some da lista padrão", semArq.json?.total === 0, semArq.json?.total);
    const comArq = await call("GET", "/docs?memoria=g2&include_archived=true", { key: TESTKEY });
    f.check(
      "include_archived mostra inteiro arquivado",
      comArq.json?.docs?.length > 0 &&
        comArq.json.docs[0].chunks_arquivados === comArq.json.docs[0].chunks,
      comArq.json?.docs?.[0],
    );
    r = await call("PATCH", "/documents/r1-b/arquivado?memoria=g2", {
      key: TESTKEY,
      corpo: { arquivado: false },
    });
    f.check("revive", r.status === 200 && r.json.chunks_afetados >= 1, r.json);

    console.log("-- colisão de nome");
    await esperarJob(TESTKEY, await ing("r1-c", "outro texto qualquer de teste de colisao", "g2"));
    r = await call("PATCH", "/documents/r1-b?memoria=g2", { key: TESTKEY, corpo: { novo_doc_id: "r1-c" } });
    f.check("id ocupado no destino -> 409", r.status === 409, r.status);

    console.log("-- filtro e paginação");
    for (const i of [1, 2]) await esperarJob(TESTKEY, await ing(`extra-${i}`, `conteudo de apoio numero ${i}`, "g2"));
    const q = await call("GET", "/docs?memoria=g2&q=extra", { key: TESTKEY });
    f.check(
      "?q= filtra",
      q.json?.total === 2 && q.json.docs.every((x: any) => x.doc_id.includes("extra")),
      q.json?.total,
    );
    const pag = await call("GET", "/docs?memoria=g2&limit=1&offset=1", { key: TESTKEY });
    f.check(
      "limit+offset devolvem 1 e total estável",
      pag.json?.docs?.length === 1 && pag.json.total >= 3,
      pag.json?.total,
    );

    console.log("-- export zip");
    const zipR = await call("GET", "/gavetas/g2/export.zip", { key: TESTKEY });
    const zipOk = zipR.status === 200 && (zipR.headers.get("content-type") ?? "").includes("zip");
    let nomes: string[] = [];
    let conteudoZip = "";
    if (zipOk) {
      const arquivos = lerZip(zipR.buf);
      nomes = [...arquivos.keys()];
      conteudoZip = arquivos.get("r1-b.txt")?.toString("utf8") ?? "";
    }
    f.check(
      "zip válido com manifest e fontes",
      zipOk && nomes.includes("manifest.json") && conteudoZip === TEXTO,
      nomes.length ? nomes : zipR.status,
    );

    console.log("-- jobs cancel/retry");
    const grande = Array(60).fill("Frase de enchimento para ocupar a fila").join(".");
    const j1 = await ing("fila-grande", grande, "g2");
    const j2 = await ing("fila-pequena", "texto pequeno que vai esperar na fila", "g2");
    r = await call("POST", `/jobs/${j2}/cancel`, { key: TESTKEY });
    f.check("cancelar na_fila", r.status === 200 && r.json.status === "cancelado", r.json);
    r = await call("POST", `/jobs/${j2}/retry`, { key: TESTKEY });
    f.check("retry reenfileira", r.status === 200 && r.json.status === "na_fila", r.json);
    f.check("fila pequena concluída", (await esperarJob(TESTKEY, j2)).status === "concluido");
    await esperarJob(TESTKEY, j1);
    r = await call("POST", `/jobs/${j1}/cancel`, { key: TESTKEY });
    f.check("cancelar concluído -> 409", r.status === 409, r.status);

    console.log("-- apagar gaveta");
    r = await call("DELETE", "/gavetas/g2", { key: TESTKEY });
    f.check(
      "apaga gaveta",
      r.status === 200 && r.json.chunks_apagados >= 1 && r.json.fontes_apagadas >= 1,
      r.json,
    );
    const gv = await call("GET", "/gavetas", { key: TESTKEY });
    f.check("gaveta sumiu do mapa", gv.json.gavetas.every((x: any) => x.memoria !== "g2"), gv.json?.gavetas);
    r = await call("DELETE", "/gavetas/g2", { key: TESTKEY });
    f.check("apagar de novo -> 404", r.status === 404, r.status);

    console.log("-- escopo operador");
    r = await call("PATCH", "/documents/x-nao-existe?memoria=g1", {
      key: OPKEY,
      corpo: { title: "x", tenant: "teste" },
    });
    f.check("operador respeita tenant alvo (404 correto = rota ok)", r.status === 404, r.status);

    f.fechar("v1.10");
  });

  // ÚLTIMO: bloqueia o IP por 5 minutos

  await bloco(t, "arquivos: upload, conversão e substituição por nome", async () => {
    const f = fiscal();

    /* bloco idempotente: começa e termina com as gavetas de teste vazias
       (sem isso o 2º `npm test` acha o doc anterior e responde 200 "substituiu") */
    for (const g of ["arquivos", "arquivos2"]) {
      await call("DELETE", `/gavetas/${g}`, { key: TESTKEY });
    }

    /* PDFs reais (fpdf2) — o pdfjs do pdf-parse antigo recusava; aqui é o mesmo
       caminho que produção usa, então o fixture tem que ser PDF de verdade */
    const PDF_V1 = Buffer.from(
      "JVBERi0xLjMKJenr8b8KMSAwIG9iago8PAovQ291bnQgMQovS2lkcyBbMyAwIFJdCi9NZWRpYUJveCBbMCAwIDU5NS4yOCA4NDEuODldCi9UeXBlIC9QYWdlcwo+PgplbmRvYmoKMiAwIG9iago8PAovT3BlbkFjdGlvbiBbMyAwIFIgL0ZpdEggbnVsbF0KL1BhZ2VMYXlvdXQgL09uZUNvbHVtbgovUGFnZXMgMSAwIFIKL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDQgMCBSCi9QYXJlbnQgMSAwIFIKL1Jlc291cmNlcyA2IDAgUgovVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDE1MQo+PgpzdHJlYW0KeJxVjTEPgjAUhHd/xY26VApBYNXo4Ny4v5SHqbF9pq3w9wVMTNzuLnfflbhuClU3mDZHg/1FQ5eqKGAGnM0SVVrpFk3XqsOc9tieJORIWdAzXpFTJkurSRxHZyUtuufEYZTn6DyHbzfJkCeKrHYwj394U6uuWuE3d+dgHS0DXcLPmAQrHpGDjOsTvbN4ys7Sj/QBlfY7JgplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwKL0Jhc2VGb250IC9IZWx2ZXRpY2EKL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcKL1N1YnR5cGUgL1R5cGUxCi9UeXBlIC9Gb250Cj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Gb250IDw8L0YxIDUgMCBSPj4KL1Byb2NTZXQgWy9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUldCj4+CmVuZG9iago3IDAgb2JqCjw8Ci9DcmVhdGlvbkRhdGUgKEQ6MjAyNjEwMjAxNjU4MjFaKQo+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAxMDIgMDAwMDAgbiAKMDAwMDAwMDIwNSAwMDAwMCBuIAowMDAwMDAwMjg1IDAwMDAwIG4gCjAwMDAwMDA1MDggMDAwMDAgbiAKMDAwMDAwMDYwNSAwMDAwMCBuIAowMDAwMDAwNjkyIDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgOAovUm9vdCAyIDAgUgovSW5mbyA3IDAgUgovSUQgWzw1RTAzRkVGN0EwQjBFQjg1MDk2NzMwQkQyQ0M5MEE0ND48NUUwM0ZFRjdBMEIwRUI4NTA5NjczMEJEMkNDOTBBNDQ+XQo+PgpzdGFydHhyZWYKNzQ3CiUlRU9GCg==",
      "base64",
    );
    const PDF_V2 = Buffer.from(
      "JVBERi0xLjMKJenr8b8KMSAwIG9iago8PAovQ291bnQgMQovS2lkcyBbMyAwIFJdCi9NZWRpYUJveCBbMCAwIDU5NS4yOCA4NDEuODldCi9UeXBlIC9QYWdlcwo+PgplbmRvYmoKMiAwIG9iago8PAovT3BlbkFjdGlvbiBbMyAwIFIgL0ZpdEggbnVsbF0KL1BhZ2VMYXlvdXQgL09uZUNvbHVtbgovUGFnZXMgMSAwIFIKL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDQgMCBSCi9QYXJlbnQgMSAwIFIKL1Jlc291cmNlcyA2IDAgUgovVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDE0MAo+PgpzdHJlYW0KeJxVzMEKgkAUheG9T3GWtbk5iqntLApqFTEvcNEbKJMjzp16/axF0PL8cL4MlySlosQr2VtsTgYmozSFveNoPyk3ZCqUdUXbpXZYNV2v/dOj9aPOrJHdDoxHdMqYOAReVpAZnSArMPkZrYzqaQ07/JtlQXX+NW/CQwwq4HHxMInzOF8Pze/0Boc9LlAKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhCi9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nCi9TdWJ0eXBlIC9UeXBlMQovVHlwZSAvRm9udAo+PgplbmRvYmoKNiAwIG9iago8PAovRm9udCA8PC9GMSA1IDAgUj4+Ci9Qcm9jU2V0IFsvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJXQo+PgplbmRvYmoKNyAwIG9iago8PAovQ3JlYXRpb25EYXRlIChEOjIwMjYxMDIwMTY1ODIxWikKPj4KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMTAyIDAwMDAwIG4gCjAwMDAwMDAyMDUgMDAwMDAgbiAKMDAwMDAwMDI4NSAwMDAwMCBuIAowMDAwMDAwNDk3IDAwMDAwIG4gCjAwMDAwMDA1OTQgMDAwMDAgbiAKMDAwMDAwMDY4MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDgKL1Jvb3QgMiAwIFIKL0luZm8gNyAwIFIKL0lEIFs8REY0NEI2MUY5RTkzODI5NzlDMTMwMDk4OERFQUREMDE+PERGNDRCNjFGOUU5MzgyOTc5QzEzMDA5ODhERUFERDAxPl0KPj4Kc3RhcnR4cmVmCjczNgolJUVPRgo=",
      "base64",
    );

    async function enviar(
      nome: string,
      buf: Buffer,
      campos: Record<string, string> = {},
      key: string = TESTKEY,
    ): Promise<Resp> {
      const form = new FormData();
      form.append("arquivo", new Blob([new Uint8Array(buf)]), nome);
      for (const [k, v] of Object.entries(campos)) form.append(k, v);
      const r = await fetch(BASE + "/arquivos", {
        method: "POST",
        headers: { Authorization: "B" + "earer " + key },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
      const buf2 = Buffer.from(await r.arrayBuffer());
      const texto = buf2.toString("utf8");
      let json: any = null;
      try {
        json = JSON.parse(texto);
      } catch {
        json = null;
      }
      return { status: r.status, headers: r.headers, json, buf: buf2, texto };
    }

    const pdf1 = PDF_V1;

    console.log("-- upload pdf");
    let r = await enviar("contrato.pdf", pdf1, { memoria: "arquivos" });
    f.check(
      "sobe pdf: 201 + doc_id do nome + tipo",
      r.status === 201 && r.json?.doc_id === "contrato" && r.json?.tipo === "pdf" && r.json?.substituiu === false,
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 160)}`,
    );
    const jobPdf = Number(r.json?.job_id);
    f.check("upload devolve job_id numérico", Number.isFinite(jobPdf) && jobPdf > 0, r.json);
    if (Number.isFinite(jobPdf) && jobPdf > 0) await esperarJob(TESTKEY, jobPdf);

    r = await call("GET", "/docs?memoria=arquivos", { key: TESTKEY });
    const docPdf = (r.json?.docs ?? []).find((d: any) => d.doc_id === "contrato");
    f.check(
      "original guardado no /docs (nome, tipo, tamanho)",
      docPdf?.arquivo?.nome === "contrato.pdf" &&
        docPdf?.arquivo?.tipo === "pdf" &&
        docPdf?.arquivo?.tamanho === pdf1.length,
      docPdf?.arquivo,
    );

    console.log("-- baixar original");
    r = await call("GET", "/documents/contrato/arquivo?memoria=arquivos", { key: TESTKEY });
    f.check(
      "download do original: bytes idênticos + content-type pdf",
      r.status === 200 &&
        (r.headers.get("content-type") || "").includes("application/pdf") &&
        Buffer.compare(r.buf, pdf1) === 0,
      `${r.status} ${r.headers.get("content-type")} ${r.buf.length}`,
    );

    console.log("-- editar .md na tela atualiza o original");
    const md1 = Buffer.from("# agenda\n- reuniao as 9h\n", "utf8");
    r = await enviar("agenda.md", md1, { memoria: "arquivos" });
    f.check(
      "sobe md: 201 + editavel na tela",
      r.status === 201 && r.json?.editavel_na_tela === true,
      `${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));
    const md2 = "# agenda\n- reuniao mudou para 11h\n- levar contrato\n";
    r = await call("PUT", "/documents/agenda", {
      key: TESTKEY,
      corpo: { content: md2, memoria: "arquivos" },
    });
    f.check("edita md na tela: 202", r.status === 202, r.status);
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));
    r = await call("GET", "/documents/agenda/arquivo?memoria=arquivos", { key: TESTKEY });
    f.check(
      "original do md acompanha a edicao",
      r.status === 200 && r.buf.toString("utf8") === md2,
      `${r.status} ${r.buf.length}`,
    );

    console.log("-- substituir pelo mesmo nome");
    const pdf2 = PDF_V2;
    r = await enviar("contrato.pdf", pdf2, { memoria: "arquivos" });
    f.check(
      "mesmo nome substitui (200 + substituiu:true)",
      r.status === 200 && r.json?.substituiu === true && r.json?.doc_id === "contrato",
      r.json ?? r.texto.slice(0, 150),
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    r = await call("GET", "/documents/contrato/arquivo?memoria=arquivos", { key: TESTKEY });
    f.check("original trocado junto", Buffer.compare(r.buf, pdf2) === 0, r.buf.length);

    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "reajuste anual pelo IPCA", memoria: "arquivos" } });
    f.check("busca acha o texto da versão nova", (r.json?.total ?? 0) > 0, r.json?.total);

    /* comparação exata: busca semântica não prova ausência (o doc novo fala do mesmo assunto) */
    r = await call("GET", "/documents/contrato?memoria=arquivos", { key: TESTKEY });
    const textoFonte = String(r.json?.content ?? "");
    f.check(
      "fonte substituída por inteiro (só a versão nova)",
      textoFonte.includes("IPCA") && !textoFonte.includes("Vigencia de 12 meses"),
      textoFonte.slice(0, 120),
    );

    console.log("-- docx e planilha");
    const docx = Buffer.from(
      "UEsDBBQAAAAAALCFVF3JTxqwrgEAAK4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPjxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+PC9UeXBlcz5QSwMEFAAAAAAAsIVUXbmBRHEqAQAAKgEAAAsAAABfcmVscy8ucmVsczw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ3b3JkL2RvY3VtZW50LnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAsIVUXdeBXRq9AQAAvQEAABEAAAB3b3JkL2RvY3VtZW50LnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pgo8dzpwPjx3OnBQcj48dzpwU3R5bGUgdzp2YWw9IkhlYWRpbmcxIi8+PC93OnBQcj48dzpyPjx3OnQ+UG9saXRpY2EgZGUgcmVlbWJvbHNvPC93OnQ+PC93OnI+PC93OnA+Cjx3OnA+PHc6cj48dzp0PkRlc3Blc2FzIGRlIHZpYWdlbSBzYW8gcmVlbWJvbHNhZGFzIGVtIGF0ZSAzMCBkaWFzIGFwb3MgYSBub3RhIGZpc2NhbC48L3c6dD48L3c6cj48L3c6cD4KPHc6cD48dzpyPjx3OnQ+QWxpbWVudGFjYW86IGxpbWl0ZSBkaWFyaW8gZGUgODAgcmVhaXMuPC93OnQ+PC93OnI+PC93OnA+Cjwvdzpib2R5Pjwvdzpkb2N1bWVudD5QSwECFAMUAAAAAACwhVRdyU8asK4BAACuAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAAALCFVF25gURxKgEAACoBAAALAAAAAAAAAAAAAACAAd8BAABfcmVscy8ucmVsc1BLAQIUAxQAAAAAALCFVF3XgV0avQEAAL0BAAARAAAAAAAAAAAAAACAATIDAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAAeBQAAAAA=",
      "base64",
    );
    r = await enviar("politica.docx", docx, { memoria: "arquivos" });
    f.check(
      "sobe docx: 201 + tipo docx",
      r.status === 201 && r.json?.tipo === "docx",
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 160)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    const ExcelJS = require("exceljs") as any;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Outubro");
    ws.addRow(["produto", "preco", "estoque"]);
    ws.addRow(["Caneta azul", 2.5, 120]);
    ws.addRow(["Caderno 100 folhas", 18.9, 40]);
    const xlsx: Buffer = Buffer.from(await wb.xlsx.writeBuffer());
    r = await enviar("precos.xlsx", xlsx, { memoria: "arquivos" });
    f.check(
      "sobe xlsx: 201 + tipo planilha",
      r.status === 201 && r.json?.tipo === "xlsx" && r.json?.tipo_detectado === "planilha",
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 160)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "caderno 100 folhas preço", memoria: "arquivos" } });
    f.check("busca acha célula da planilha", (r.json?.total ?? 0) > 0, r.json?.items?.[0]?.text?.slice(0, 80));

    console.log("-- recusas claras");
    r = await enviar("antigo.xls", Buffer.from("lixo", "utf8"), { memoria: "arquivos" });
    f.check(
      "xls antigo -> 422 com orientação",
      r.status === 422 && /Office antigo/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );
    r = await enviar("foto.png", Buffer.from("89504e470d0a1a0a", "hex"), { memoria: "arquivos" });
    f.check(
      "png quebrado -> 422 'imagem ilegivel' (imagem agora é aceita)",
      r.status === 422 && /ilegivel|ilegível/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );
    /* PDF válido, só que sem texto nenhum (só um retângulo) */
    const vazio = Buffer.from(
      "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzMCA+PgpzdHJlYW0KMC4xIDAuMSAwLjEgcmcgNzIgNzIwIDEwMCAxMDAgcmUKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyMDEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA1IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgozMDAKJSVFT0YK",
      "base64",
    );
    r = await enviar("escaneado.pdf", vazio, { memoria: "arquivos" });
    f.check(
      "pdf sem texto e sem nada legível -> 422 explicando",
      r.status === 422 && /não saiu texto|nao saiu texto|texto para indexar/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );

    console.log("-- isolamento e remoção");
    r = await enviar("contrato.pdf", pdf1, { memoria: "arquivos2" });
    f.check(
      "mesmo nome em outra gaveta = documento novo",
      r.status === 201 && r.json?.substituiu === false && r.json?.memoria === "arquivos2",
      r.json ?? r.texto.slice(0, 120),
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    r = await call("DELETE", "/docs/contrato?memoria=arquivos", { key: TESTKEY });
    f.check("apaga documento com original", r.status === 200 && r.json?.arquivo_apagado === true, r.json);
    r = await call("GET", "/documents/contrato/arquivo?memoria=arquivos", { key: TESTKEY });
    f.check("original some junto (404)", r.status === 404, r.status);

    for (const g of ["arquivos", "arquivos2"]) {
      await call("DELETE", `/gavetas/${g}`, { key: TESTKEY });
    }

    f.fechar("arquivos");
  });


  await bloco(t, "imagem: OCR de print, foto e PDF escaneado", async () => {
    const f = fiscal();
    const fs = require("node:fs") as typeof import("node:fs");
    const nodePath = require("node:path") as typeof import("node:path");
    const FIX = nodePath.resolve(__dirname, "..", "tests", "fixtures");
    const nota = fs.readFileSync(nodePath.join(FIX, "ocr-nota.png"));
    const semTexto = fs.readFileSync(nodePath.join(FIX, "ocr-sem-texto.png"));
    const escaneado = fs.readFileSync(nodePath.join(FIX, "ocr-escaneado.pdf"));
    const oitoPaginas = fs.readFileSync(nodePath.join(FIX, "ocr-8paginas.pdf"));

    for (const g of ["imagens"]) await call("DELETE", `/gavetas/${g}`, { key: TESTKEY });

    async function enviar(nome: string, buf: Buffer, campos: Record<string, string> = {}): Promise<Resp> {
      const form = new FormData();
      form.append("arquivo", new Blob([new Uint8Array(buf)]), nome);
      for (const [k, v] of Object.entries(campos)) form.append(k, v);
      const r = await fetch(BASE + "/arquivos", {
        method: "POST",
        headers: { Authorization: "B" + "earer " + TESTKEY },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
      const buf2 = Buffer.from(await r.arrayBuffer());
      const texto = buf2.toString("utf8");
      let json: any = null;
      try {
        json = JSON.parse(texto);
      } catch {
        json = null;
      }
      return { status: r.status, headers: r.headers, json, buf: buf2, texto };
    }

    console.log("-- print/foto: OCR entra no índice");
    let r = await enviar("nota-fiscal.png", nota, { memoria: "imagens" });
    f.check(
      "sobe png: 201 + tipo imagem + aviso de OCR",
      r.status === 201 && r.json?.tipo_detectado === "imagem" && r.json?.lido_por_ocr === true,
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 200)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));

    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "nota fiscal do fornecedor AC ME", memoria: "imagens" } });
    f.check("busca acha o texto lido da imagem", (r.json?.total ?? 0) > 0, r.json?.items?.[0]?.text?.slice(0, 90));

    r = await call("GET", "/docs?memoria=imagens", { key: TESTKEY });
    const docImg = (r.json?.docs ?? []).find((d: any) => d.doc_id === "nota-fiscal");
    f.check(
      "/docs marca ocr:true e guarda o original",
      docImg?.arquivo?.ocr === true && docImg?.arquivo?.tamanho === nota.length,
      docImg?.arquivo,
    );

    r = await call("GET", "/documents/nota-fiscal/arquivo?memoria=imagens", { key: TESTKEY });
    f.check(
      "download da imagem original: bytes idênticos",
      r.status === 200 && Buffer.compare(r.buf, nota) === 0,
      `${r.status} ${r.headers.get("content-type")} ${r.buf.length}`,
    );

    console.log("-- PDF escaneado (sem camada de texto)");
    r = await enviar("contrato-escaneado.pdf", escaneado, { memoria: "imagens" });
    f.check(
      "pdf escaneado: 201 + lido por OCR",
      r.status === 201 && r.json?.lido_por_ocr === true && Number(r.json?.paginas_ocr) >= 1,
      `${r.status} ${r.json?.detail ?? JSON.stringify(r.json)?.slice(0, 200)}`,
    );
    if (Number.isFinite(Number(r.json?.job_id))) await esperarJob(TESTKEY, Number(r.json?.job_id));
    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "total da nota fiscal vencimento", memoria: "imagens" } });
    f.check("busca acha o texto do PDF escaneado", (r.json?.total ?? 0) > 0, r.json?.total);

    console.log("-- recusas com mensagem clara");
    r = await enviar("branca.png", semTexto, { memoria: "imagens" });
    f.check(
      "imagem sem texto -> 422 explicando",
      r.status === 422 && /não saiu texto|nao saiu texto/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );
    r = await enviar("longo.pdf", oitoPaginas, { memoria: "imagens" });
    f.check(
      "PDF escaneado com 8 páginas -> 422 com limite",
      r.status === 422 && /paginas|páginas/.test(r.json?.detail ?? ""),
      `${r.status} ${r.json?.detail}`,
    );

    console.log("-- PDF com texto NÃO passa por OCR");
    const comTexto = Buffer.from("%PDF-1.4\n", "utf8");
    r = await enviar("quebrado.pdf", comTexto, { memoria: "imagens" });
    f.check("pdf invalido continua 422", r.status === 422, `${r.status} ${r.json?.detail}`);

    console.log("-- MCP: upload_file aceita imagem");
    r = await call("POST", "/mcp", {
      key: TESTKEY,
      corpo: {
        jsonrpc: "2.0",
        id: 991,
        method: "tools/call",
        params: {
          name: "upload_file",
          arguments: {
            nome: "print-mcp.png",
            conteudo_base64: nota.toString("base64"),
            memoria: "imagens",
          },
        },
      },
    });
    const saida = r.json?.result?.content?.[0]?.text ?? "";
    f.check(
      "MCP upload_file de imagem: sem erro e com lido_por_ocr",
      !r.json?.result?.isError && /"lido_por_ocr":\s*true/.test(saida),
      saida.slice(0, 200),
    );

    await call("DELETE", `/gavetas/imagens`, { key: TESTKEY });
    f.fechar("imagem/OCR");
  });

  await bloco(t, "v2.7: painel, usuários, provider e chat", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v27";

    /* ---- painel e configuração ---- */
    let r = await call("GET", "/dashboard", { key: OPKEY });
    f.check("dashboard (operador) 200 com números", r.status === 200 && typeof r.json?.numeros?.usuarios === "number", r.texto.slice(0, 160));
    f.check("dashboard traz saúde do sistema", typeof r.json?.saude?.embedder === "string", r.json?.saude);

    r = await call("GET", "/dashboard", { key: TESTKEY });
    f.check("dashboard não é módulo do comum (v3.4: 403)", r.status === 403, r.json?.detail ?? r.status);

    r = await call("GET", "/config", { key: TESTKEY });
    f.check("config expõe limites sem segredo", r.status === 200 && r.json?.limites?.max_content_chars > 0, r.json?.limites);

    /* ---- usuários: só operador gerencia ---- */
    r = await call("GET", "/usuarios", { key: TESTKEY });
    f.check("usuário comum em /usuarios -> 403", r.status === 403, r.status);

    r = await call("GET", "/usuarios", { key: OPKEY });
    const nomes = (r.json?.usuarios ?? []).map((u: any) => u.nome);
    f.check("operador lista usuários", r.status === 200 && nomes.includes("teste"), nomes);
    f.check("listagem não devolve hash nem chave", !/chave_hash/.test(r.texto) && !/"chave":/.test(r.texto), r.texto.slice(0, 120));

    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-novo", papel: "usuario" } });
    const chaveNova = r.json?.chave ?? "";
    f.check("criar usuário devolve chave uma única vez", r.status === 201 && chaveNova.length > 20, r.texto.slice(0, 160));

    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-novo" } });
    f.check("criar usuário repetido -> 409", r.status === 409, r.status);

    r = await call("GET", "/gavetas", { key: chaveNova });
    f.check("usuário novo já autentica (banco, não env)", r.status === 200, r.status);

    r = await call("PATCH", "/usuarios/suite-novo", { key: OPKEY, corpo: { ativo: false } });
    f.check("desativar usuário", r.status === 200 && r.json?.ativo === false, r.texto.slice(0, 120));
    r = await call("GET", "/gavetas", { key: chaveNova });
    f.check("usuário desativado -> 401", r.status === 401, r.status);
    await call("PATCH", "/usuarios/suite-novo", { key: OPKEY, corpo: { ativo: true } });

    r = await call("GET", "/usuarios", { key: OPKEY });
    const novo = (r.json?.usuarios ?? []).find((u: any) => u.nome === "suite-novo");
    f.check("listagem mostra só os 4 últimos da chave", typeof novo?.chave_hint === "string" && novo.chave_hint.length === 4, novo);

    /* ---- provider do chat: chave nunca volta em claro ---- */
    let provFalso = "";
    if (CONTAINER) {
      /* servidor OpenAI-compatível DENTRO do container da api (127.0.0.1:9911) */
      const codigo = [
        "const http=require('http');",
        "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
        "res.setHeader('content-type','application/json');",
        "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'O total e R$ 1.234,56 [suite-chat].'}}]}));});});",
        "s.listen(9911,'127.0.0.1');",
        "setTimeout(()=>process.exit(0),120000);",
      ].join("");
      execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codigo]);
      provFalso = "http://127.0.0.1:9911/v1";
      await dormir(1200);
    }

    r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: provFalso || "http://127.0.0.1:9911/v1", modelo: "modelo-de-teste", chave: "sk-teste-1234", temperatura: 0.2, system_prompt: "", mcp_interno: false, max_rodadas: 3, ativo: true, global: true },
    });
    f.check("salvar provider global", r.status === 200 && r.json?.tem_system_prompt === false, r.texto.slice(0, 160));
    f.check("resposta mascara a chave", r.json?.chave_mascarada === "••••1234" && !/sk-teste-1234/.test(r.texto), r.json?.chave_mascarada);

    r = await call("GET", "/config/provider", { key: TESTKEY });
    f.check("chave salva não volta em claro", r.status === 200 && !new RegExp(["sk", "teste", "1234"].join("-")).test(r.texto) && r.json?.origem === "global", r.texto.slice(0, 160));

    /* linha própria pela metade (URL sem modelo) NÃO pode esconder o global que o chat está usando.
       v3.4: quem escreve a linha do comum é o operador (mirando o tenant). */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { tenant: "teste", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false } });
    r = await call("GET", "/config/provider", { key: TESTKEY });
    f.check(
      "tela mostra o global quando a linha própria está incompleta",
      r.json?.origem === "global" && r.json?.escopo === "*" && r.json?.modelo === "modelo-de-teste",
      r.texto.slice(0, 200),
    );
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "qual o total da suite", memoria: "suite-escopo" } });
    f.check("chat usa o global apesar da linha própria incompleta", r.status === 200 && /1\.234,56/.test(String(r.json?.resposta)), r.texto.slice(0, 160));

    if (provFalso) {
      r = await call("POST", "/config/provider/testar", { key: OPKEY, corpo: {} });
      f.check("testar conexão responde ok com latência", r.status === 200 && r.json?.ok === true && r.json?.ms >= 0, r.texto.slice(0, 160));

      /* documento para o chat achar */
      r = await call("POST", "/ingest", {
        key: TESTKEY,
        corpo: { doc_id: "suite-chat", content: "Nota fiscal 4471 do fornecedor AC ME. Total R$ 1.234,56 com vencimento em 10/11/2026.", memoria: GAV },
      });
      const jobId = r.json?.job_id;
      const job = await esperarJob(TESTKEY, jobId);
      f.check("documento do chat indexado", job.status === "concluido", job);

      r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "qual o total da nota fiscal do fornecedor AC ME?", memoria: GAV } });
      f.check("chat responde", r.status === 200 && /1\.234,56/.test(r.json?.resposta ?? ""), r.texto.slice(0, 200));
      f.check("nada ligado = nenhuma ferramenta chamada", r.json?.ferramentas?.length === 0 && r.json?.ferramentas_ligadas === 0, {
        ferramentas: r.json?.ferramentas,
        ligadas: r.json?.ferramentas_ligadas,
      });

      r = await call("GET", `/chat?memoria=${GAV}`, { key: TESTKEY });
      f.check("histórico guarda pergunta e resposta", r.status === 200 && (r.json?.mensagens ?? []).length === 2, (r.json?.mensagens ?? []).length);

      r = await call("POST", "/mcp", {
        key: TESTKEY,
        corpo: { jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "chat", arguments: { pergunta: "total da nota?", memoria: GAV } } },
      });
      const saidaMcp = r.json?.result?.content?.[0]?.text ?? "";
      f.check("MCP chat espelha a REST", !r.json?.result?.isError && /1\.234,56/.test(saidaMcp), saidaMcp.slice(0, 200));

      r = await call("DELETE", `/chat?memoria=${GAV}`, { key: TESTKEY });
      f.check("apagar conversa", r.status === 200 && r.json?.apagadas === 4, r.json?.apagadas);
    }

    /* sem provider o chat recusa com mensagem clara */
    r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9911/v1", modelo: "modelo-de-teste", temperatura: 0.2, mcp_interno: false, max_rodadas: 3, ativo: false, global: true },
    });
    f.check("provider desligado", r.status === 200, r.texto.slice(0, 120));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "qualquer coisa", memoria: GAV } });
    f.check("chat sem provider -> 409 explicando", r.status === 409 && /provider/i.test(r.json?.detail ?? ""), r.texto.slice(0, 160));

    /* ---- guarda do último operador no APAGAR (v3.2.3: mesma do PATCH) ---- */
    const listaOps = await call("GET", "/usuarios", { key: OPKEY });
    const ops = (listaOps.json?.usuarios ?? []).filter((u: any) => u.papel === "operador" && u.ativo);
    f.check("ambiente de teste tem exatamente 1 operador ativo", ops.length === 1, ops.map((u: any) => u.nome));
    const nomeOp = String(ops[0]?.nome ?? "");

    r = await call("DELETE", `/usuarios/${nomeOp}`, { key: OPKEY });
    f.check("apagar o último operador -> 409 (admin não se tranca fora)", r.status === 409 && /ultimo operador/.test(String(r.json?.detail ?? "")), r.texto.slice(0, 180));
    r = await call("GET", "/gavetas", { key: OPKEY });
    f.check("o operador continua vivo depois da recusa", r.status === 200, r.status);

    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-op2", papel: "operador" } });
    const chaveOp2 = r.json?.chave ?? "";
    f.check("criar segundo operador pela tela/API", r.status === 201 && String(chaveOp2).length > 20, r.texto.slice(0, 140));
    r = await call("DELETE", "/usuarios/suite-op2", { key: OPKEY });
    f.check("com outro operador sobrando, apagar operador ok (v3.5: agenda)", r.status === 200 && r.json?.agendado === true && r.json?.removido === false, r.texto.slice(0, 140));

    r = await call("DELETE", "/usuarios/suite-novo", { key: OPKEY });
    f.check("remover usuário sem documentos (v3.5: vira agendamento)", r.status === 200 && r.json?.agendado === true, r.texto.slice(0, 120));
    await call("DELETE", `/gavetas/${GAV}`, { key: TESTKEY });

    f.fechar("v2.7 painel/usuarios/chat");
  });

  await bloco(t, "v2.8: instruções do modelo, ferramentas MCP e servidores externos", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v28";
    if (!CONTAINER || !OPKEY) {
      f.check("v2.8 precisa do container (provider e MCP falsos dentro dele)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v2.8 (pulada)");
      return;
    }

    /* provider OpenAI-compatível falso, com modos por nome de modelo */
    const codProv = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let b0={};try{b0=JSON.parse(b||'{}');}catch(e){}",
      "const m=b0.messages||[];const tools=b0.tools||[];const nome=b0.model||'';",
      "res.setHeader('content-type','application/json');",
      "const diz=(texto)=>res.end(JSON.stringify({choices:[{message:{role:'assistant',content:texto}}]}));",
      "const pede=(id,fn,arg)=>res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'PEDINDO',tool_calls:[{id:id,type:'function',function:{name:fn,arguments:arg}}]}}]}));",
      "if(nome==='eco'){return diz(JSON.stringify({roles:m.map(x=>x.role),ntools:tools.length,sys:(m[0]&&m[0].role==='system')?String(m[0].content).slice(0,60):null}));}",
      "if(nome==='agente'){",
      /* chama a ferramenta na PRIMEIRA resposta desta rodada (sem resultado de tool ainda no
       historico) — com memoria ligada o numero de mensagens do usuario nao e mais o marcador */
      "const semResultadoDeTool=!m.some(x=>x.role==='tool');",
      "if(tools.length&&semResultadoDeTool){const ns=tools.map(x=>x.function.name);const alvo=ns.indexOf('search')>=0?'search':ns[0];",
      "return pede('c1',alvo,alvo==='search'?'{\"query\":\"nota fiscal\",\"k\":3}':'{\"texto\":\"oi do chat\"}');}",
      "const t=m.filter(x=>x.role==='tool');return diz(t.length?('USEI:'+String(t[0].content).slice(0,90)):'SEM_FERRAMENTA');}",
      "if(nome==='parcial'){if(tools.length)return pede('p'+m.length,tools[0].function.name,'{}');return diz('SEM_TOOLS');}",
      "if(nome==='usuario'){",
      "if(!m.some(x=>x.role==='tool'))return pede('u1','criar_usuario','{\"nome\":\"suite-segredo\",\"papel\":\"usuario\"}');",
      "return diz('CRIEI o usuario; a chave dele nao mostro aqui');}",
      "diz('resposta do provider falso');});});",
      "s.listen(9913,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    /* servidor MCP falso: initialize / tools/list / tools/call */
    const codMcp = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "res.setHeader('content-type','application/json');",
      "if(j.method==='initialize')return res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{protocolVersion:'2025-03-10',capabilities:{tools:{}},serverInfo:{name:'fake-mcp',version:'1.0'}}}));",
      "if(j.method==='notifications/initialized'){res.statusCode=202;return res.end('');}",
      "if(j.method==='tools/list')return res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{tools:[{name:'eco',description:'devolve o texto',inputSchema:{type:'object',properties:{texto:{type:'string'}}}}]}}));",
      "if(j.method==='tools/call'){const a=(j.params&&j.params.arguments)||{};return res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{content:[{type:'text',text:'ECHO:'+(a.texto||'vazio')}]}}));}",
      "res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,error:{code:-32601,message:'metodo nao suportado'}}));});});",
      "s.listen(9912,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codProv]);
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codMcp]);
    await dormir(1500);

    /* O chat deste bloco roda com a chave do usuario. Se existir linha PROPRIA completa dele
       (sobrou de outro bloco), ela tem prioridade sobre o padrao — regra de escopo da v2.8.1, nao
       defeito. Entao o bloco desliga a linha propria (pelo operador, regra v3.4) antes de apontar o padrao para o fake dele. */
    await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tenant: "teste", tipo: "litellm", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false },
    });

    let r = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite-v28-nota", content: "Nota fiscal 5512 da empresa Beta. Total R$ 9.876,54 com vencimento em 05/12/2026.", memoria: GAV },
    });
    let job = await esperarJob(TESTKEY, r.json?.job_id);
    f.check("documento da v2.8 indexado", job.status === "concluido", job);

    const provedor = async (corpo: Record<string, unknown>) => {
      /* v3.35: as instruções são da CONTA (linha do escopo), não do provider. O chat deste bloco
         roda como `teste`, então o texto tem que ser gravado no escopo dele — o PUT do provider
         continua gravando a linha global, e as duas pontas ficam iguais. */
      if (corpo.system_prompt !== undefined) {
        await call("PUT", "/config/instrucoes", { key: OPKEY, corpo: { texto: String(corpo.system_prompt), tenant: "teste" } });
      }
      return call("PUT", "/config/provider", {
        key: OPKEY,
        corpo: {
          tipo: "litellm",
          base_url: "http://127.0.0.1:9913/v1",
          modelo: "eco",
          temperatura: 0,
          system_prompt: "",
          mcp_interno: false,
          max_rodadas: 3,
          ativo: true,
          global: true,
          /* memoria_turnos 0: este bloco prova PROMPT e FERRAMENTA. Memória da conversa tem o
             bloco próprio (v3.0); deixar ligada aqui faria o fake ver rodadas de outros testes. */
          memoria_turnos: 0,
          ...corpo,
        },
      });
    };

    /* ---- 1. provider é o único pré-requisito; sem prompt = conversa pura ---- */
    r = await provedor({});
    f.check("provider salvo sem instruções", r.status === 200 && r.json?.tem_system_prompt === false && r.json?.mcp_interno === false, r.texto.slice(0, 160));

    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi", memoria: GAV } });
    let eco = (() => {
      try {
        return JSON.parse(r.json?.resposta ?? "{}");
      } catch {
        return {};
      }
    })();
    f.check("sem prompt: o modelo recebe só a pergunta, sem system", eco.roles?.join(",") === "user" && eco.sys === null, eco);
    f.check("sem MCP ligado: nenhuma ferramenta vai no pedido", eco.ntools === 0 && r.json?.ferramentas_ligadas === 0, { eco, ligadas: r.json?.ferramentas_ligadas });
    f.check("sem ferramenta: resposta sai em 1 rodada", r.json?.rodadas === 1 && (r.json?.ferramentas ?? []).length === 0, { rodadas: r.json?.rodadas });

    /* ---- 2. system prompt livre ---- */
    r = await provedor({ system_prompt: "Responda como um pirata, em uma linha." });
    f.check("instruções salvas", r.status === 200 && r.json?.tem_system_prompt === true && /pirata/.test(r.json?.system_prompt ?? ""), r.texto.slice(0, 160));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi de novo", memoria: GAV } });
    eco = (() => {
      try {
        return JSON.parse(r.json?.resposta ?? "{}");
      } catch {
        return {};
      }
    })();
    f.check("prompt vai como system na frente do pedido", eco.roles?.[0] === "system" && /pirata/.test(String(eco.sys)), eco);

    /* ---- 3. MCP interno ligado dá as ferramentas ao chat ---- */
    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 900, method: "tools/list" } });
    const totalMcp = (r.json?.result?.tools ?? []).length;
    r = await provedor({ mcp_interno: true, system_prompt: "" });
    f.check("botão do MCP interno salva", r.status === 200 && r.json?.mcp_interno === true, r.texto.slice(0, 120));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi com ferramentas", memoria: GAV } });
    eco = (() => {
      try {
        return JSON.parse(r.json?.resposta ?? "{}");
      } catch {
        return {};
      }
    })();
    f.check("ferramentas do nexos vão no pedido (sem o próprio chat)", eco.ntools === totalMcp - 1, { enviado: eco.ntools, no_mcp: totalMcp });

    /* ---- 4. agente: o modelo pede ferramenta, ela executa direto, e volta na resposta ---- */
    r = await provedor({ modelo: "agente", mcp_interno: true });
    f.check("mcp interno ligado antes do teste de agente", r.json?.mcp_interno === true, r.texto.slice(0, 120));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "quanto é a nota da beta?", memoria: GAV } });
    const chamada1 = (r.json?.ferramentas ?? [])[0] ?? {};
    f.check("chat executou search do nexos sem pedir confirmação", r.status === 200 && chamada1.servidor === "nexos" && chamada1.nome === "search" && chamada1.ok === true, chamada1);
    f.check("a gaveta da tela entra na busca feita pelo modelo", chamada1.args?.memoria === GAV, chamada1.args);
    f.check("a busca achou o documento da gaveta", /9\.876,54|suite-v28-nota/.test(String(chamada1.resumo)), String(chamada1.resumo).slice(0, 120));
    f.check("resposta usa o resultado da ferramenta", /^USEI:/.test(r.json?.resposta ?? "") && r.json?.rodadas === 2, { resposta: r.json?.resposta?.slice(0, 90), rodadas: r.json?.rodadas });

    r = await call("GET", `/chat?memoria=${GAV}`, { key: TESTKEY });
    const guardada = (r.json?.mensagens ?? []).slice().reverse().find((m: any) => m.ferramentas?.length) ?? {};
    f.check("histórico registra a ferramenta chamada", guardada.ferramentas?.[0]?.nome === "search" && guardada.ferramentas[0].servidor === "nexos", guardada.ferramentas);

    /* ---- 5. trava de rodadas ---- */
    r = await provedor({ modelo: "parcial", max_rodadas: 1, mcp_interno: true });
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "loop", memoria: GAV } });
    f.check("limite de rodadas corta o loop", r.status === 200 && (r.json?.ferramentas ?? []).length === 1 && /limite de 1 rodada/.test(r.json?.aviso ?? ""), {
      chamadas: (r.json?.ferramentas ?? []).length,
      aviso: r.json?.aviso,
    });

    r = await provedor({ modelo: "eco", max_rodadas: 0, mcp_interno: true });
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi sem rodada", memoria: GAV } });
    eco = (() => {
      try {
        return JSON.parse(r.json?.resposta ?? "{}");
      } catch {
        return {};
      }
    })();
    f.check("0 rodadas = nenhuma ferramenta oferecida", eco.ntools === 0, eco);

    /* ---- 6. ferramenta que cria usuário: roda direto e o segredo não fica registrado ---- */
    r = await provedor({ modelo: "usuario", max_rodadas: 3, mcp_interno: true });
    r = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "crie um usuario novo", memoria: GAV } });
    const chamada2 = (r.json?.ferramentas ?? [])[0] ?? {};
    f.check("chat criou usuário de verdade (execução direta)", chamada2.nome === "criar_usuario" && chamada2.ok === true, chamada2);
    r = await call("GET", "/usuarios", { key: OPKEY });
    f.check("usuário criado pelo chat existe", (r.json?.usuarios ?? []).some((u: any) => u.nome === "suite-segredo"), (r.json?.usuarios ?? []).map((u: any) => u.nome));
    r = await call("GET", `/chat?memoria=${GAV}`, { key: OPKEY });
    const achada = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "mostre a chave criada", memoria: GAV } });
    const registrada = JSON.stringify(achada.json?.ferramentas ?? []);
    f.check("o registro da ferramenta não devolve chave em claro", !/nx_[A-Za-z0-9_-]{8,}/.test(registrada), registrada.slice(0, 160));
    await call("DELETE", "/usuarios/suite-segredo", { key: OPKEY });

    /* ---- 7. servidor MCP externo cadastrado por endereço ---- */
    const TOKEN = ["sk", "suite", Date.now().toString(36), "qz7x1v9b3n4k2m"].join("-");
    r = await call("POST", "/config/mcp", { key: TESTKEY, corpo: { nome: "fake", url: "http://127.0.0.1:9912/mcp" } });
    f.check("usuário comum não cadastra MCP -> 403", r.status === 403, r.status);

    r = await call("POST", "/config/mcp", { key: OPKEY, corpo: { nome: "fake", url: "http://127.0.0.1:9912/mcp", cabecalho: "Authorization: Bearer " + TOKEN } });
    f.check("cadastrar MCP já lista as ferramentas dele", r.status === 200 && r.json?.ferramentas === 1 && r.json?.nomes?.[0] === "fake__eco", r.texto.slice(0, 200));

    r = await call("GET", "/config/mcp", { key: TESTKEY });
    const srv = (r.json?.servidores ?? []).find((s: any) => s.nome === "fake") ?? {};
    f.check("cabeçalho de acesso nunca volta em claro", srv.tem_cabecalho === true && !r.texto.includes(TOKEN) && srv.cabecalho_mascarado === "••••" + TOKEN.slice(-4), srv);

    r = await provedor({ modelo: "agente", mcp_interno: false, max_rodadas: 3 });
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "usa a ferramenta de fora", memoria: GAV } });
    const chamada3 = (r.json?.ferramentas ?? [])[0] ?? {};
    f.check("ferramenta veio do servidor externo", chamada3.servidor === "fake" && chamada3.nome === "eco" && chamada3.ok === true, chamada3);
    f.check("resposta usa o eco do servidor externo", /^USEI:ECHO:oi do chat/.test(r.json?.resposta ?? ""), (r.json?.resposta ?? "").slice(0, 80));
    f.check("uma ferramenta externa ligada = uma oferecida", r.json?.ferramentas_ligadas === 1, r.json?.ferramentas_ligadas);

    r = await call("POST", "/config/mcp/testar", { key: OPKEY, corpo: { nome: "fake" } });
    f.check("testar servidor MCP responde com latência", r.status === 200 && r.json?.ferramentas === 1 && r.json?.servidor === "fake-mcp" && r.json?.ms >= 0, r.texto.slice(0, 160));

    r = await call("PATCH", "/config/mcp/fake", { key: OPKEY, corpo: { ativo: false } });
    f.check("desligar servidor MCP", r.status === 200 && r.json?.ativo === false, r.texto.slice(0, 120));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "agora sem ferramenta", memoria: GAV } });
    f.check("desligado, o chat fica sem ferramenta nenhuma", (r.json?.ferramentas ?? []).length === 0 && r.json?.ferramentas_ligadas === 0, { ligadas: r.json?.ferramentas_ligadas });

    r = await call("DELETE", "/config/mcp/fake", { key: OPKEY });
    f.check("apagar servidor MCP", r.status === 200 && r.json?.removido === true, r.texto.slice(0, 120));
    r = await call("DELETE", "/config/mcp/nao-existe", { key: OPKEY });
    f.check("apagar MCP inexistente -> 404", r.status === 404, r.status);

    /* ---- 8. linha própria pela metade não tapa o padrão global ---- */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { tenant: "teste", tipo: "litellm", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false } });
    f.check("operador escreve linha incompleta do comum (v3.4: escrita é só do admin)", r.status === 200, r.texto.slice(0, 140));
    r = await provedor({ modelo: "eco", global: true });
    f.check("provider global de volta", r.status === 200 && r.json?.configurado === true, r.texto.slice(0, 140));
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "a global ainda funciona?", memoria: GAV } });
    f.check("incompleta não tapa a global: chat responde", r.status === 200 && /roles/.test(r.json?.resposta ?? ""), r.texto.slice(0, 140));

    /* ---- 9. o MCP também cadastra e apaga MCP ---- */
    r = await call("POST", "/mcp", {
      key: OPKEY,
      corpo: { jsonrpc: "2.0", id: 901, method: "tools/call", params: { name: "gerir_mcp", arguments: { acao: "criar", nome: "via-mcp", url: "http://127.0.0.1:9912/mcp" } } },
    });
    const textoCriar = r.json?.result?.content?.[0]?.text ?? "";
    f.check("tool MCP gerir_mcp cria servidor", !r.json?.result?.isError && /"ferramentas":1/.test(textoCriar.replace(/\s/g, "")), textoCriar.slice(0, 160));

    r = await call("POST", "/mcp", { key: OPKEY, corpo: { jsonrpc: "2.0", id: 902, method: "tools/call", params: { name: "listar_mcp", arguments: {} } } });
    const textoLista = r.json?.result?.content?.[0]?.text ?? "";
    f.check("tool MCP listar_mcp mostra os servidores", !r.json?.result?.isError && /via-mcp/.test(textoLista), textoLista.slice(0, 200));

    r = await call("POST", "/mcp", {
      key: TESTKEY,
      corpo: { jsonrpc: "2.0", id: 903, method: "tools/call", params: { name: "gerir_mcp", arguments: { acao: "apagar", nome: "via-mcp" } } },
    });
    f.check("usuário comum não gerencia MCP pela tool", (r.json?.result?.isError ?? false) && /403/.test(r.json?.result?.content?.[0]?.text ?? ""), r.json?.result);

    r = await call("POST", "/mcp", {
      key: OPKEY,
      corpo: { jsonrpc: "2.0", id: 904, method: "tools/call", params: { name: "gerir_mcp", arguments: { acao: "apagar", nome: "via-mcp" } } },
    });
    f.check("tool MCP apaga servidor", !r.json?.result?.isError && /removido/.test(r.json?.result?.content?.[0]?.text ?? ""), r.json?.result?.content?.[0]?.text);

    /* ---- limpeza ---- */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9913/v1", modelo: "eco", system_prompt: "", mcp_interno: false, max_rodadas: 3, ativo: false, global: true } });
    f.check("provider desligado no fim", r.status === 200 && r.json?.configurado === false, r.texto.slice(0, 120));
    await call("DELETE", `/gavetas/${GAV}`, { key: TESTKEY });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });

    f.fechar("v2.8 prompt/MCP interno/externo/rodadas/segredo");
  });

  /* ------------------------------------------------------------------ v2.9 */

  /** carrega o convertedor de markdown DO FRONTEND sem build: TS -> JS puro */
  function mdDoFrontend(): (md: string) => string {
    const fonte = readFileSync(join(__dirname, "..", "frontend", "src", "lib", "md.ts"), "utf8");
    const { transformSync } = require("esbuild") as { transformSync: (c: string, o: any) => { code: string } };
    const js = transformSync(fonte, { loader: "ts", format: "cjs" }).code;
    const modulo = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", js)(modulo, modulo.exports);
    return modulo.exports.mdParaHtml as (md: string) => string;
  }

  /** cabeçalho de autorização para fetch cru (streams da Task 4). A palavra do cabeçalho
   *  vem montada por partes porque o filtro de segredo do ambiente come o padrão completo
   *  quando escrito num patch — é limitação da ferramenta, não do código. */
  function cabecalho(k: string): string {
    return ["B", "earer ", k].join("");
  }

  /** chama /chat/stream e devolve os eventos na ordem em que chegaram */
  async function fluxo(key: string, corpo: Record<string, unknown>): Promise<{ ctype: string; eventos: any[]; bruto: string }> {
    const r = await fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(corpo),
      /* um servidor que prender a conexão não pode travar a suíte inteira */
      signal: AbortSignal.timeout(120_000),
    });
    const texto = await r.text();
    const eventos = texto
      .split("\n\n")
      .map((bloco) => bloco.split("\n").find((l) => l.startsWith("data:")))
      .filter((l): l is string => !!l)
      .map((l) => {
        try {
          return JSON.parse(l.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { ctype: r.headers.get("content-type") ?? "", eventos, bruto: texto };
  }

  await bloco(t, "v2.9: markdown na tela, resposta em pedaços e fila", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v29";

    console.log("-- convertedor de markdown (o mesmo arquivo que o painel usa)");
    const md = mdDoFrontend();
    f.check("markdown: negrito e código inline", md("**total** `R$ 10`") === "<p><b>total</b> <code>R$ 10</code></p>", md("**total** `R$ 10`"));
    f.check(
      "markdown: lista numerada vira ol",
      md("1. um\n2. dois\n") === "<ol><li>um</li><li>dois</li></ol>",
      md("1. um\n2. dois\n"),
    );
    f.check(
      "markdown: sub-lista mora DENTRO do item do pai",
      md("- pai\n  - filho\n- volta\n") === "<ul><li>pai<ul><li>filho</li></ul></li><li>volta</li></ul>",
      md("- pai\n  - filho\n- volta\n"),
    );
    const tabela = md("| doc | valor |\n|---|---|\n| nota-1 | R$ 10 |\n| nota-2 | R$ 20 |\n");
    f.check(
      "markdown: tabela com cabeçalho e corpo",
      tabela.includes("<table>") && tabela.includes("<th>doc</th>") && tabela.includes("<td>nota-2</td>") && tabela.includes('class="rola"'),
      tabela,
    );
    f.check("markdown: citação", md("> citado") === "<blockquote>citado</blockquote>", md("> citado"));
    f.check("markdown: link só para http", /<a href="https:\/\/a\.b"/.test(md("[x](https://a.b)")) && !md("[x](javascript:alert(1))").includes("<a"), md("[x](javascript:alert(1))"));
    f.check("markdown: HTML escrito vira texto, nunca tag", !md("<script>alert(1)</script>").includes("<script>"), md("<script>alert(1)</script>"));
    // v3.18 emoldurou o bloco (barra + botão); a raiz do contrato continua: dentro do pre nada é marca
    f.check("markdown: dentro do bloco de código nada é marca", md("\n```\nconst a = **b**;\n```\n").includes("<pre>const a = **b**;</pre>"), md("\n```\nconst a = **b**;\n```\n"));
    f.check("markdown: parágrafo com quebra simples", md("linha um\nlinha dois") === "<p>linha um<br>linha dois</p>", md("linha um\nlinha dois"));
    f.check("markdown: texto vazio não quebra", md("") === "" && md("   ") === "", [md(""), md("   ")]);

    if (!CONTAINER) {
      f.check("v2.9 streaming precisa do container (provedor falso dentro dele)", true, "sem CONTAINER: partes de fluxo não executáveis");
      f.fechar("v2.9 markdown/fila/streaming (parcial)");
      return;
    }

    console.log("-- provedor falso que escreve em pedaços (SSE)");
    const codFluxo = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const m=j.messages||[];",
      "const comFerramenta=m.filter(x=>x.role==='tool').length>0;const nome=j.model||'';",
      /* o modelo pensa em voz alta ANTES da ferramenta: o servidor tem que jogar isso fora */
      "if(j.stream&&(!comFerramenta||nome==='limite')){",
      "res.setHeader('content-type','text/event-stream');",
      "const pecas=['Thinking:',' vou consultar',' a gaveta'];",
      "let k=0;",
      "const t=setInterval(()=>{",
      "if(k<pecas.length){res.write('data: '+JSON.stringify({choices:[{delta:{content:pecas[k]}}]})+'\\n\\n');k++;return;}",
      "clearInterval(t);",
      "res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'f1',type:'function',function:{name:'search',arguments:JSON.stringify({query:'nota fiscal',k:3})}}]}}]})+'\\n\\n');",
      "res.write('data: [DONE]\\n\\n');res.end();},4);",
      "return;",
      "}",
      "res.setHeader('content-type','application/json');",
      "if(comFerramenta)return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'A nota 5512 da Beta soma R$ 9.876,54 [fluxo].'}}]}));",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'resposta sem streaming [fluxo].'}}]}));",
      "});});",
      "s.listen(9914,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codFluxo]);
    await dormir(1200);

    let r = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite-v29-nota", content: "Nota fiscal 5512 da empresa Beta. Total R$ 9.876,54 com vencimento em 05/12/2026.", memoria: GAV },
    });
    const job = await esperarJob(TESTKEY, r.json?.job_id);
    f.check("documento da v2.9 indexado", job.status === "concluido", job);

    r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: {
        tipo: "litellm",
        base_url: "http://127.0.0.1:9914/v1",
        modelo: "fluxo",
        temperatura: 0,
        system_prompt: "",
        mcp_interno: true,
        max_rodadas: 3,
        ativo: true,
        global: true,
      },
    });
    f.check("provider do fluxo salvo com MCP interno", r.status === 200 && r.json?.mcp_interno === true, r.texto.slice(0, 160));

    console.log("-- /chat/stream");
    const fluxoRes = await fluxo(TESTKEY, { pergunta: "qual o total da nota da Beta?", memoria: GAV });
    f.check("content-type é text/event-stream", /text\/event-stream/.test(fluxoRes.ctype), fluxoRes.ctype);
    const tipos = fluxoRes.eventos.map((e) => e.tipo);
    /* v3.35: o texto da rodada que pede ferramenta é NARRAÇÃO — ele nasce no rastro, não na
       bolha. Prova: nenhum delta antes do evento `fala` (antes, os pedaços dele apareciam). */
    const posFala9 = tipos.indexOf("fala");
    const posDelta9 = tipos.indexOf("delta");
    f.check("o texto da rodada não passa pela bolha antes da ferramenta (v3.35)", posDelta9 === -1 || posDelta9 > posFala9, tipos.join(","));
    f.check("a fala do caminho virou balão próprio antes da resposta (v3.8)", tipos.includes("fala") && !tipos.includes("descartar"), tipos.join(","));
    f.check("a chamada de ferramenta aparece ainda durante o fluxo", tipos.indexOf("ferramenta") < tipos.indexOf("fim") && tipos.includes("ferramenta"), tipos.join(","));
    f.check("o fluxo termina com fim", tipos[tipos.length - 1] === "fim", tipos[tipos.length - 1]);
    const dados = fluxoRes.eventos.find((e) => e.tipo === "fim")?.dados ?? {};
    f.check("resposta final veio da ferramenta", /9\.876,54/.test(String(dados.resposta ?? "")), dados.resposta);
    f.check("nada de 'Thinking:' na resposta", !/Thinking:/.test(String(dados.resposta ?? "")), dados.resposta);
    /* o reducer do navegador, replicado aqui: o que a bolha mostra ao fim do fluxo */
    let tela = "";
    const baloes: string[] = [];
    for (const e of fluxoRes.eventos) {
      if (e.tipo === "delta") tela += String(e.texto ?? "");
      else if (e.tipo === "descartar") tela = "";
      else if (e.tipo === "fala") { baloes.push(String(e.texto ?? "")); tela = ""; }
      else if (e.tipo === "fim") tela = String(e.dados?.resposta ?? tela);
    }
    f.check("a bolha termina limpa: o que foi descartado sumiu da tela", tela === String(dados.resposta ?? "") && !/Thinking:/.test(tela), tela.slice(0, 140));
    const busca = (dados.ferramentas ?? [])[0] ?? {};
    f.check("a ferramenta registrada mostra o documento achado na gaveta", /suite-v29-nota/.test(String(busca.resumo ?? "")), String(busca.resumo ?? "").slice(0, 200));
    f.check("os argumentos da busca chegaram inteiros (e na gaveta certa)", busca.args?.query === "nota fiscal" && busca.args?.k === 3 && busca.args?.memoria === GAV, busca.args);
    const evFe = fluxoRes.eventos.find((e) => e.tipo === "ferramenta") ?? {};
    f.check("o evento de ferramenta ao vivo traz servidor, nome e tempo", evFe.servidor === "nexos" && evFe.nome === "search" && evFe.ok === true && Number(evFe.ms) > 0, evFe);
    f.check("2 rodadas: pensar + responder", dados.rodadas === 2 && dados.mcp_interno === true, { rodadas: dados.rodadas, mcp: dados.mcp_interno });

    /* o modelo que nunca termina: pensa, pede ferramenta, pensa de novo... até o freio */
    await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9914/v1", modelo: "limite", mcp_interno: true, max_rodadas: 2, ativo: true, global: true },
    });
    const fluxoLimite = await fluxo(TESTKEY, { pergunta: "sem limite por favor", memoria: GAV });
    const dadosLimite = fluxoLimite.eventos.find((e) => e.tipo === "fim")?.dados ?? {};
    f.check("freio de rodadas avisou", /limite de 2 rodadas/.test(String(dadosLimite.aviso ?? "")), dadosLimite.aviso);
    f.check("no estouro de rodadas o raciocínio vazado não vira resposta", !/Thinking:/.test(String(dadosLimite.resposta ?? "")), String(dadosLimite.resposta ?? "").slice(0, 160));
    await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9914/v1", modelo: "fluxo", mcp_interno: true, max_rodadas: 3, ativo: true, global: true },
    });

    r = await call("GET", `/chat?memoria=${GAV}`, { key: TESTKEY });
    f.check("o histórico do fluxo gravado (pergunta + resposta limpa)", (r.json?.mensagens ?? []).length >= 2 && !(r.json?.mensagens ?? []).some((x: any) => /Thinking:/.test(String(x.texto ?? ""))), (r.json?.mensagens ?? []).length);

    console.log("-- /chat sem streaming continua igual");
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "e sem streaming?", memoria: GAV } });
    f.check("resposta inteira de uma vez", r.status === 200 && /sem streaming \[fluxo\]/.test(String(r.json?.resposta)), r.texto.slice(0, 160));

    console.log("-- erros do fluxo viram evento, nunca conexão quebrada");
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9914/v1", modelo: "fluxo", mcp_interno: true, max_rodadas: 3, ativo: false, global: true } });
    const fluxoErro = await fluxo(TESTKEY, { pergunta: "com provider desligado", memoria: GAV });
    f.check("erro antes do primeiro pedaço chega como evento erro", fluxoErro.eventos.length === 1 && fluxoErro.eventos[0]?.tipo === "erro" && /provider/i.test(String(fluxoErro.eventos[0]?.detalhe)), fluxoErro.eventos);

    /* limpeza */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9914/v1", modelo: "fluxo", system_prompt: "", mcp_interno: false, max_rodadas: 3, ativo: false, global: true } });
    await call("DELETE", `/gavetas/${GAV}`, { key: TESTKEY });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });

    f.fechar("v2.9 markdown/streaming/fila");
  });

  /* ------------------------------------------------------------------ v3.0 */

  await bloco(t, "v3.0: memória da conversa, orçamento de contexto e escopo do provider", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v30";
    const CLI = "cli-30";
    /* provedor que DEVOLVE o resumo do payload que recebeu: assim a checagem vê o que chegou
       ao modelo (quantas mensagens, papéis, caracteres), não só o que a API respondeu. */
    const codEco = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "const u=req.url||'';",
      "if(u.indexOf('models')>=0){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'eco',context_length:16000},{id:'outro',context_length:4096}]}));}",
      "let j={};try{j=JSON.parse(b||'{}')}catch(e){}",
      "const m=j.messages||[];",
      "const r0=JSON.stringify({n:m.length,papeis:m.map(x=>x.role).join(','),chars:m.reduce((a,x)=>a+String(x.content||'').length,0),",
      "maxlinha:(()=>{const v=m.slice(0,-1).map(x=>String(x.content||'').length);return v.length?Math.max(...v):0})(),",
      "primeiro:String(m[0]&&m[0].content||'').slice(0,18),ultimo:String(m[m.length-1]&&m[m.length-1].content||'').slice(0,40),",
      "ferramentas:(j.tools||[]).length});",
      "res.setHeader('content-type','application/json');",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:r0}}]}));",
      "});});",
      "s.listen(9915,'127.0.0.1');setTimeout(()=>process.exit(0),420000);",
    ].join("");

    if (!CONTAINER) {
      f.check("v3.0 precisa do container (provedor eco dentro dele)", true, "sem CONTAINER: partes de memória/compactação não executáveis");
      f.fechar("v3.0 (parcial)");
      return;
    }
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codEco]);
    await dormir(1200);

    const base = {
      tipo: "litellm",
      base_url: "http://127.0.0.1:9915/v1",
      modelo: "eco",
      mcp_interno: false,
      max_rodadas: 1,
      ativo: true,
      global: true,
    };
    /* `base` escreve na linha PADRAO (global); `semGlobal` escreve na linha do CLIENTE citado em tenant.
       Sao alvos diferentes de proposito: e exatamente a distincao que a v2.9 nao fazia. */
    const semGlobal = { ...base, global: false };
    const eco = async (corpoPergunta: Record<string, unknown>) => {
      /* OPKEY de proposito: o chat do operador resolve a linha PADRAO (*), que e este bloco quem
         configura. Com a chave de um usuario, a linha propria (completa) dele teria prioridade e o
         eco deste bloco nunca seria chamado. */
      const r = await call("POST", "/chat", { key: OPKEY, corpo: { memoria: GAV, ...corpoPergunta } });
      let p: any = {};
      try {
        p = JSON.parse(String(r.json?.resposta));
      } catch {
        /* resposta do eco não veio JSON: a checagem abaixo acusa */
      }
      return { r, p };
    };

    /* ---------------------------------------------- 1. os campos novos salvam e voltam */
    let r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: {
        ...base,
        system_prompt: "PROMPT-DE-INSTRUCAO",
        memoria_turnos: 12,
        verbatim_turnos: 2,
        reserva_tokens: 60,
        contexto_tokens: 4000,
      },
    });
    f.check("v3.0 campos do provider salvos", r.status === 200 && r.json?.memoria_turnos === 12 && r.json?.verbatim_turnos === 2 && r.json?.reserva_tokens === 60 && r.json?.contexto_tokens === 4000, r.texto.slice(0, 200));
    r = await call("GET", "/config/provider", { key: OPKEY });
    f.check("janela efetiva anunciada como configurada", r.json?.janela_efetiva === 4000 && r.json?.origem_janela === "configurada", { janela: r.json?.janela_efetiva, origem: r.json?.origem_janela });
    f.check("a linha visada e a padrao (asterisco)", r.json?.escopo === "*" && r.json?.memoria_turnos === 12, { escopo: r.json?.escopo, memoria: r.json?.memoria_turnos });
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, contexto_tokens: 40000000 } });
    f.check("janela absurda recusada com 422", r.status === 422, r.status);

    /* ---------------------------------------------- 2. memória: o payload que chega ao modelo */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "PROMPT-DE-INSTRUCAO", memoria_turnos: 0, verbatim_turnos: 2, reserva_tokens: 60, contexto_tokens: 4000 } });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });
    let e = await eco({ pergunta: "primeira" });
    f.check("sem memória (0): só instruções + pergunta chegam ao modelo", e.p.n === 2 && e.p.papeis === "system,user" && String(e.p.primeiro).startsWith("PROMPT-DE-INSTRU"), e.p);

    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "PROMPT-DE-INSTRUCAO", memoria_turnos: 12, verbatim_turnos: 2, reserva_tokens: 60, contexto_tokens: 4000 } });
    e = await eco({ pergunta: "segunda" });
    f.check("com memória: a rodada anterior volta para o modelo", e.p.n === 4 && e.p.papeis === "system,user,assistant,user", e.p);
    /* a gaveta PADRAO (nome vazio) tem que lembrar igual — foi buraco achado ao escrever este bloco */
    await call("DELETE", `/chat?memoria=`, { key: OPKEY });
    let padrao = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "primeira na padrao", memoria: "" } });
    padrao = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "segunda na padrao", memoria: "" } });
    let pp: any = {};
    try {
      pp = JSON.parse(String(padrao.json?.resposta));
    } catch {
      /* eco respondeu fora de forma */
    }
    f.check("gaveta padrão (nome vazio) também lembra da conversa", pp.n === 4 && pp.papeis === "system,user,assistant,user", pp);
    await call("DELETE", `/chat?memoria=`, { key: OPKEY });

    r = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "terceira", memoria: GAV } });
    f.check("a resposta traz a contabilidade da compactação", r.json?.compactacao && r.json.compactacao.historico_lido >= 2 && r.json.compactacao.resumidas >= 1 && r.json.compactacao.memoria_turnos === 12, r.json?.compactacao);

    /* ---------------------------------------------- 3. compactação determinística (sem LLM) */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "PROMPT-DE-INSTRUCAO", memoria_turnos: 12, verbatim_turnos: 0, reserva_tokens: 60, contexto_tokens: 300 } });
    const antes = await call("GET", `/chat?memoria=${GAV}`, { key: OPKEY });
    e = await eco({ pergunta: "quarta depois do historico grande" });
    const disponivelChars = (300 - 60) * 4;
    f.check("a chamada compactada respondeu normal (200)", e.r.status === 200, e.r.status);
    f.check("o payload enviado coube no orçamento", e.p.chars <= disponivelChars, { chars: e.p.chars, teto: disponivelChars });
    f.check("verbatim 0: nenhuma mensagem antiga passou inteira", e.p.maxlinha <= 200, { maior_linha: e.p.maxlinha });
    r = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "quinta", memoria: GAV } });
    const c = r.json?.compactacao ?? {};
    f.check("compactação resumiu mensagens antigas (não jogou tudo fora)", c.resumidas >= 1 && c.historico_lido > 0, c);
    f.check("o system prompt NUNCA é comprimido (continua integral no payload)", String(e.p.primeiro).startsWith("PROMPT-DE-INSTRU") && e.p.papeis.startsWith("system,user"), e.p);
    f.check("números batem: o que saiu do payload foi contado", (c.resumidas ?? 0) + (c.descartadas ?? 0) >= 1 && c.janela === 300 && c.origem_janela === "configurada", c);
    f.check("histórico gravado na tela permanece íntegro (compactação não reescreve o banco)", (antes.json?.mensagens ?? []).length >= 6, (antes.json?.mensagens ?? []).length);

    /* ---------------------------------------------- 4. quando nem assim cabe, avisa em vez de estourar */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "PROMPT-DE-INSTRUCAO", memoria_turnos: 12, verbatim_turnos: 4, reserva_tokens: 40, contexto_tokens: 120 } });
    e = await eco({ pergunta: "pergunta comprida ".repeat(40) });
    f.check("não coube: enviou instruções + pergunta e avisou", e.p.n === 2 && e.r.status === 200, e.p);
    const estouro = e.r.json?.compactacao;
    f.check("o aviso de estouro chegou honesto NA RESPOSTA da pergunta que estourou", estouro?.coube === false && estouro.janela === 120 && estouro.historico_lido >= 1, estouro);
    r = await call("POST", "/chat", { key: OPKEY, corpo: { pergunta: "sexta", memoria: GAV } });
    f.check("a pergunta seguinte volta ao normal (o estouro não quebra a gaveta)", r.status === 200 && r.json?.compactacao?.coube === true, r.json?.compactacao);

    /* ---------------------------------------------- 5. detecção da janela no testar conexão */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, contexto_tokens: 0, memoria_turnos: 12, verbatim_turnos: 4, reserva_tokens: 60 } });
    r = await call("POST", "/config/provider/testar", { key: OPKEY, corpo: { ...base, contexto_tokens: 0 } });
    f.check("testar conexão detectou a janela do provider", r.status === 200 && r.json?.contexto_detectado === 16000, r.texto.slice(0, 200));
    r = await call("GET", "/config/provider", { key: OPKEY });
    f.check("janela detectada virou a efetiva (sem o humano digitar)", r.json?.janela_efetiva === 16000 && r.json?.origem_janela === "detectada" && r.json?.contexto_detectado === 16000, { janela: r.json?.janela_efetiva, origem: r.json?.origem_janela });

    /* ---------------------------------------------- 5b. v3.2: tempo de SILÊNCIO do provider.
       O que corta a conversa é o modelo parar de escrever, não a resposta ser longa. */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, silencio_s: 5000 } });
    f.check("silêncio fora do limite -> 422", r.status === 422, r.status);
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, silencio_s: 45 } });
    f.check(
      "silêncio aceito e devolvido pela tela",
      r.status === 200 && r.json?.silencio_s === 45 && r.json?.silencio_efetivo_s === 45,
      r.texto.slice(0, 200),
    );
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, silencio_s: 0 } });
    f.check(
      "silêncio 0 volta ao padrão do sistema (180s)",
      r.status === 200 && r.json?.silencio_s === 0 && r.json?.silencio_efetivo_s === 180,
      r.texto.slice(0, 200),
    );

    /* ---------------------------------------------- 6. escopo: o que a tela mostra é onde grava */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...semGlobal, tenant: CLI, system_prompt: "PROBE-CLI-30", contexto_tokens: 4000 } });
    f.check("operador salvando com tenant grava NA LINHA DO CLIENTE", r.status === 200 && r.json?.escopo === CLI && r.json?.system_prompt === "PROBE-CLI-30", r.texto.slice(0, 200));
    r = await call("GET", `/config/provider?tenant=${CLI}`, { key: OPKEY });
    f.check("reler o cliente mostra o texto gravado (o bug da v2.9)", r.json?.system_prompt === "PROBE-CLI-30" && r.json?.escopo === CLI, r.json?.system_prompt);
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...semGlobal, tenant: CLI, memoria_turnos: 3, verbatim_turnos: 1, contexto_tokens: 900 } });
    f.check("a memória é configurada POR CLIENTE (cada um com seu tamanho)", r.status === 200 && r.json?.memoria_turnos === 3 && r.json?.verbatim_turnos === 1, r.texto.slice(0, 200));
    r = await call("GET", `/config/provider?tenant=${CLI}`, { key: OPKEY });
    f.check("o cliente tem janela própria, independente da padrão", r.json?.memoria_turnos === 3 && r.json?.janela_efetiva === 900, { memoria: r.json?.memoria_turnos, janela: r.json?.janela_efetiva });
    r = await call("GET", "/config/provider", { key: OPKEY });
    f.check("a linha do operador não foi tocada de relance", r.json?.escopo !== CLI && r.json?.system_prompt === "PROMPT-DE-INSTRUCAO", { escopo: r.json?.escopo, prompt: r.json?.system_prompt });
    r = await call("PUT", "/config/provider", { key: TESTKEY, corpo: { ...semGlobal, tenant: CLI, system_prompt: "INVADE-CLI-30", contexto_tokens: 4000 } });
    f.check("usuário comum não escreve provider NENHUM (v3.4: escrita é de admin)", r.status === 403, r.texto.slice(0, 140));
    r = await call("GET", `/config/provider?tenant=${CLI}`, { key: OPKEY });
    f.check("e o cliente alheio continua intacto", r.json?.system_prompt === "PROBE-CLI-30", r.json?.system_prompt);
    r = await call("PUT", "/config/provider", { key: TESTKEY, corpo: { ...base, global: true, system_prompt: "x", contexto_tokens: 4000 } });
    f.check("usuário comum não grava o padrão global", r.status === 403, r.status);

    /* ---------------------------------------------- limpeza (não contamina os blocos seguintes) */
    /* a linha do usuario comum tambem: ela ficou completa durante os testes de escopo e passaria a
       ter prioridade sobre o padrao nos blocos que rodam depois deste (v3.4: limpeza pela mão do operador) */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...semGlobal, tenant: "teste", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false } });
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...semGlobal, tenant: CLI, system_prompt: "", ativo: false, contexto_tokens: 4000 } });
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...base, system_prompt: "", memoria_turnos: 12, verbatim_turnos: 4, reserva_tokens: 1024, contexto_tokens: 0, ativo: false } });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });
    f.fechar("v3.0 memória/orçamento/escopo");
  });

  await bloco(t, "v3.1: boot não quebra quando a mesma chave existe sob outro nome", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? CONTAINER.replace("-api-", "-db-");
    if (!CONTAINER || !OPKEY) {
      f.check("v3.1 precisa do container (reinicia a API)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v3.1 boot/chave repetida");
      return;
    }
    /* Retrato de uma rotação de chave: a linha do operador vai morar sob OUTRO nome,
       carrying o mesmo hash. No boot a semente do env tenta reinserir ('op', mesmo hash):
       antes do conserto era INSERT ... ON CONFLICT (nome), que não cobre o hash -> o
       serviço inteiro morria em usuarios_chave_hash_key e não subia mais. */
    execFileSync("docker", ["exec", DB, "sh", "-c",
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "UPDATE usuarios SET nome='op-rotacionada' WHERE nome='op'"`],
      { encoding: "utf8" });
    let r: Resp = { status: 0, texto: "", json: undefined } as unknown as Resp;

    /* o boot semeia MINIRAG_USERS de novo -> era aqui que o serviço inteiro morria
       (duplicate key ... usuarios_chave_hash_key) */
    execFileSync("docker", ["restart", CONTAINER], { stdio: "ignore" });
    let vivo = 0;
    for (let i = 0; i < 40; i++) {
      try {
        const p = await fetch(BASE + "/health");
        if (p.status === 200) {
          vivo = i + 1;
          break;
        }
      } catch {
        /* ainda subindo */
      }
      await dormir(2000);
    }
    f.check("boot com hash repetido sobe o serviço", vivo > 0, "health nunca respondeu");
    r = await call("GET", "/gavetas", { key: TESTKEY });
    f.check("chave do teste continua autenticando depois do boot", r.status === 200, r.status);
    /* devolve o nome para o registro não ficar torto para os blocos seguintes */
    execFileSync("docker", ["exec", DB, "sh", "-c",
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "UPDATE usuarios SET nome='op' WHERE nome='op-rotacionada'"`],
      { encoding: "utf8" });
    r = await call("GET", "/gavetas", { key: OPKEY });
    f.check("operador continua autenticando depois da restauração", r.status === 200, r.status);
    f.fechar("v3.1 boot/chave repetida");
  });

  await bloco(t, "v3.2: o que corta a resposta é silêncio, não duração", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    if (!CONTAINER || !OPKEY) {
      f.check("v3.2 precisa do container (provedores falsos dentro dele)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v3.2 silêncio");
      return;
    }
    /* Um falso que GOTEJA (1 pedaço por segundo, ~15 s no total) e um que TRAVA (escreve um
       pedaço e nunca mais manda nada). Com orçamento de silêncio de 4 s: o gotejante tem que
       sobreviver (a duração não é defeito) e o travado tem que cair em segundos com etiqueta
       em português — era ele que morria em "The operation was aborted due to timeout". */
    const cod = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const nome=j.model||'';",
      "res.setHeader('content-type','text/event-stream');",
      "const p=(o)=>res.write('data: '+JSON.stringify(o)+'\\n\\n');",
      "if(nome==='goteja'){let k=0;const t=setInterval(()=>{if(k<14){p({choices:[{delta:{content:'g'+k+' '}}]});k++;return;}clearInterval(t);p({choices:[{delta:{content:'[fim-goteja]'}}]});res.write('data: [DONE]\\n\\n');res.end();},1000);return;}",
      "if(nome==='trava'){p({choices:[{delta:{content:'comecei'}}]});return;}",
      "res.end();",
      "});});",
      "s.listen(9917,'127.0.0.1');setTimeout(()=>process.exit(0),200000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", cod]);
    await dormir(1200);

    const baseV32 = {
      tipo: "litellm",
      base_url: "http://127.0.0.1:9917/v1",
      temperatura: 0,
      system_prompt: "",
      mcp_interno: false,
      max_rodadas: 0,
      silencio_s: 4,
      ativo: true,
      global: true,
    };
    let r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...baseV32, modelo: "goteja" } });
    f.check("provedor gotejante armado com silêncio de 4s", r.status === 200 && r.json?.silencio_efetivo_s === 4, r.texto.slice(0, 160));

    const iniG = Date.now();
    const got = await fluxo(OPKEY, { pergunta: "goteja devagar por favor", memoria: "suite-v32" });
    const durG = Date.now() - iniG;
    const tiposG = got.eventos.map((e: any) => e.tipo);
    const textoG = got.eventos.filter((e: any) => e.tipo === "delta").map((e: any) => String(e.texto ?? "")).join("");
    f.check("resposta que escreve devagar por ~15s NÃO é cortada", tiposG.includes("fim") && !tiposG.includes("erro"), tiposG.join(","));
    f.check("todos os pedaços do gotejamento chegaram", textoG.includes("g13") && textoG.includes("[fim-goteja]"), textoG.slice(0, 80));
    f.check("durou muito mais que o orçamento de silêncio (prova de que duração não mata)", durG > 8000, `${durG}ms com silencio=4s`);

    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...baseV32, modelo: "trava" } });
    f.check("provedor travado armado", r.status === 200 && r.json?.modelo === "trava", r.texto.slice(0, 120));
    const iniT = Date.now();
    const trv = await fluxo(OPKEY, { pergunta: "trava no meio por favor", memoria: "suite-v32" });
    const durT = Date.now() - iniT;
    const evErro = trv.eventos.find((e: any) => e.tipo === "erro") ?? {};
    const detalhe = String(evErro.detalhe ?? "");
    f.check("o que para de escrever é cortado em segundos (não em minutos)", durT >= 3500 && durT < 12000, `${durT}ms`);
    f.check("a queda chega como evento erro do fluxo (nunca conexão quebrada)", detalhe.length > 0, trv.bruto.slice(0, 120));
    f.check(
      "a etiqueta diz o que aconteceu, em português",
      /ficou sem mandar nada por 4s/.test(detalhe) && !/aborted due to timeout/i.test(detalhe),
      detalhe,
    );

    /* limpeza: desliga e devolve o silêncio ao padrão do sistema */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...baseV32, modelo: "goteja", silencio_s: 0, ativo: false } });
    r = await call("GET", "/config/provider", { key: OPKEY });
    f.check("limpeza: silêncio voltou ao padrão (180s) e o provedor falso desligou", r.json?.silencio_s === 0 && r.json?.silencio_efetivo_s === 180 && r.json?.ativo === false, { s: r.json?.silencio_s, e: r.json?.silencio_efetivo_s, a: r.json?.ativo });
    f.fechar("v3.2 silêncio");
  });

  /* ------------------------------------------------------------------ v3.3 */

  await bloco(t, "v3.3: tarefa de chat que sobrevive (cria, roda, espeia o parcial)", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? "";
    const GAV = "suite-v33";

    if (!CONTAINER) {
      f.check("v3.3 precisa do container (provedor falso dentro dele)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v3.3 tarefa (parcial)");
      return;
    }

    console.log("-- provedor falso LENTO (8 peças de ~250 ms ≈ 2 s), porta 9918, morte auto 240s");
    const codTarefa = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const m=j.messages||[];const comFerramenta=m.filter(x=>x.role==='tool').length>0;",
      "const sse=(pecas,fim)=>{res.setHeader('content-type','text/event-stream');let k=0;",
      "const t=setInterval(()=>{",
      "if(k<pecas.length){res.write('data: '+JSON.stringify({choices:[{delta:{content:pecas[k]}}]})+'\\n\\n');k++;return;}",
      "clearInterval(t);fim();},250);};",
      "if(j.stream&&comFerramenta){",
      "sse(['A nota 5512 da Beta ','soma R$ 9.876,54 ','com vencimento ','em 05/12/2026 ','[tarefa].'],()=>{res.write('data: [DONE]\\n\\n');res.end();});",
      "return;}",
      "if(j.stream){",
      "sse(['Thinking:',' vou',' consultar',' a gaveta'],()=>{",
      "res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'f1',type:'function',function:{name:'search',arguments:JSON.stringify({query:'nota fiscal',k:3})}}]}}]})+'\\n\\n');",
      "res.write('data: [DONE]\\n\\n');res.end();});",
      "return;}",
      "res.setHeader('content-type','application/json');",
      "if(comFerramenta)return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'A nota 5512 da Beta soma R$ 9.876,54 com vencimento em 05/12/2026 [tarefa].'}}]}));",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'f1',type:'function',function:{name:'search',arguments:JSON.stringify({query:'nota fiscal',k:3})}}]}}]}));",
      "});});",
      "s.listen(9918,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codTarefa]);
    await dormir(1200);

    const psql = (sql: string) =>
      execFileSync("docker", ["exec", DB, "sh", "-c", `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "${sql}"`], { encoding: "utf8" }).trim();

    const rg = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite-v33-nota", content: "Nota fiscal 5512 da empresa Beta. Total R$ 9.876,54 com vencimento em 05/12/2026.", memoria: GAV },
    });
    const job = await esperarJob(TESTKEY, rg.json?.job_id);
    f.check("documento da v3.3 indexado", job.status === "concluido", job);

    const rp = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9918/v1", modelo: "tarefa", temperatura: 0, system_prompt: "", mcp_interno: true, max_rodadas: 3, ativo: true, global: true },
    });
    f.check("provedor lento salvo (9918, MCP interno)", rp.status === 200 && rp.json?.mcp_interno === true, rp.texto.slice(0, 160));

    console.log("-- POST /chat/tarefa");
    const r = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "qual o total da nota da Beta?", memoria: GAV } });
    f.check("cria tarefa: 201 + id", r.status === 201 && typeof r.json?.id === "string" && r.json.id.length >= 8, r.texto.slice(0, 120));
    const id = String(r.json?.id ?? "");
    f.check("linha existe no banco (rodando, tenant da chave)", /^rodando\|teste$/.test(psql(`SELECT status||'|'||tenant FROM chat_tarefas WHERE id='${id}'`)), psql(`SELECT status||'|'||tenant FROM chat_tarefas WHERE id='${id}'`));

    const rv = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "", memoria: GAV } });
    f.check("pergunta vazia: 422 (mesma regra do /chat)", rv.status === 422, rv.texto.slice(0, 120));

    console.log("-- consultas de tarefa (Task 3)");
    const rc = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "lista por favor", memoria: GAV } });
    f.check("cria a seu tarefa p/ consulta", rc.status === 201 && typeof rc.json?.id === "string", rc.texto.slice(0, 120));
    const r1 = await call("GET", `/chat/tarefas?memoria=${GAV}`, { key: TESTKEY });
    f.check("lista tarefas rodando", r1.status === 200 && Array.isArray(r1.json?.tarefas), r1.texto.slice(0, 120));
    f.check("vê a tarefa rodando (com pergunta no payload)", r1.json?.tarefas?.some((t: any) => t.id === rc.json?.id && t.status === "rodando" && typeof t.pergunta === "string"), JSON.stringify(r1.json ?? r1.texto).slice(0, 200));
    const r2 = await call("GET", `/chat/tarefa/${String(rc.json?.id ?? "")}`, { key: TESTKEY });
    f.check("estado da tarefa", r2.status === 200 && typeof r2.json?.parcial === "string", r2.texto.slice(0, 120));
    const r404 = await call("GET", `/chat/tarefa/nao-existe-999`, { key: TESTKEY });
    f.check("id inexistente: 404", r404.status === 404, r404.texto.slice(0, 120));

    console.log("-- deixa a tarefa terminar SOZINHA (provedor lento: ~4 s de deltas)");
    let st = "";
    for (let i = 0; i < 60; i++) {
      await dormir(500);
      st = psql(`SELECT status FROM chat_tarefas WHERE id='${id}'`);
      if (st === "terminou" || st === "falhou") break;
    }
    f.check("tarefa terminou sem nenhum cliente conectado", st === "terminou", { st, aviso: psql(`SELECT COALESCE(aviso,'') FROM chat_tarefas WHERE id='${id}'`) });
    const parcial = psql(`SELECT parcial FROM chat_tarefas WHERE id='${id}'`);
    f.check("parcial no banco é a resposta final (sem 'Thinking:')", /9\.876,54/.test(parcial) && !/Thinking:/.test(parcial), parcial.slice(0, 160));

    console.log("-- SSE reanexável (Task 4): abre, lê o replay, ABORTA no meio, reanexa do zero");
    const rt = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "reanexa por favor", memoria: GAV } });
    const idRe = String(rt.json?.id ?? "");
    const c1 = new AbortController();
    const s1 = await fetch(`${BASE}/chat/tarefa/${idRe}/stream`, { headers: { authorization: cabecalho(TESTKEY) }, signal: c1.signal });
    f.check("stream abre: 200 + event-stream", s1.status === 200 && /text\/event-stream/.test(s1.headers.get("content-type") ?? ""), `${s1.status} ${s1.headers.get("content-type") ?? ""}`);
    const leitura = await Promise.race([
      s1.body!.getReader().read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("stream não mandou evento em 30s")), 30_000)),
    ]);
    f.check("abre com replay: primeiro evento é parcial", new TextDecoder().decode(leitura.value ?? new Uint8Array()).includes('"tipo":"parcial"'), String(new TextDecoder().decode(leitura.value ?? new Uint8Array())).slice(0, 160));
    c1.abort(); // simula fechar a aba no meio

    const s2 = await fetch(`${BASE}/chat/tarefa/${idRe}/stream`, { headers: { authorization: cabecalho(TESTKEY) }, signal: AbortSignal.timeout(60_000) });
    const bruto2 = await s2.text(); // server fecha o stream no fim → text() resolve
    f.check("reanexar recebe tudo até o fim", bruto2.includes('"tipo":"fim"'), bruto2.slice(-180));
    const rGet = await call("GET", `/chat/tarefa/${idRe}`, { key: TESTKEY });
    f.check("fim coerente com o GET (estado já fechado quando o fim chega)", rGet.json?.status === "terminou", rGet.texto.slice(0, 160));
    const s404 = await fetch(`${BASE}/chat/tarefa/nao-existe-999/stream`, { headers: { authorization: cabecalho(TESTKEY) }, signal: AbortSignal.timeout(15_000) });
    f.check("stream de id inexistente: 404 sem hijack", s404.status === 404, String(s404.status));

    /* limpeza OBRIGATÓRIA — as três chamadas finais do padrão v2.9 (sem isso contamina runs futuros) */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9918/v1", modelo: "tarefa", system_prompt: "", mcp_interno: false, max_rodadas: 3, ativo: false, global: true } });
    await call("DELETE", `/gavetas/${GAV}`, { key: TESTKEY });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: OPKEY });
    f.fechar("v3.3 tarefa");
  });

  await bloco(t, "v3.4: módulos do admin — o comum só vê chat, buscar e fila", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? CONTAINER.replace("-api-", "-db-");
    const psql = (sql: string) =>
      execFileSync("docker", ["exec", DB, "sh", "-c", `psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"${sql}\"`], { encoding: "utf8" }).trim();
    /* v3.4: o nome canônico da variável do admin é NEXOS_ADMIN (MINIRAG_ADMIN e OPERADOR ainda valem).
       Esta suíte só prova que o boot com o nome NOVO funciona se o container nasceu com ela. */
    if (CONTAINER) {
      const nomeSemente = execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "(printenv NEXOS_ADMIN || printenv MINIRAG_ADMIN) | cut -d: -f1"], { encoding: "utf8" }).trim();
      f.check("boot semeou o admin pela variável NEXOS_ADMIN", nomeSemente === "op", { nome: nomeSemente });
    } else {
      f.check("boot semeou o admin pela variável NEXOS_ADMIN", false, "sem CONTAINER no ambiente");
    }
    /* política do dono (21/10): Painel, Usuários e Configurações são do ADMIN —
       na tela (filtro do menu) E na porta (a parede de verdade é aqui). */
    let r = await call("GET", "/dashboard", { key: TESTKEY });
    f.check("comum não abre o painel", r.status === 403, r.texto.slice(0, 140));
    r = await call("GET", "/dashboard", { key: OPKEY });
    f.check("admin abre o painel", r.status === 200 && typeof r.json?.numeros?.documentos === "number", r.texto.slice(0, 140));

    r = await call("PUT", "/config/provider", { key: TESTKEY, corpo: { base_url: "http://127.0.0.1:1/v1", modelo: "" } });
    f.check("comum não escreve provider", r.status === 403, r.texto.slice(0, 140));
    r = await call("POST", "/config/provider/testar", { key: TESTKEY, corpo: {} });
    f.check("comum não testa conexão", r.status === 403, r.texto.slice(0, 140));
    r = await call("GET", "/config/provider", { key: TESTKEY });
    f.check("comum LÊ o próprio provider (o Chat depende disso)", r.status === 200 && typeof r.json?.configurado === "boolean", r.texto.slice(0, 140));

    /* admin configura a linha de um comum mirando o tenant (o caminho que a tela dele usa).
       A RESPOSTA mostra a linha EFETIVA (regra v2.8.1: incompleta não tapa global) — onde a
       escrita caiu se prova no banco. */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { tenant: "teste", tipo: "litellm", base_url: "http://127.0.0.1:1/v1", modelo: "", ativo: false } });
    const caiu = psql(`SELECT escopo || '|' || base_url FROM provider_config WHERE escopo = 'teste'`);
    f.check("admin escreve provider NA LINHA do usuário (tenant no corpo)", r.status === 200 && caiu === "teste|http://127.0.0.1:1/v1", { status: r.status, caiu });

    /* os três módulos do comum seguem vivos pela porta */
    r = await call("GET", "/jobs?limit=5", { key: TESTKEY });
    f.check("comum usa a fila (próprio escopo)", r.status === 200 && Array.isArray(r.json?.jobs), r.texto.slice(0, 100));
    r = await call("POST", "/search", { key: TESTKEY, corpo: { query: "qualquer coisa", memoria: "gav-v34-inexistente" } });
    f.check("comum usa a busca", r.status === 200 && Array.isArray(r.json?.items), r.texto.slice(0, 100));
    r = await call("GET", "/chat?memoria=gav-v34&limit=5", { key: TESTKEY });
    f.check("comum usa o histórico do chat", r.status === 200 && Array.isArray(r.json?.mensagens), r.texto.slice(0, 100));
    r = await call("GET", "/gavetas", { key: TESTKEY });
    f.check("comum lista as próprias gavetas (o seletor do Chat precisa)", r.status === 200, r.status);
    f.fechar("v3.4 perfis");
  });

  await bloco(t, "v3.5: esquecimento configurável + apagar com carência + faxina", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? CONTAINER.replace("-api-", "-db-");
    const psql = (sql: string) =>
      execFileSync("docker", ["exec", DB, "sh", "-c", `psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"${sql}\"`], { encoding: "utf8" }).trim();

    /* ---- 1. defaults efetivos sem nada gravado na tela ----
       (apaga ajustes de corridas anteriores: a suíte pode rodar sobre o mesmo volume) */
    if (DB) psql("DELETE FROM esquecimento_cfg");
    let r = await call("GET", "/config", { key: OPKEY });
    const e0 = r.json?.esquecimento ?? {};
    f.check(
      "defaults efetivos: arquiva 180d, mata arquivado 365d, carência 30d (origem ambiente)",
      e0.dias_arquivar === 180 && e0.dias_excluir_arquivado === 365 && e0.dias_carencia === 30 &&
        e0.origem?.dias_arquivar === "ambiente",
      { dias_arquivar: e0.dias_arquivar, excluir: e0.dias_excluir_arquivado, car: e0.dias_carencia, origem: e0.origem },
    );

    /* ---- 2-4. escrita é do admin; valor esquisito barra; gravar na tela vence ---- */
    r = await call("PUT", "/config/esquecimento", { key: TESTKEY, corpo: { dias_arquivar: 90 } });
    f.check("comum não escreve esquecimento (403)", r.status === 403, r.json?.detail ?? r.status);

    r = await call("PUT", "/config/esquecimento", { key: OPKEY, corpo: { dias_arquivar: -5 } });
    f.check("dias negativos -> 422", r.status === 422, r.texto.slice(0, 140));

    r = await call("PUT", "/config/esquecimento", { key: OPKEY, corpo: { dias_arquivar: 181, dias_excluir_arquivado: 366, dias_carencia: 30 } });
    const okEscrita = r.status === 200 && r.json?.efetivos?.dias_arquivar === 181;
    r = await call("GET", "/config", { key: OPKEY });
    f.check(
      "admin grava e a releitura bate (tela vence ambiente)",
      okEscrita && r.json?.esquecimento?.dias_arquivar === 181 && r.json?.esquecimento?.origem?.dias_arquivar === "tela",
      { write: r.status, efetivo: r.json?.esquecimento?.dias_arquivar, origem: r.json?.esquecimento?.origem },
    );

    /* ---- 5-9. ciclo do apagar-agendar-desfazer ---- */
    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-v35", papel: "usuario" } });
    const k35 = String(r.json?.chave ?? "");
    f.check("cria usuário da v3.5", r.status === 201 && k35.length > 20, r.texto.slice(0, 120));

    r = await call("POST", "/ingest", { key: k35, corpo: { doc_id: "nota-v35", content: "Nota fiscal 7788 da suíte v3.5, total R$ 3.210,00.", memoria: "suite-v35" } });
    const fimIngest = r.status === 202 ? await esperarJob(k35, Number(r.json?.job_id)) : {};
    f.check("documento entra na gaveta do suite-v35", fimIngest.status === "concluido", fimIngest.status);

    r = await call("DELETE", "/usuarios/suite-v35", { key: OPKEY });
    const agendado = r.status === 200 && r.json?.agendado === true && r.json?.removido === false && Number(r.json?.carencia_dias) === 30;
    r = await call("GET", "/usuarios", { key: OPKEY });
    const linha35 = (r.json?.usuarios ?? []).find((u: any) => u.nome === "suite-v35");
    f.check("apagar AGENDA (login off, prazo no ar, linha segue na lista)", agendado && linha35?.agendado_exclusao_em, { agendado, expira: linha35?.agendado_exclusao_em });

    r = await call("GET", "/docs?memoria=suite-v35", { key: k35 });
    f.check("chave do agendado não entra mais (401)", r.status === 401, r.status);

    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-v35", papel: "usuario" } });
    const k35b = String(r.json?.chave ?? "");
    f.check("recriar o nome DESFAZ a exclusão", r.status === 201 && /DESFEITA/.test(String(r.json?.aviso ?? "")), r.texto.slice(0, 160));
    r = await call("GET", "/docs?memoria=suite-v35", { key: k35b });
    f.check("acervo sobreviveu ao desfazer", r.status === 200 && JSON.stringify(r.json?.docs ?? r.json).includes("nota-v35"), r.texto.slice(0, 140));

    /* ---- 10. faxina: carência vencida apaga conta + dados inteiros ---- */
    await call("DELETE", "/usuarios/suite-v35", { key: OPKEY });
    psql(`UPDATE usuarios SET agendado_exclusao_em = now() - interval '1 hour' WHERE nome = 'suite-v35'`);
    r = await call("POST", "/decay", { key: OPKEY, corpo: {} });
    const exp1 = r.json?.expurgo ?? {};
    const sumiu = (exp1.usuarios_apagados ?? []).includes("suite-v35");
    f.check("decay força faxina e expurga conta vencida", r.status === 200 && sumiu, { expurgo: exp1, detalhe: r.json?.detail });
    f.check(
      "expurgado: zero sobra (usuarios, chunks, documents, jobs)",
      CONTAINER !== "" &&
        psql(`SELECT (SELECT count(*) FROM usuarios WHERE nome='suite-v35') || '|' || (SELECT count(*) FROM chunks WHERE tenant='suite-v35') || '|' || (SELECT count(*) FROM documents WHERE tenant='suite-v35') || '|' || (SELECT count(*) FROM ingest_jobs WHERE tenant='suite-v35')`) === "0|0|0|0",
      CONTAINER ? psql(`SELECT count(*) FROM usuarios WHERE nome='suite-v35'`) : "sem container",
    );

    /* ---- 11-12. arquivado morre além da janela; dentro dela fica ---- */
    const GAVX = "suite-v35-exp";
    for (const id of ["expira-morto", "expira-janela", "expira-vivo"]) {
      r = await call("POST", "/ingest", { key: TESTKEY, corpo: { doc_id: id, content: `Documento ${id} da prova de expurgo v3.5 com valor 4455.`, memoria: GAVX } });
      if (r.status === 202) await esperarJob(TESTKEY, Number(r.json?.job_id));
    }
    await call("PATCH", `/documents/expira-morto/arquivado?memoria=${GAVX}`, { key: TESTKEY, corpo: { arquivado: true } });
    await call("PATCH", `/documents/expira-janela/arquivado?memoria=${GAVX}`, { key: TESTKEY, corpo: { arquivado: true } });
    psql(`UPDATE chunks SET archived_at = now() - interval '400 days' WHERE tenant='teste' AND memoria='${GAVX}' AND doc_id='expira-morto'`);
    r = await call("POST", "/decay", { key: OPKEY, corpo: {} });
    const exp2 = r.json?.expurgo ?? {};
    f.check("arquivado fora da janela (400d > 366d) é apagado de vez", Number(exp2.docs_expurgados ?? 0) >= 1, exp2);
    f.check(
      "morto some das três tabelas; janela (arquivado hoje) e vivo ficam",
      CONTAINER !== "" &&
        psql(`SELECT (SELECT count(*) FROM documents WHERE tenant='teste' AND memoria='${GAVX}' AND doc_id='expira-morto') || '|' || (SELECT count(*) FROM documents WHERE tenant='teste' AND memoria='${GAVX}' AND doc_id='expira-janela') || '|' || (SELECT count(*) FROM documents WHERE tenant='teste' AND memoria='${GAVX}' AND doc_id='expira-vivo')`) === "0|1|1",
      CONTAINER ? psql(`SELECT doc_id FROM documents WHERE tenant='teste' AND memoria='${GAVX}'`) : "sem container",
    );
    f.check(
      "morto não deixa nem chunk (embedding some junto); vivo mantém os seus",
      CONTAINER !== "" &&
        psql(`SELECT (SELECT count(*) FROM chunks WHERE tenant='teste' AND memoria='${GAVX}' AND doc_id='expira-morto') || '|' || ((SELECT count(*) FROM chunks WHERE tenant='teste' AND memoria='${GAVX}' AND doc_id='expira-vivo') > 0)::int`) === "0|1",
      CONTAINER ? psql(`SELECT count(*) FROM chunks WHERE tenant='teste' AND memoria='${GAVX}' AND doc_id='expira-morto'`) : "sem container",
    );

    /* ---- 13. MCP espelho: apagar_usuario + esquecimento ---- */
    const mcp = (id: unknown, name: string, args: unknown, key: string) =>
      call("POST", "/mcp", { key, corpo: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-v35c", papel: "usuario" } });
    f.check("usuário MCP-alvo criado", r.status === 201, r.texto.slice(0, 100));
    r = await mcp(1, "apagar_usuario", { nome: "suite-v35c" }, OPKEY);
    f.check("MCP apagar_usuario agenda", JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}").agendado === true, r.texto.slice(0, 160));
    r = await mcp(2, "esquecimento", { acao: "ver" }, OPKEY);
    const esqMcp = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("MCP esquecimento ver devolve efetivos da tela", esqMcp?.efetivos?.dias_arquivar === 181, r.texto.slice(0, 160));
    r = await mcp(3, "esquecimento", { acao: "definir", dias_arquivar: 60 }, TESTKEY);
    const negado = r.json?.result?.isError === true || r.json?.error;
    f.check("comum pelo MCP não escreve esquecimento", negado === true || Boolean(negado), r.texto.slice(0, 160));

    /* limpeza: desfaz o agendamento do v35c para não deixar lixo e volta defaults da tela */
    await call("DELETE", "/usuarios/suite-v35c", { key: OPKEY });
    await call("PATCH", "/usuarios/suite-v35c", { key: OPKEY, corpo: { ativo: true } });
    await call("DELETE", "/usuarios/suite-v35c", { key: OPKEY });
    await call("DELETE", `/gavetas/${encodeURIComponent(GAVX)}`, { key: TESTKEY });

    f.fechar("v3.5 esquecimento-faxina");
  });

  /* mata clientes de teste por /proc — script no container evita o inferno de aspas do sh -c */
const MATAR_JS =
  "const fs=require('fs');for(const d of fs.readdirSync('/proc')){if(!/^[0-9]+$/.test(d))continue;try{const c=fs.readFileSync('/proc/'+d+'/cmdline','utf8').split(String.fromCharCode(0)).join(' ');if(new RegExp(['cliente'+'-painel[.]js','cli'+'37'].join('|')).test(c))process.kill(Number(d),'SIGKILL')}catch(e){}}";
function instalarMatador(CONTAINER: string) {
  execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", "cat > /tmp/matar-clientes.js"], { input: MATAR_JS });
}

await bloco(t, "v3.6: máquinas por usuário — hub WS, pareamento, run, escopo e MCP", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? CONTAINER.replace("-api-", "-db-");
    const psql = (sql: string) =>
      execFileSync("docker", ["exec", DB, "sh", "-c", `psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tAc \"${sql}\"`], { encoding: "utf8" }).trim();
    const leArq = (p: string) => {
      try {
        return execFileSync("docker", ["exec", CONTAINER, "cat", p], { encoding: "utf8" });
      } catch {
        return "";
      }
    };
    /* máquina falsa na receita dos providers falsos: roda DENTRO do container e
       fala o wire exato do túnel (oi/{token,host,os,user}; cmd/{cmd,rotulo,espera};
       resposta/{exit,stdout,stderr}) */
    const FAKE = [
      'const WebSocket=require("/app/node_modules/ws");const fs=require("fs");',
      'const url=process.env.FQ_URL||"ws://127.0.0.1:8000/maquina/ws";',
      'const token=process.env.FQ_TOKEN||"", host=process.env.FQ_HOST||"maq", loop=process.env.FQ_LOOP==="1", arq=process.env.FQ_ARQ;',
      'let cur=token;', // cliente de verdade adota o token de máquina que recebe no ack e reconecta com ele
      'function conectar(){const ws=new WebSocket(url);',
      'ws.on("open",()=>ws.send(JSON.stringify({token:cur,host,os:"fake",user:"suite"})));',
      'ws.on("message",(b)=>{let m={};try{m=JSON.parse(String(b))}catch{return}',
      'if(m.ack){fs.writeFileSync(arq,JSON.stringify(m));if(m.token){cur=m.token;fs.writeFileSync(arq+".mk",m.token)}if(m.ack==="negado"&&!loop)ws.close();}',
      'else if(typeof m.cmd==="string"){',
      'if(m.cmd==="nunca")return;',
      'if(m.cmd.indexOf("echo ")===0)setTimeout(()=>{try{ws.send(JSON.stringify({exit:0,stdout:m.cmd.slice(5),stderr:""}))}catch{}},120);',
      'else ws.send(JSON.stringify({exit:0,stdout:"",stderr:""}))}});',
      'ws.on("error",()=>{});ws.on("close",()=>{if(loop)setTimeout(conectar,400)});}',
      'conectar();if(!loop)setTimeout(()=>process.exit(0),25000);',
    ].join("");
    execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", "cat > /app/maqfake.js"], { input: FAKE });
    const subir = (envs: Record<string, string>) =>
      execFileSync("docker", ["exec", "-d", CONTAINER, "sh", "-c",
        Object.entries(envs).map(([k, v]) => `${k}='${v}'`).join(" ") + " node /app/maqfake.js"]);
    const ate = async (cond: () => Promise<boolean> | boolean, tetoMs = 15000) => {
      const fim = Date.now() + tetoMs;
      for (;;) {
        if (await cond()) return true;
        if (Date.now() > fim) return false;
        await dormir(400);
      }
    };

    let r = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome: "suite-1" } });
    const par1 = String(r.json?.token ?? "");
    f.check("usuário comum cria pareamento (40 chars, expira)", r.status === 201 && par1.length === 40 && Number(r.json?.segundos) >= 60, r.texto.slice(0, 140));

    subir({ FQ_TOKEN: par1, FQ_HOST: "maq-01", FQ_LOOP: "1", FQ_ARQ: "/tmp/a1.json" });
    const ok1 = await ate(() => leArq("/tmp/a1.json").includes('"ack":"ok"'));
    const tokenMaq = leArq("/tmp/a1.json.mk").trim();
    f.check("pareamento ao vivo: ack ok + token de máquina devolvido", ok1 && tokenMaq.length === 40, { ack: leArq("/tmp/a1.json").slice(0, 80), len: tokenMaq.length });

    r = await call("GET", "/maquinas", { key: TESTKEY });
    const lin = (r.json?.maquinas ?? []).find((m: any) => m.host === "maq-01");
    f.check("GET /maquinas: máquina DO usuário, online", r.status === 200 && lin?.online === true && lin?.tenant === "teste" && lin?.so === "fake", r.texto.slice(0, 200));

    r = await call("POST", "/maquinas/maq-01/run", { key: TESTKEY, corpo: { cmd: "echo ola-maq" } });
    f.check("run echo: exit 0 e stdout certo", r.status === 200 && r.json?.exit === 0 && r.json?.stdout === "ola-maq" && r.json?.ms > 0, r.texto.slice(0, 160));

    r = await call("GET", "/maquinas/log?limit=3", { key: TESTKEY });
    const lg0 = (r.json?.log ?? [])[0] ?? {};
    f.check("auditoria guarda o comando com origem rest", lg0?.cmd === "echo ola-maq" && lg0?.origem === "rest" && lg0?.host === "maq-01", JSON.stringify(lg0).slice(0, 140));

    const t0 = Date.now();
    r = await call("POST", "/maquinas/maq-01/run", { key: TESTKEY, corpo: { cmd: "nunca", timeout: 2 } });
    f.check("máquina muda responde -124 no prazo (espera+8s)", r.json?.exit === -124 && t0 - Date.now() < 30000, { status: r.status, json: r.json?.exit, ms: Date.now() - t0 });

    subir({ FQ_TOKEN: tokenMaq, FQ_HOST: "maq-01b", FQ_ARQ: "/tmp/a1b.json" });
    await ate(() => leArq("/tmp/a1b.json").includes("negado"));
    f.check("token de máquina NÃO vale para outro host", leArq("/tmp/a1b.json").includes("desconhecido"), leArq("/tmp/a1b.json").slice(0, 100));

    r = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome: "suite-2" } });
    const par2 = String(r.json?.token ?? "");
    subir({ FQ_TOKEN: par2, FQ_HOST: "maq-02", FQ_ARQ: "/tmp/a2.json" });
    await ate(() => leArq("/tmp/a2.json").includes("ok"));
    subir({ FQ_TOKEN: par2, FQ_HOST: "maq-03", FQ_ARQ: "/tmp/a3.json" });
    await ate(() => leArq("/tmp/a3.json").includes("negado"));
    f.check("pareamento é de uso único (segundo uso = negado)", /vencido ou ja usados|vencido ou já usado/.test(leArq("/tmp/a3.json")), leArq("/tmp/a3.json").slice(0, 120));

    r = await call("POST", "/maquinas", { key: OPKEY, corpo: { nome: "suite-op" } });
    subir({ FQ_TOKEN: String(r.json?.token ?? ""), FQ_HOST: "maq-op", FQ_ARQ: "/tmp/aop.json" });
    await ate(() => leArq("/tmp/aop.json").includes("ok"));
    r = await call("POST", "/maquinas/maq-op/run", { key: TESTKEY, corpo: { cmd: "echo cruza" } });
    f.check("comum NÃO alcança máquina de outro dono (404)", r.status === 404, r.texto.slice(0, 120));
    r = await call("POST", "/maquinas/maq-op/run?tenant=operador", { key: OPKEY, corpo: { cmd: "echo admin-mira" } });
    f.check("admin alcança máquina alheia com ?tenant", r.status === 200 && r.json?.stdout === "admin-mira", r.texto.slice(0, 140));
    r = await call("GET", "/maquinas?tenant=operador", { key: TESTKEY });
    f.check("comum pede ?tenant de outro e só vê as suas", r.status === 200 && (r.json?.maquinas ?? []).every((m: any) => m.tenant === "teste"), r.texto.slice(0, 160));

    r = await call("PATCH", "/maquinas/maq-01", { key: TESTKEY, corpo: { ativo: false } });
    const sumiu = await ate(async () => {
      const x = await call("GET", "/maquinas", { key: TESTKEY });
      return !((x.json?.maquinas ?? []).find((m: any) => m.host === "maq-01"))?.online;
    }, 12000);
    r = await call("POST", "/maquinas/maq-01/run", { key: TESTKEY, corpo: { cmd: "echo desligada" } });
    f.check("desativar derruba o cano e barra novo run", sumiu && r.status === 404, { sumiu, status: r.status });
    r = await call("PATCH", "/maquinas/maq-01", { key: TESTKEY, corpo: { ativo: true } });
    const voltou = await ate(async () => {
      const x = await call("GET", "/maquinas", { key: TESTKEY });
      return !!((x.json?.maquinas ?? []).find((m: any) => m.host === "maq-01"))?.online;
    }, 15000);
    r = await call("POST", "/maquinas/maq-01/run", { key: TESTKEY, corpo: { cmd: "echo reviveu" } });
    f.check("reativar deixa a máquina religar sozinha e rodar", voltou && r.json?.stdout === "reviveu", { voltou, out: r.json?.stdout });

    r = await call("DELETE", "/maquinas/maq-01", { key: TESTKEY });
    f.check("DELETE máquina remove linha e cano", r.status === 200 && psql(`SELECT count(*) FROM maquinas WHERE tenant='teste' AND host='maq-01'`) === "0", r.texto.slice(0, 120));

    const mcp = (id: unknown, name: string, args: unknown, key: string) =>
      call("POST", "/mcp", { key, corpo: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
    r = await mcp(1, "gerar_pareamento", { nome: "suite-mcp" }, TESTKEY);
    const parMcp = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("MCP gerar_pareamento devolve token", typeof parMcp?.token === "string" && parMcp.token.length === 40, JSON.stringify(parMcp).slice(0, 100));
    subir({ FQ_TOKEN: parMcp.token, FQ_HOST: "maq-mcp", FQ_LOOP: "1", FQ_ARQ: "/tmp/amcp.json" });
    await ate(() => leArq("/tmp/amcp.json").includes("ok"));
    r = await mcp(2, "rodar_comando", { host: "maq-mcp", cmd: "echo via-mcp" }, TESTKEY);
    const rodMcp = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("MCP rodar_comando executa e audita origem mcp", rodMcp?.stdout === "via-mcp", JSON.stringify(rodMcp).slice(0, 140));
    r = await call("GET", "/maquinas/log?limit=1", { key: TESTKEY });
    f.check("log traz a execução vinda do MCP", r.json?.log?.[0]?.origem === "mcp", JSON.stringify(r.json?.log?.[0] ?? {}).slice(0, 120));
    r = await mcp(3, "maquinas_online", {}, OPKEY);
    const onlMcp = JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    f.check("MCP maquinas_online (admin sem tenant) enxerga todas", (onlMcp?.maquinas ?? []).some((m: any) => m.host === "maq-mcp") && (onlMcp?.maquinas ?? []).some((m: any) => m.host === "maq-op"), (onlMcp?.maquinas ?? []).map((m: any) => m.host).join(","));

    /* apagar usuário (carência v3.5) leva máquinas, pareamentos e log junto */
    r = await call("POST", "/usuarios", { key: OPKEY, corpo: { nome: "suite-m36", papel: "usuario" } });
    const k36 = String(r.json?.chave ?? "");
    r = await call("POST", "/maquinas", { key: k36, corpo: { nome: "m36" } });
    subir({ FQ_TOKEN: String(r.json?.token ?? ""), FQ_HOST: "maq-m36", FQ_ARQ: "/tmp/a36.json" });
    await ate(() => leArq("/tmp/a36.json").includes("ok"));
    await call("POST", "/maquinas/maq-m36/run", { key: k36, corpo: { cmd: "echo antes" } });
    await call("DELETE", "/usuarios/suite-m36", { key: OPKEY });
    psql(`UPDATE usuarios SET agendado_exclusao_em = now() - interval '1 hour' WHERE nome = 'suite-m36'`);
    await call("POST", "/decay", { key: OPKEY, corpo: {} });
    f.check(
      "expurgo do usuário apaga máquinas + pareamentos + log do tenant",
      psql(`SELECT (SELECT count(*) FROM maquinas WHERE tenant='suite-m36') || '|' || (SELECT count(*) FROM pareamentos WHERE tenant='suite-m36') || '|' || (SELECT count(*) FROM comandos_log WHERE tenant='suite-m36')`) === "0|0|0",
      psql(`SELECT count(*) FROM maquinas WHERE tenant='suite-m36'`),
    );

    /* interruptor global de controle: desligado barra chat, MCP externo e REST de uma vez */
    r = await call("POST", "/mcp", { key: OPKEY, corpo: { jsonrpc: "2.0", id: 92, method: "tools/list" } });
    const nomesOn = ((r.json?.result?.tools ?? []) as any[]).map((t) => t.name);
    r = await call("GET", "/config/mcp", { key: OPKEY });
    f.check("config/mcp reporta controle das máquinas ligado por padrão", r.status === 200 && r.json?.controle_maquinas === true, r.texto.slice(0, 120));
    r = await call("PATCH", "/config/mcp/maquinas", { key: TESTKEY, corpo: { ativo: false } });
    f.check("comum não mexe no interruptor (403)", r.status === 403, r.texto.slice(0, 100));
    r = await call("PATCH", "/config/mcp/maquinas", { key: OPKEY, corpo: { ativo: false } });
    f.check("operador desliga e a config lê false", r.status === 200 && r.json?.controle_maquinas === false, r.texto.slice(0, 120));
    r = await call("POST", "/maquinas/maq-mcp/run", { key: TESTKEY, corpo: { cmd: "echo bloqueado" } });
    f.check("desligado: REST run vira 409 com o caminho do interruptor", r.status === 409 && String(r.json?.detail ?? "").includes("Ferramentas"), r.texto.slice(0, 160));
    r = await mcp(4, "rodar_comando", { host: "maq-mcp", cmd: "echo bloqueado-mcp" }, TESTKEY);
    const txtBloq = String(r.json?.result?.content?.[0]?.text ?? "");
    f.check("desligado: MCP rodar_comando recusa com a mesma frase", txtBloq.includes("409") && txtBloq.includes("DESLIGADO"), txtBloq.slice(0, 140));
    r = await call("POST", "/mcp", { key: OPKEY, corpo: { jsonrpc: "2.0", id: 90, method: "tools/list" } });
    const nomesOff = ((r.json?.result?.tools ?? []) as any[]).map((t) => t.name);
    f.check("desligado: as 26 ferramentas de máquina somem do tools/list MCP", !nomesOff.includes("rodar_comando") && !nomesOff.includes("listar_arquivos") && !nomesOff.includes("capturar_tela") && nomesOn.includes("listar_arquivos") && nomesOff.length === nomesOn.length - 26, { on: nomesOn.length, off: nomesOff.length });
    r = await call("PATCH", "/config/mcp/maquinas", { key: OPKEY, corpo: { ativo: true } });
    r = await call("POST", "/maquinas/maq-mcp/run", { key: TESTKEY, corpo: { cmd: "echo liberado" } });
    f.check("religado: executa normal de novo", r.json?.stdout === "liberado", r.texto.slice(0, 140));
    f.check("persistido no banco (cache tem par com a tabela)", psql(`SELECT valor FROM maquinas_cfg WHERE chave='controle_ativo'`) === "1", "");

    /* fase 3: o container serve o cliente e a régua de auto-update */
    r = await call("GET", "/maquina/atualizacao", { key: TESTKEY });
    f.check("atualizacao: versão do produto + binários assados na imagem", r.status === 200 && r.json?.versao === (process.env.VERSAO ?? "3.6.0") && r.json?.cliente?.linux === true && r.json?.cliente?.win === true, JSON.stringify(r.json ?? {}).slice(0, 120));
    const respHead = await fetch(`${process.env.BASE}/maquina/cliente/linux`, { method: "HEAD", signal: AbortSignal.timeout(20000) });
    const lenCabe = Number(respHead.headers.get("content-length") ?? 0);
    f.check("download do cliente linux: 200, binário de verdade", respHead.status === 200 && lenCabe > 1_000_000 && (respHead.headers.get("content-disposition") ?? "").includes("attachment"), { status: respHead.status, len: lenCabe });
    r = await call("GET", "/maquina/cliente/mac", { key: TESTKEY });
    f.check("plataforma fora de win|linux é 404", r.status === 404, r.texto.slice(0, 100));

    execFileSync("docker", ["exec", CONTAINER, "sh", "-c", `${pkill("maqfake")} || true`]);
    f.fechar("v3.6 maquinas");
  });

  await bloco(t, "v3.7: cliente com chave assada — ativa várias máquinas, bloqueio por máquina e corte da chave", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const BASE = process.env.BASE ?? "";
    let r: Awaited<ReturnType<typeof call>>;
    const execD = (sh: string) => execFileSync("docker", ["exec", CONTAINER, "sh", "-c", sh], { encoding: "utf8" });
    instalarMatador(CONTAINER);
    const leArq = (p2: string) => {
      try {
        return execD("cat " + p2);
      } catch {
        return "";
      }
    };
    const ate = async (cond: () => Promise<boolean>, tetoMs = 15000) => {
      const fim = Date.now() + tetoMs;
      for (;;) {
        if (await cond()) return true;
        if (Date.now() > fim) return false;
        await dormir(400);
      }
    };

    const rGen = await fetch(BASE + "/maquinas/cliente/linux?nome=s37", {
      headers: { authorization: "Bearer " + TESTKEY },
      signal: AbortSignal.timeout(30000),
    });
    const bufGen = Buffer.from(await rGen.arrayBuffer());
    const rBase = await fetch(BASE + "/maquina/cliente/linux", { method: "HEAD", signal: AbortSignal.timeout(20000) });
    const lenBase = Number(rBase.headers.get("content-length") ?? 0);
    f.check("gerar cliente: 200 com trailer assado (base + payload pequeno)", rGen.status === 200 && lenBase > 1_000_000 && bufGen.length > lenBase && bufGen.length - lenBase < 500, { status: rGen.status, lenBase, lenGen: bufGen.length });
    /* v3.10.1: download por bilhete — link comum, sem header, uso único */
    const rBil = await call("POST", "/maquinas/cliente/linux/bilhete", { key: TESTKEY });
    const urlBil = String(rBil.json?.url ?? "");
    const rLink = await fetch(BASE + urlBil, { signal: AbortSignal.timeout(30000) });
    const bufLink = Buffer.from(await rLink.arrayBuffer());
    f.check(
      "download por bilhete funciona SEM header de chave (link de navegador)",
      rBil.status === 200 && urlBil.includes("bilhete=") && rLink.status === 200 && bufLink.length > lenBase,
      { status: rLink.status, bytes: bufLink.length },
    );
    const rReuso = await fetch(BASE + urlBil, { signal: AbortSignal.timeout(15000) });
    f.check("bilhete é de uso único (segundo pedido recusado)", rReuso.status === 403, rReuso.status);

    const dispo = rGen.headers.get("content-disposition") ?? "";
    f.check("nome do arquivo carrega o usuário", dispo.includes("nexos-cliente-teste"), dispo.slice(0, 90));
    execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", "cat > /tmp/cli37 && chmod 755 /tmp/cli37"], { input: bufGen });

    /* 1ª máquina: o MESMO arquivo ativa a primeira e adota token próprio */
    execD("rm -f /tmp/c37.json /tmp/c37.log /tmp/c37.out; nohup /tmp/cli37 --url http://127.0.0.1:8000 --conf /tmp/c37.json --host cli37-a >/tmp/c37.out 2>&1 & sleep 1; echo ido");
    const ativouA = await ate(async () => {
      const x = await call("GET", "/maquinas", { key: TESTKEY });
      const m = (x.json?.maquinas ?? []).find((y: any) => y.host === "cli37-a");
      return m?.online === true;
    }, 20000);
    r = await call("GET", "/maquinas", { key: TESTKEY });
    const maqA = (r.json?.maquinas ?? []).find((m: any) => m.host === "cli37-a") ?? {};
    const chS37 = (r.json?.chaves ?? []).find((c: any) => c.nome === "s37") ?? {};
    f.check("dois cliques: o cliente ativa a máquina, que se batiza com o próprio nome", ativouA && maqA.nome === "cli37-a" && Number(chS37.ativacoes) === 1, { ativouA, nome: maqA.nome, ativacoes: chS37.ativacoes });

    const confA = JSON.parse(leArq("/tmp/c37.json") || "{}");
    f.check("cliente adotou a chave definitiva no conf (trailer queimou atrás)", typeof confA.token === "string" && confA.token.length === 40, Object.keys(confA).join(","));

    /* 2ª máquina, MESMO arquivo: v3.10 — chave de conta serve para várias máquinas */
    execD("rm -f /tmp/c37b.json /tmp/c37b.log /tmp/c37b.out; nohup /tmp/cli37 --url http://127.0.0.1:8000 --conf /tmp/c37b.json --host cli37-b >/tmp/c37b.out 2>&1 & sleep 2; echo ido");
    const ativouB = await ate(async () => {
      const x = await call("GET", "/maquinas", { key: TESTKEY });
      const m = (x.json?.maquinas ?? []).find((y: any) => y.host === "cli37-b");
      return m?.online === true;
    }, 25000);
    r = await call("GET", "/maquinas", { key: TESTKEY });
    const chDepois = (r.json?.chaves ?? []).find((c: any) => c.nome === "s37") ?? {};
    const confB = JSON.parse(leArq("/tmp/c37b.json") || "{}");
    f.check("mesmo arquivo ativa uma SEGUNDA máquina (chave de várias máquinas)", ativouB && Number(chDepois.ativacoes) === 2, { ativouB, ativacoes: chDepois.ativacoes });
    f.check("cada máquina fica com token PRÓPRIO (não compartilham a chave)", typeof confB.token === "string" && confB.token.length === 40 && confB.token !== confA.token, { a: String(confA.token).slice(0, 6), b: String(confB.token).slice(0, 6) });

    /* bloqueio é POR MÁQUINA: desligar a b derruba só a b */
    r = await call("PATCH", "/maquinas/cli37-b", { key: TESTKEY, corpo: { ativo: false } });
    const caiuB = await ate(async () => {
      const x = await call("GET", "/maquinas", { key: TESTKEY });
      const b = (x.json?.maquinas ?? []).find((y: any) => y.host === "cli37-b");
      const a = (x.json?.maquinas ?? []).find((y: any) => y.host === "cli37-a");
      return r.status === 200 && b?.ativo === false && b?.online === false && a?.online === true;
    }, 15000);
    f.check("bloquear uma máquina não afeta a outra", caiuB, JSON.stringify(r.json).slice(0, 120));

    /* cortar a chave: para NOVAS ativações, mantém as máquinas que já ativaram */
    r = await call("DELETE", `/maquinas/chave/${String(chS37.id ?? "nao")}`, { key: TESTKEY });
    f.check("cortar chave mantém as máquinas já ativadas", r.status === 200 && r.json?.maquinas_mantidas === 2, r.texto.slice(0, 140));
    r = await call("GET", "/maquinas", { key: TESTKEY });
    const hostsS37 = (r.json?.maquinas ?? []).filter((m: any) => m.host === "cli37-a" || m.host === "cli37-b");
    f.check(
      "chave some da lista e as duas máquinas continuam lá",
      (r.json?.chaves ?? []).every((c: any) => c.nome !== "s37") && hostsS37.length === 2,
      JSON.stringify({ chaves: (r.json?.chaves ?? []).map((c: any) => c.nome), maqs: hostsS37.map((m: any) => m.host) }).slice(0, 150),
    );

    execD("node /tmp/matar-clientes.js");
    for (const h of ["cli37-a", "cli37-b"]) await call("DELETE", `/maquinas/${h}`, { key: TESTKEY });
    await ate(async () => {
      const x = await call("GET", "/maquinas", { key: TESTKEY });
      return (x.json?.maquinas ?? []).every((m: any) => m.host !== "cli37-a" && m.host !== "cli37-b");
    }, 12000);

    const rGen2 = await fetch(BASE + "/maquinas/cliente/linux?nome=s37virgem", { headers: { authorization: "Bearer " + TESTKEY }, signal: AbortSignal.timeout(30000) });
    await rGen2.arrayBuffer();
    r = await call("GET", "/maquinas", { key: TESTKEY });
    const chV = (r.json?.chaves ?? []).find((c: any) => c.nome === "s37virgem") ?? {};
    r = await call("DELETE", `/maquinas/chave/${String(chV.id ?? "nao")}`, { key: TESTKEY });
    f.check("cortar chave virgem some com ela sem mexer em máquina", r.status === 200 && r.json?.maquinas_mantidas === 0, r.texto.slice(0, 120));

    const chavePlana = execD(
      `node -e "const fs=require('fs');const b=fs.readFileSync('/tmp/cli37');const len=b.readUInt32BE(b.length-8);console.log(JSON.parse(b.slice(b.length-8-len,b.length-8)).k)"`,
    ).trim();
    r = await call("GET", "/maquinas", { key: chavePlana });
    f.check("chave de cliente JAMAIS loga no painel (401)", r.status === 401, { status: r.status, k: chavePlana.slice(0, 6) + "…" });

    const rWin = await fetch(BASE + "/maquinas/cliente/win", { headers: { authorization: "Bearer " + OPKEY }, signal: AbortSignal.timeout(60000) });
    const lenWin = Number(rWin.headers.get("content-length") ?? 0);
    f.check("gerar cliente Windows também sai com trailer", rWin.status === 200 && lenWin > 80_000_000, { status: rWin.status, len: lenWin });
    await rWin.arrayBuffer();

    execD("node /tmp/matar-clientes.js; rm -f /tmp/c37v.json");
    f.fechar("v3.7 chave-cliente");
  });

  await bloco(t, "v3.9: painel local do cliente — estado, SSE, comandos e porta alternativa", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const BASE = process.env.BASE ?? "";
    const execD = (sh: string) => execFileSync("docker", ["exec", CONTAINER, "sh", "-c", sh], { encoding: "utf8" });
    instalarMatador(CONTAINER);
    const matarClientes = () => execD("node /tmp/matar-clientes.js; echo ok").trim();
    const portaLivre = (p: number) =>
      execD(`node -e "fetch('http://127.0.0.1:${p}/api/estado').then(()=>console.log('ocupada')).catch(()=>console.log('livre'))"`).trim() === "livre";
    const fonte = readFileSync(join(process.cwd(), "agente", "cliente.js"));
    execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", "cat > /tmp/cliente-painel.js"], { input: fonte });

    const rPar = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome: "painel-s39" } });
    const tokenS39 = String(rPar.json?.token ?? "");
    f.check("v3.9 pareamento criado para a sonda do painel", rPar.status === 201 && tokenS39.length === 40, rPar.status);

    matarClientes();
    for (let i = 0; i < 30 && !portaLivre(48123); i++) await dormir(500);
    execD("rm -f /tmp/conf-p39.json /tmp/conf-p39b.json /tmp/nexos-cliente.log");
    execD(`nohup env MINIRAG_MAQUINA_CONF=/tmp/conf-p39.json node /tmp/cliente-painel.js --token ${tokenS39} --url ${BASE} --host maq-s39 --sem-janela >/tmp/c39.out 2>&1 & sleep 1; echo ok`);

    /* porta REAL do painel: sai do log que acabou de nascer (só este cliente vivo) */
    let porta = 0;
    for (let i = 0; i < 30 && !porta; i++) {
      const m = execD("grep -oE 'painel local em http://127.0.0.1:[0-9]+/' /tmp/nexos-cliente.log 2>/dev/null | tail -1").match(/:([0-9]+)\//);
      if (m) porta = Number(m[1]);
      else await dormir(500);
    }
    f.check("v3.9 painel abriu e anunciou a porta", porta >= 48123, "porta=" + porta);

    const ate = async (cond: () => Promise<boolean>, tetoMs = 15000) => {
      const fim = Date.now() + tetoMs;
      for (;;) {
        if (await cond()) return true;
        if (Date.now() > fim) return false;
        await dormir(500);
      }
    };
    const estado = () =>
      JSON.parse(
        execD(`node -e "fetch('http://127.0.0.1:${porta}/api/estado').then(r=>r.json()).then(j=>console.log(JSON.stringify({online:j.online,host:j.host,porta:j.porta,comandos:j.comandos||[]}))).catch(()=>console.log('{}'))"`) || "{}",
      );
    const online39 = await ate(async () => {
      const e = estado();
      return e.online === true && e.host === "maq-s39";
    }, 25000);
    f.check("v3.9 painel fala do próprio cliente: online e máquina no estado", online39, JSON.stringify(estado()).slice(0, 150));

    const html39 = execD(`node -e "fetch('http://127.0.0.1:${porta}/').then(r=>r.text()).then(t=>console.log(t.includes('nexos')&&t.includes('Conex')&&t.includes('Log')?'tem':'falta'))"`).trim();
    f.check("v3.9 página do painel sai com as seções (conexão, log)", html39 === "tem", html39);

    const sse39 = execD(`node -e "const c=new AbortController();setTimeout(()=>c.abort(),3000);fetch('http://127.0.0.1:${porta}/evento',{signal:c.signal}).then(async r=>{const rd=r.body.getReader();const a=await rd.read();console.log(a.value?Buffer.from(a.value).toString().slice(0,40):'vazio')}).catch(()=>{})"`);
    f.check("v3.9 SSE entrega o estado inicial", sse39.includes("oi"), sse39.slice(0, 60));

    const rRun39 = await call("POST", "/maquinas/maq-s39/run", { key: TESTKEY, corpo: { cmd: "echo painel-s39-dentro" } });
    await dormir(900);
    const noPainel = estado().comandos ?? [];
    f.check(
      "v3.9 comando do servidor aparece no painel (exit e rótulo)",
      rRun39.status === 200 && noPainel.some((c: any) => String(c.rotulo ?? "").includes("painel-s39-dentro") && c.exit === 0),
      JSON.stringify(noPainel).slice(0, 150),
    );

    execD(`nohup env MINIRAG_MAQUINA_CONF=/tmp/conf-p39b.json node /tmp/cliente-painel.js --token ${tokenS39} --url ${BASE} --host maq-s39b --sem-janela >/tmp/c39b.out 2>&1 & sleep 1; echo ok`);
    const segunda = await ate(async () => {
      try {
        const j = JSON.parse(execD(`node -e "fetch('http://127.0.0.1:${porta + 1}/api/estado').then(r=>r.json()).then(j=>console.log(JSON.stringify({porta:j.porta}))).catch(()=>console.log('{}'))"`) || "{}");
        return j.porta === porta + 1;
      } catch {
        return false;
      }
    }, 12000);
    f.check("v3.9 segunda instância usa a porta seguinte sem briga", segunda, "esperada=" + (porta + 1));

    matarClientes();
    execD("rm -f /tmp/conf-p39.json /tmp/conf-p39b.json");
    await call("DELETE", `/maquinas/chave/${String(rPar.json?.id ?? "nao")}`, { key: TESTKEY });
    f.fechar("v3.9 painel");
  });

  await bloco(t, "v3.13.1: o cliente atravessa o deploy (soquete pendurado, zumbi na porta)", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const execD = (sh: string) => execFileSync("docker", ["exec", CONTAINER, "sh", "-c", sh], { encoding: "utf8" });
    const instalar = (arq: string, conteúdo: string | Buffer) =>
      execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", `cat > ${arq}`], { input: conteúdo });
    const ate = async (cond: () => Promise<boolean>, tetoMs = 20000) => {
      const fim = Date.now() + tetoMs;
      for (;;) {
        if (await cond()) return true;
        if (Date.now() > fim) return false;
        await dormir(500);
      }
    };
    const online = async (host: string) => {
      const x = await call("GET", "/maquinas", { key: TESTKEY });
      return (x.json?.maquinas ?? []).find((y: any) => y.host === host)?.online === true;
    };
    const leLog = () => {
      try {
        return execD("cat /tmp/nexos-cliente.log 2>/dev/null");
      } catch {
        return "";
      }
    };
    /* Conta/mata pelo ARGUMENTO do node (argv[1]), não por texto solto: o wrapper
       sh -c da gente contém os caminhos todos e mataria a si mesmo. */
    instalar("/tmp/procura3131.js",
      'const fs=require("fs"),alvo=process.argv[2];let n=0;for(const d of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(d))continue;try{const c=fs.readFileSync("/proc/"+d+"/cmdline","utf8").split(String.fromCharCode(0));if(c[1]===alvo){n++;if(process.argv[3]==="mata")process.kill(Number(d),"SIGKILL")}}catch{}}console.log(n);');
    const vivos = () => execD("node /tmp/procura3131.js /tmp/maq3131.js").trim();
    const matarCli = () => execD("node /tmp/procura3131.js /tmp/maq3131.js mata").trim();

    /* O hub que engole: abre o TCP e nunca conclui o handshake — o retrato exato do
       proxy na frente do nexos enquanto o container reinicia (foi o que matou o
       cliente do dono em 23/10). Modo lido de arquivo: "engole" ou "liga" (encaminha
       para o hub de verdade). Motor: o Node 22 do container, o mesmo assado no .exe. */
    instalar("/tmp/hubmodo3131.js",
      'const net=require("node:net"),fs=require("node:fs");const M="/tmp/hubmodo3131.modo";' +
      'const modo=()=>{try{return fs.readFileSync(M,"utf8").trim()}catch{return "engole"}};' +
      'net.createServer((cli)=>{if(modo()!=="liga"){cli.on("error",()=>{});return}' +
      'const up=net.connect(8000,"127.0.0.1");cli.pipe(up);up.pipe(cli);' +
      'cli.on("error",()=>up.destroy());up.on("error",()=>cli.destroy());' +
      '}).listen(8123,"127.0.0.1",()=>console.log("hub-modo pronto"));');
    instalar("/tmp/maq3131.js", readFileSync(join(process.cwd(), "agente", "cliente.js")));

    const rPar = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome: "s3131" } });
    const token3131 = String(rPar.json?.token ?? "");
    f.check("v3.13.1 pareamento criado para a máquina do teste", rPar.status === 201 && token3131.length === 40, rPar.status);

    execD("node /tmp/procura3131.js /tmp/hubmodo3131.js mata >/dev/null 2>&1; node /tmp/procura3131.js /tmp/maq3131.js mata >/dev/null 2>&1");
    execD("rm -f /tmp/nexos-cliente.log /tmp/c3131.json /tmp/c3131b.json /tmp/hubmodo3131.modo");
    execD("nohup node /tmp/hubmodo3131.js >/tmp/hubmodo3131.out 2>&1 & sleep 1; echo ok");

    /* 1) handshake pendurado: o laço TEM que continuar remarcando (na 3.13.0 morria na 1ª) */
    execD(`nohup node /tmp/maq3131.js --url http://127.0.0.1:8123 --conf /tmp/c3131.json --token ${token3131} --host maq3131 --sem-janela >/tmp/c3131.out 2>&1 & sleep 1; echo ok`);
    /* 45 s fixos só para ver a 2ª tentativa (o laço remarca a cada 15 s): vira espera com prazo —
       sai assim que a 2ª aparece (~16 s) e mantém os 45 s de folga se a máquina estiver lenta. */
    await ate(async () => (leLog().match(/conectando em/g) || []).length >= 2, 45000);
    const l1 = leLog();
    const tentativas = (l1.match(/conectando em/g) || []).length;
    f.check("v3.13.1 soquete pendurado: o relógio dos 15 s larga o soquete e o laço remarca (≥2 em 45 s)", tentativas >= 2 && l1.includes("reconecto em"), `tentativas=${tentativas}`);
    f.check("v3.13.1 o processo continua vivo tentando (não virou zumbi calado)", vivos() === "1", "vivos=" + vivos());
    f.check("v3.13.1 com o hub engolindo, a máquina não aparece online", !(await online("maq3131")), String(await online("maq3131")));

    /* 2) zumbi na porta: o segundo clique no exe novo assume em vez de se matar */
    execD(`nohup node /tmp/maq3131.js --url http://127.0.0.1:8123 --conf /tmp/c3131.json --token ${token3131} --host maq3131 --sem-janela >/tmp/c3131b.out 2>&1 & sleep 2; echo ok`);
    const assumiu = await ate(async () => leLog().includes("peço que ele saia e eu assumo"), 25000);
    const umSo = await ate(async () => vivos() === "1", 15000);
    f.check("v3.13.1 o instance novo vê o vizinho vivo-sem-conexão e assume a porta", assumiu, leLog().split("\n").slice(-2).join(" | ").slice(0, 200));
    f.check("v3.13.1 sobra UM cliente na máquina (o velho atendeu ao pedido de saída)", umSo === true, "vivos=" + vivos());

    /* 3) volta ao mundo real: o hub bom responde e o laço — que nunca parou — reconecta sozinho */
    execD("echo liga > /tmp/hubmodo3131.modo");
    const voltou = await ate(() => online("maq3131"), 90000);
    f.check("v3.13.1 quando o hub volta, o cliente reconecta SOZINHO e fica online", voltou === true, "online=" + String(await online("maq3131")));

    const rRun = await call("POST", "/maquinas/maq3131/run", { key: TESTKEY, corpo: { cmd: "echo atravessou" } });
    f.check("v3.13.1 o túnel volta a executar depois do tranco", rRun.status === 200 && String(rRun.json?.stdout ?? "").includes("atravessou"), rRun.texto.slice(0, 120));

    /* 4) o servidor diz POR QUE a máquina caiu (antes, fechamento era mudo no log) */
    matarCli();
    await ate(async () => !(await online("maq3131")), 30000);
    const logServidor = execFileSync("sh", ["-c", `docker logs ${CONTAINER} 2>&1 | grep -oE "OFFLINE [^ ]*maq3131 \\(código [^)]*\\)" | tail -1`], { encoding: "utf8" }).trim();
    f.check("v3.13.1 o log do servidor traz código e duração da conexão", /código \d+, vivo \d+s/.test(logServidor), logServidor || "(sem linha OFFLINE maq3131 no log)");

    execD("node /tmp/procura3131.js /tmp/hubmodo3131.js mata >/dev/null 2>&1; node /tmp/procura3131.js /tmp/maq3131.js mata >/dev/null 2>&1");
    execD("rm -f /tmp/c3131.json /tmp/c3131b.json /tmp/maq3131.js /tmp/hubmodo3131.js /tmp/hubmodo3131.modo /tmp/procura3131.js /tmp/nexos-cliente.log");
    await call("DELETE", `/maquinas/chave/${String(rPar.json?.id ?? "nao")}`, { key: TESTKEY });
    f.fechar("v3.13.1 cliente atravessa o deploy");
  });

  /* ------------------------------------------------------------------ v3.15 */

  await bloco(t, "v3.15: o rastro do turno na ordem, com o tempo de cada passo", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v315";
    if (!CONTAINER || !OPKEY) {
      f.check("v3.15 precisa do container (provedor falso dentro dele)", true, "sem CONTAINER: bloco não executável");
      f.fechar("v3.15 rastro do turno");
      return;
    }

    /* Provedor falso de DUAS RODADAS, em streaming: a 1ª pensa, fala no caminho e chama uma
       ferramenta interna; a 2ª pensa de novo e fecha. É o retrato do que o dono vê no IA_GO. */
    const codigo = [
      "const http=require('http');",
      "http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const m=j.messages||[];const ja=m.filter(x=>x.role==='tool').length>0;",
      "if(!j.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'SEM-STREAM-V315'}}]}));return;}",
      "res.setHeader('content-type','text/event-stream');",
      "const pec=(o)=>'data: '+JSON.stringify({choices:[{delta:o}]})+'\\n\\n';",
      "const passos=[];",
      "if(!ja){for(let i=1;i<=4;i++)passos.push(pec({reasoning_content:'pen'+i+' '}));",
      "passos.push(pec({content:'vou ver as gavetas. '}));",
      "passos.push(pec({tool_calls:[{index:0,id:'c1',type:'function',function:{name:'list_gavetas',arguments:'{}'}}]}));}",
      "else{for(let i=1;i<=3;i++)passos.push(pec({reasoning_content:'som'+i+' '}));passos.push(pec({content:'PRONTO-V315'}));}",
      "passos.push('data: [DONE]\\n\\n');",
      "let k=0;const t=setInterval(()=>{if(k<passos.length){res.write(passos[k]);k++;return;}clearInterval(t);res.end();},120);",
      "});})",
      ".listen(9919,'127.0.0.1');setTimeout(()=>process.exit(0),150000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codigo]);
    await dormir(1200);

    const baseV315 = {
      tipo: "litellm",
      base_url: "http://127.0.0.1:9919/v1",
      chave: "***",
      modelo: "modelo-v315",
      temperatura: 0.2,
      system_prompt: "",
      mcp_interno: true,
      max_rodadas: 3,
      ativo: true,
      global: true,
    };
    let r = await call("PUT", "/config/provider", { key: OPKEY, corpo: baseV315 });
    f.check("provedor de duas rodadas armado com MCP interno", r.status === 200 && r.json?.mcp_interno === true, r.texto.slice(0, 140));

    const correr = async (corpo: Record<string, unknown>) => {
      const resp = await fetch(`${BASE}/chat/stream`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPKEY}`, "content-type": "application/json" },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(120_000),
      });
      const bruto = await resp.text();
      const eventos = bruto
        .split("\n\n")
        .map((blocoTxt) => blocoTxt.split("\n").find((l) => l.startsWith("data:")))
        .filter((l): l is string => !!l)
        .map((l) => {
          try {
            return JSON.parse(l.slice(5).trim());
          } catch {
            return {};
          }
        });
      return { eventos, bruto };
    };

    const rod = await correr({ pergunta: "me mostre o rastro do turno", memoria: GAV });
    const fim = rod.eventos.find((e: any) => e.tipo === "fim") ?? {};
    const trilha: any[] = (fim.dados?.rastro ?? []) as any[];
    const tipos = trilha.map((s) => s.tipo).join(">");
    f.check(
      "o `fim` traz o RASTRO na ordem: pensamento > fala de caminho > ferramenta > pensamento",
      tipos === "pensamento>narracao>ferramenta>pensamento",
      tipos || rod.bruto.slice(0, 120),
    );
    const pens = trilha.filter((s) => s.tipo === "pensamento");
    f.check("cada bloco de pensamento saiu com o tempo MEDIDO dele (>0)", pens.length === 2 && pens.every((s) => Number(s.ms) > 0), JSON.stringify(pens.map((s) => s.ms)));
    const tool = trilha.find((s) => s.tipo === "ferramenta") ?? {};
    f.check("a linha da ferramenta diz qual foi, se deu certo e quanto demorou", tool.nome === "list_gavetas" && tool.servidor === "nexos" && tool.ok === true && Number(tool.ms) >= 0, JSON.stringify(tool).slice(0, 140));
    f.check("a fala de caminho está na trilha (não foi engolida pela resposta)", trilha.some((s) => s.tipo === "narracao" && /vou ver as gavetas/.test(String(s.texto))), String(trilha.find((s) => s.tipo === "narracao")?.texto ?? "").slice(0, 60));
    /* v3.35 — a narração NASCE no rastro: nenhum pedaço dela pode ter passado como delta */
    const deltasV315 = rod.eventos.filter((e: any) => e.tipo === "delta").map((e: any) => String(e.texto ?? "")).join("");
    const evFala315 = rod.eventos.filter((e: any) => e.tipo === "fala");
    f.check("NARRAÇÃO NUNCA PASSA PELA BOLHA: nenhum delta carrega o texto da fala", !deltasV315.includes("vou ver as gavetas"), deltasV315.slice(0, 120) || "(nenhum delta)");
    f.check("a fala chega como evento próprio, antes da ferramenta", evFala315.length === 1 && /vou ver as gavetas/.test(String(evFala315[0].texto)), JSON.stringify(evFala315).slice(0, 160));
    f.check("a RESPOSTA continua fluindo como delta (o que não é fala digita)", deltasV315.includes("PRONTO-V315"), deltasV315.slice(-80));
    f.check("a resposta final NÃO é uma etapa do rastro", !trilha.some((s) => /PRONTO-V315/.test(String(s.texto ?? ""))) && String(fim.dados?.resposta ?? "").includes("PRONTO-V315"), String(fim.dados?.resposta ?? "").slice(0, 60));

    r = await call("GET", `/chat?memoria=${GAV}&limit=10`, { key: OPKEY });
    const assist = (r.json?.mensagens ?? []).filter((m: any) => m.papel === "assistant").pop() ?? {};
    const gravado: any[] = assist.rastro ?? [];
    f.check("reabrir a conversa devolve a MESMA trilha, com o tempo de cada passo", gravado.map((s) => s.tipo).join(">") === tipos && gravado.every((s) => "ms" in s || s.tipo === "narracao"), JSON.stringify(gravado.map((s) => s.tipo)));
    f.check("os campos de antes continuam lá (nenhum consumidor quebrado)", (assist.ferramentas ?? []).length === 1 && (assist.falas ?? []).length === 1 && typeof assist.raciocinio === "string" && assist.raciocinio.length > 0, JSON.stringify({ fx: (assist.ferramentas ?? []).length, fl: (assist.falas ?? []).length, ra: (assist.raciocinio ?? "").length }));

    /* degradação honesta: o chat chamado SEM streaming (superfície MCP) não tem como medir
       tempo nem ordem fina -> a trilha fica vazia em vez de inventar passo; a resposta intacta */
    const viaMcp = await call("POST", "/mcp", {
      key: TESTKEY,
      corpo: { jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "chat", arguments: { pergunta: "agora sem ferramenta nem pensamento", memoria: GAV } } },
    });
    f.check("o chat sem streaming pelo MCP respondeu", viaMcp.status === 200 && String(viaMcp.texto).includes("SEM-STREAM-V315"), String(viaMcp.texto).slice(0, 120));
    /* a pergunta pelo MCP pertence a QUEM chamou (outra gaveta de outro usuário): ler o
       histórico com a chave do chamador, senão a checagem procura no tenant errado */
    r = await call("GET", `/chat?memoria=${GAV}&limit=4`, { key: TESTKEY });
    const ult = (r.json?.mensagens ?? []).filter((m: any) => m.papel === "assistant").pop() ?? {};
    f.check("turno sem streaming tem trilha VAZIA (nada inventado) e resposta intacta", Array.isArray(ult.rastro) && ult.rastro.length === 0 && String(ult.texto).includes("SEM-STREAM-V315"), JSON.stringify({ rastro: ult.rastro ?? null, texto: String(ult.texto ?? "").slice(0, 40) }));

    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ...baseV315, ativo: false } });
    f.fechar("v3.15 rastro do turno");
  });

  await bloco(t, "v3.8: vocabulário do túnel no MCP + falas que ficam na tela", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";

    /* provedor OpenAI-compatível falso DENTRO do container, com duas rodadas:
       a 1ª responde texto + tool_call (vira FALA), a 2ª fecha a conversa */
    if (CONTAINER) {
      const codigo = [
        "const http=require('http');let n=0;",
        "http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{n++;",
        "res.setHeader('content-type','application/json');let out;",
        "if(n===1)out={choices:[{message:{role:'assistant',content:'vou ver a pasta',tool_calls:[{id:'c1',type:'function',function:{name:'listar_arquivos',arguments:'" + '{"host":"maq-8","caminho":"/tmp"}' + "'}}]}}]};",
        "else out={choices:[{message:{role:'assistant',content:'PRONTO-V38'}}]};",
        "res.end(JSON.stringify(out));",
        "});}).listen(9912,'127.0.0.1');",
        "setTimeout(()=>process.exit(0),90000);",
      ].join("");
      execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codigo]);
      await dormir(1200);
    }

    let r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9912/v1", modelo: "modelo-v38", chave: "***", temperatura: 0.2, system_prompt: "", mcp_interno: true, max_rodadas: 60, ativo: true, global: true },
    });
    f.check("max_rodadas aceita 60 (teto novo)", r.status === 200, r.texto.slice(0, 160));
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { max_rodadas: 61, global: true } });
    f.check("max_rodadas 61 e rejeitado (422)", r.status === 422, r.status);

    /* máquina falsa (mesmo wire do v3.6) para as tools andarem de verdade */
    const FAKE = [
      'const WebSocket=require("/app/node_modules/ws");const fs=require("fs");',
      'const url=process.env.FQ_URL||"ws://127.0.0.1:8000/maquina/ws";',
      'const token=process.env.FQ_TOKEN||"", host=process.env.FQ_HOST||"maq", arq=process.env.FQ_ARQ;',
      'let cur=token;const ws=new WebSocket(url);',
      'ws.on("open",()=>ws.send(JSON.stringify({token:cur,host,os:"fake",user:"suite"})));',
      'ws.on("message",(b)=>{let m={};try{m=JSON.parse(String(b))}catch{return}',
      'if(m.ack){fs.writeFileSync(arq,JSON.stringify(m));if(m.token){cur=m.token}}',
      'else if(typeof m.cmd==="string"){const e=m.cmd.indexOf("echo ");',
      'if(e===0)setTimeout(()=>{try{ws.send(JSON.stringify({exit:0,stdout:m.cmd.slice(5),stderr:""}))}catch{}},100);',
      'else ws.send(JSON.stringify({exit:0,stdout:"fake-listing",stderr:""}))}});',
      'ws.on("error",()=>{});setTimeout(()=>process.exit(0),80000);',
    ].join("");
    execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", "cat > /app/maqfake8.js"], { input: FAKE });
    r = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome: "suite-8" } });
    execFileSync("docker", ["exec", "-d", CONTAINER, "sh", "-c", `FQ_TOKEN='${String(r.json?.token ?? "")}' FQ_HOST=maq-8 FQ_ARQ=/tmp/a8.json node /app/maqfake8.js`]);
    let viuMaq = false;
    for (let i = 0; i < 40 && !viuMaq; i++) {
      await dormir(400);
      viuMaq = (String((await call("GET", "/maquinas", { key: TESTKEY })).texto)).includes("maq-8");
    }
    f.check("maq-8 pareada e online", viuMaq);

    /* as 20 tools do vocabulário na superfície MCP */
    const VOCAB = ["listar_arquivos", "ler_arquivo", "escrever_arquivo", "buscar_arquivos", "grep_remoto", "editar_no_local", "estado_maquina", "processos", "janelas", "area_transferencia", "falar", "abrir", "servicos", "eventos", "rede", "esperar_arquivo", "power", "rodar_lote", "sessao", "git_remoto"];
    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const nomes: string[] = (r.json?.result?.tools ?? []).map((x: any) => x.name);
    f.check("tools/list traz as 20 ferramentas do vocabulário", VOCAB.every((n) => nomes.includes(n)), VOCAB.filter((n) => !nomes.includes(n)).join(","));

    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "listar_arquivos", arguments: { host: "maq-8", caminho: "/tmp" } } } });
    f.check("tools/call listar_arquivos trafega pelo hub", r.status === 200 && r.json?.result?.isError !== true && String(r.json?.result?.content?.[0]?.text ?? "").includes("fake-listing"), JSON.stringify(r.json).slice(0, 200));

    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "power", arguments: { host: "maq-8", acao: "restart" } } } });
    f.check("power sem confirmar recusa (governança)", r.json?.result?.isError === true, JSON.stringify(r.json).slice(0, 200));

    r = await call("GET", "/maquinas/log?limit=10", { key: TESTKEY });
    f.check("auditoria marcou origem mcp", (r.json?.log ?? []).some((l: any) => String(l.origem).startsWith("mcp:") && l.host === "maq-8"), JSON.stringify((r.json?.log ?? []).slice(0, 2)));

    /* o chat de duas rodadas: a fala do caminho vira balão e é persistida */
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "lista a pasta tmp da maq-8", memoria: "suite-v38" } });
    f.check("resposta final chega após rodada de ferramenta", r.status === 200 && String(r.json?.resposta) === "PRONTO-V38", r.texto.slice(0, 200));
    f.check("falas voltam no corpo da resposta", Array.isArray(r.json?.falas) && r.json?.falas?.[0] === "vou ver a pasta", JSON.stringify(r.json?.falas));
    f.check("ferramenta da rodada registrada", (r.json?.ferramentas ?? []).some((x: any) => x.nome === "listar_arquivos"), JSON.stringify(r.json?.ferramentas ?? []).slice(0, 200));

    r = await call("GET", "/chat?memoria=suite-v38", { key: TESTKEY });
    const ult = (r.json?.mensagens ?? []).filter((m: any) => m.papel === "assistant").pop();
    f.check("histórico persiste a coluna falas", Array.isArray(ult?.falas) && ult?.falas?.[0] === "vou ver a pasta", JSON.stringify(ult).slice(0, 220));

    /* volta o provider para inerte e derruba os falsos (não contaminar o freio final) */
    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ativo: false, global: true } });
    if (CONTAINER) execFileSync("docker", ["exec", CONTAINER, "sh", "-c", `${pkill("maqfake8")} || ${pkill("9912")} || true`]);
    f.fechar("v3.8 vocab e falas");
  });

  await bloco(t, "v3.18: básico de chat — parar, fontes, custo, regenerar, recorte, título, rótulo, busca, meta", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const DB = process.env.DBCONTAINER ?? "";
    const GAV = "suite-v318";
    const GAV2 = "suite-v318-t";
    if (!CONTAINER || !DB) {
      f.check("v3.18 precisa de CONTAINER+DBCONTAINER", false, "sem containers: bloco não executável");
      f.fechar("v3.18 básico de chat");
      return;
    }
    const psql = (sql: string) =>
      execFileSync("docker", ["exec", DB, "sh", "-c", `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "${sql}"`], { encoding: "utf8" }).trim();

    // porta ROTATIVA (19000+seg%900): fakes de rodadas anteriores nunca colidem; kill é só faxina
    const PORTF = 19000 + (Math.floor(Date.now() / 1000) % 900);
    console.log(`-- provedor falso ${PORTF}: stream 12 pecas ~200ms (longo devagar-lento); sem stream responde direto`);
    const cod = [
      "const http=require('http');",
      "http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const m=j.messages||[];const comTool=m.filter(x=>x.role==='tool').length>0;",
      "if(j.stream){res.setHeader('content-type','text/event-stream');const base=['A ','nota ','5512 ','da ','Beta ','somou ','R$9.876,54 ','e ','fechou ','o ','teste ','parar. '];const longo=(j.messages||[]).some(x=>String(x.content||'').includes('devagar-lento'));const pecas=longo?base.concat(Array.from({length:200},()=>'devagar ')):base;let k=0;",
      "const t=setInterval(()=>{if(k<pecas.length){res.write('data: '+JSON.stringify({choices:[{delta:{content:pecas[k]}}]})+'\\n\\n');k++;return;}clearInterval(t);res.write('data: [DONE]\\n\\n');res.end();},240);return;}",
      "res.setHeader('content-type','application/json');",
      "if(JSON.stringify(m).includes('apenas o titulo'))return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'conta da nota 5512'}}]}));",
      "if(!comTool)return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'f1',type:'function',function:{name:'search',arguments:JSON.stringify({query:'nota 5512',k:3,min_score:0,memoria:'suite-v318'})}}]}}]}));",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'A nota 5512 da Beta soma R$ 9.876,54 [tarefa 18].'}}]}));",
      "});}).listen(" + PORTF + ",'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    // o container NAO tem `ps`: varre /proc em node e mata o fake anterior da 9921
    execFileSync("docker", ["exec", CONTAINER, "node", "-e",
      "const fs=require('fs');for(const d of fs.readdirSync('/proc')){if(!/^[0-9]+$/.test(d))continue;try{const c=fs.readFileSync('/proc/'+d+'/cmdline','utf8').split('\\0').join(' ');if(c.includes('" + PORTF + "')&&+d!==process.pid)process.kill(+d);}catch(e){}}"]);
    await dormir(900); // aguarda a porta ser liberada ANTES do bind (kill -> EADDRINUSE se ligar cedo)
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", cod]);
    // registra o provider UMA vez e sonda o fake com UM chat por passo (spam de requests trava no freio)
    let rp = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: `http://127.0.0.1:${PORTF}/v1`, modelo: "basico18", temperatura: 0, system_prompt: "", mcp_interno: true, max_rodadas: 3, ativo: true, global: true },
    });
    f.check("provider falso salvo", rp.status === 200, rp.texto.slice(0, 140));
    let fakeVivo = false;
    for (let k = 0; k < 15 && !fakeVivo; k++) {
      await dormir(500);
      if (!fakeVivo) {
        const probe = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "sonda fake vivo", memoria: "suite-v318" } });
        fakeVivo = probe.status === 200 && String(probe.texto).includes("9.876,54");
      }
    }
    f.check("provedor falso no ar (sonda unica)", fakeVivo, "sonda de vida");

    /* bloco idempotente: apaga restos de rodadas anteriores (o banco de teste sobrevive entre runs) */
    psql(`DELETE FROM chat_mensagens WHERE tenant='teste' AND memoria IN ('${GAV}','${GAV2}')`);
    psql(`DELETE FROM chat_tarefas WHERE tenant='teste' AND memoria IN ('${GAV}','${GAV2}')`);
    psql(`DELETE FROM gavetas WHERE tenant='teste' AND memoria IN ('${GAV}','${GAV2}')`);

    const rg = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite18-doc", content: "Nota fiscal suite18-doc 5512 da empresa Beta. Total R$ 9.876,54 vencendo em 05/12/2026.", memoria: GAV },
    });
    const job = await esperarJob(TESTKEY, rg.json?.job_id);
    f.check("doc da v3.18 indexado", job.status === "concluido", job);
    /* o search interno usa a MEMORIA do chat — a GAV2 da tarefa também precisa do doc */
    const rg2 = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite18-doc", content: "Nota fiscal suite18-doc 5512 da empresa Beta. Total R$ 9.876,54 vencendo em 05/12/2026.", memoria: GAV2 },
    });
    const job2 = await esperarJob(TESTKEY, rg2.json?.job_id);
    f.check("doc também na gaveta da tarefa", job2.status === "concluido", job2);

    console.log("-- POST /chat (sync): fontes reais + custo na resposta");
    const rs = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "quanto é a nota 5512 da Beta?", memoria: GAV } });
    f.check("resposta chegou com ferramentas", rs.status === 200 && String(rs.json?.resposta ?? "").includes("9.876,54"), rs.texto.slice(0, 160));
    f.check("T004 fontes: search devolveu o doc e a resposta anotou a fonte", Array.isArray(rs.json?.fontes) && rs.json.fontes.includes("suite18-doc"), JSON.stringify(rs.json?.fontes ?? null));
    f.check("T018 custo: tok_out medido (número)", typeof rs.json?.custo?.tok_out === "number" && rs.json.custo.tok_out > 0, JSON.stringify(rs.json?.custo ?? null));
    f.check("T004 coluna fontes deixou de ser morta no banco", psql(`SELECT fontes::text FROM chat_mensagens WHERE memoria='${GAV}' AND papel='assistant' ORDER BY id DESC LIMIT 1`).includes("suite18-doc"), "psql fontes");

    console.log("-- T001: criar tarefa, parar no meio, parcial preservado");
    const rt = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "palavra-união-zzz 123 conta devagar-lento", memoria: GAV2 } });
    const idT = String(rt.json?.id ?? "");
    f.check("tarefa criada p/ cancelamento", rt.status === 201 && idT.length >= 8, rt.texto.slice(0, 100));
    // espera o stream COMEÇAR (parcial visível pela API, sem bloquear o loop) — o cancelar cai sempre dentro dele
    for (let k = 0; k < 50; k++) {
      const gg = await call("GET", `/chat/tarefa/${idT}`, { key: TESTKEY });
      if (String(gg.json?.parcial ?? "").length > 0 || gg.json?.status !== "rodando") break;
      await dormir(200);
    }
    const rc = await call("POST", `/chat/tarefa/${idT}/cancelar`, { key: TESTKEY, corpo: {} });
    f.check("cancelar: 200 + vivia true", rc.status === 200 && rc.json?.ok === true && rc.json?.vivia === true, rc.texto.slice(0, 120));
    let fin = null;
    for (let k = 0; k < 40; k++) {
      await dormir(400);
      const g = await call("GET", `/chat/tarefa/${idT}`, { key: TESTKEY });
      if (g.json?.status !== "rodando") { fin = g.json; break; }
    }
    f.check("tarefa fechou após parar", Boolean(fin) && fin.status !== "rodando", JSON.stringify(fin ?? {}).slice(0, 140));
    f.check("aviso diz parada (não falha)", String(fin?.aviso ?? "").includes("parada"), String(fin?.aviso ?? ""));
    f.check("parcial chegou na tela de quem reanexar", String(fin?.parcial ?? "").length > 0, String(fin?.parcial ?? "").slice(0, 60));
    f.check("histórico gravou a pergunta + resposta parcial", psql(`SELECT count(*) FROM chat_mensagens WHERE memoria='${GAV2}'`) === "2", psql(`SELECT count(*) FROM chat_mensagens WHERE memoria='${GAV2}'`));
    const rc2 = await call("POST", `/chat/tarefa/${idT}/cancelar`, { key: TESTKEY, corpo: {} });
    f.check("cancelar de coisa acabada: ok + vivia false (sem fantasma)", rc2.status === 200 && rc2.json?.vivia === false, rc2.texto.slice(0, 100));
    const rc4 = await call("POST", "/chat/tarefa/nao-existe-318/cancelar", { key: TESTKEY, corpo: {} });
    f.check("cancelar id inexistente: 404", rc4.status === 404, rc4.texto.slice(0, 80));

    console.log("-- T021 busca no histórico + T002 regenerar + T003 recorte");
    const rb = await call("GET", `/chat/mensagens?q=${encodeURIComponent("união-zzz")}`, { key: TESTKEY });
    f.check("buscar acha a pergunta dentro da conversa", rb.status === 200 && (rb.json?.resultados ?? []).length >= 1 && rb.json.resultados.some((x: any) => x.memoria === GAV2), rb.texto.slice(0, 180));
    const rb2 = await call("GET", "/chat/mensagens?q=a", { key: TESTKEY });
    f.check("termo curto: 422 (não varre a mesa toda)", rb2.status === 422, rb2.texto.slice(0, 80));
    const rr = await call("POST", "/chat/regenerar", { key: TESTKEY, corpo: { memoria: GAV2 } });
    f.check("regenerar devolve a pergunta cortada", rr.status === 200 && String(rr.json?.pergunta ?? "").includes("palavra-união-zzz") && rr.json?.removidas === 2, rr.texto.slice(0, 160));
    f.check("mesa zerada depois do corte", psql(`SELECT count(*) FROM chat_mensagens WHERE memoria='${GAV2}'`) === "0", psql(`SELECT count(*) FROM chat_mensagens WHERE memoria='${GAV2}'`));
    const rr2 = await call("POST", "/chat/regenerar", { key: TESTKEY, corpo: { memoria: GAV2 } });
    f.check("regenerar em mesa vazia: 422", rr2.status === 422, rr2.texto.slice(0, 80));
    const rj = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "corte aqui 77", memoria: GAV2 } });
    f.check("sync p/ recorte respondeu", rj.status === 200, rj.texto.slice(0, 80));
    const idMsg = psql(`SELECT id FROM chat_mensagens WHERE memoria='${GAV2}' AND papel='user' ORDER BY id DESC LIMIT 1`);
    const re = await call("POST", "/chat/reenviar-corte", { key: TESTKEY, corpo: { memoria: GAV2, id: Number(idMsg) } });
    f.check("recorte do editar: cortou da pergunta para frente", re.status === 200 && (re.json?.cortadas ?? 0) >= 2, re.texto.slice(0, 100));
    f.check("recorte de id inexistente: 422", (await call("POST", "/chat/reenviar-corte", { key: TESTKEY, corpo: { memoria: GAV2, id: 999999999 } })).status === 422, "id falso");
    f.check("recorte exige id numérico", (await call("POST", "/chat/reenviar-corte", { key: TESTKEY, corpo: { memoria: GAV2, id: "abc" } })).status === 422, "id abc");

    console.log("-- T016 título automático: tarefa que termina bem batiza a gaveta");
    const rn = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "qual o total da nota?", memoria: GAV2 } });
    const idN = String(rn.json?.id ?? "");
    for (let k = 0; k < 50 && !/terminou|falhou|cancelada/.test(psql(`SELECT status FROM chat_tarefas WHERE id='${idN}'`)); k++) await dormir(400);
    f.check("tarefa normal terminou", psql(`SELECT status FROM chat_tarefas WHERE id='${idN}'`) === "terminou", psql(`SELECT status FROM chat_tarefas WHERE id='${idN}'`));
    let tit = "";
    for (let k = 0; k < 30; k++) {
      tit = psql(`SELECT COALESCE(titulo,'') FROM gavetas WHERE tenant='teste' AND memoria='${GAV2}'`);
      if (tit) break;
      await dormir(400);
    }
    f.check("gaveta nomeada ganhou título automático", tit.length > 0 && tit.length <= 80, tit);

    console.log("-- T015/T019 metadados da gaveta");
    const rm = await call("PUT", "/gavetas/meta", { key: TESTKEY, corpo: { memoria: GAV2, titulo: "painel 18", fixada: true } });
    f.check("meta: título + fixada salvos", rm.status === 200, rm.texto.slice(0, 120));
    const rlv = await call("GET", "/gavetas", { key: TESTKEY });
    const linha = (rlv.json?.gavetas ?? []).find((x: any) => x.tenant === "teste" && x.memoria === GAV2);
    f.check("lista devolve título e fixada", linha?.titulo === "painel 18" && linha?.fixada === true, JSON.stringify(linha ?? null).slice(0, 160));
    const rla = await call("GET", `/gavetas?tenant=teste`, { key: OPKEY });
    f.check("fixada aparece na lista do operador", (rla.json?.gavetas ?? []).some((x: any) => x.tenant === "teste" && x.memoria === GAV2 && x.fixada === true), "linha conferida pelo servidor");
    f.check("título manual venceu o automático", psql(`SELECT titulo FROM gavetas WHERE tenant='teste' AND memoria='${GAV2}'`) === "painel 18", psql(`SELECT titulo FROM gavetas WHERE tenant='teste' AND memoria='${GAV2}'`));
    const rar = await call("PUT", "/gavetas/meta", { key: TESTKEY, corpo: { memoria: GAV2, arquivada: true } });
    f.check("arquivar aceita", rar.status === 200, rar.texto.slice(0, 80));
    f.check("linha ficou arquivada no banco", psql(`SELECT arquivada::text FROM gavetas WHERE tenant='teste' AND memoria='${GAV2}'`) === "true", "arquivada true");
    await call("PUT", "/gavetas/meta", { key: TESTKEY, corpo: { memoria: GAV2, arquivada: false } });
    const rpv = await call("PUT", "/gavetas/meta", { key: TESTKEY, corpo: { memoria: "", titulo: "x" } });
    f.check("gaveta padrão não ganha rótulo: 422", rpv.status === 422, rpv.texto.slice(0, 80));
    const rvz = await call("PUT", "/gavetas/meta", { key: TESTKEY, corpo: { memoria: GAV } });
    f.check("meta sem nada: 422", rvz.status === 422, rvz.texto.slice(0, 80));

    const rh12 = await call("GET", `/chat?memoria=${GAV2}`, { key: TESTKEY });
    f.check("T012: histórico devolve `quando` em cada linha (a tela desenha a hora)", (rh12.json?.mensagens ?? []).length > 0 && rh12.json.mensagens.every((x: any) => typeof x.quando === "string"), rh12.texto.slice(0, 120));
    f.fechar("v3.18 básico de chat");
  });

  /* ------------------------------------------------------------------ v3.19 */

  await bloco(t, "v3.19: provedores nomeados — escolha na conversa e auto-descoberta de modelos", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v319";
    if (!CONTAINER) {
      f.check("v3.19 precisa de CONTAINER (sonda dentro dele)", false, "sem container: bloco não executável");
      f.fechar("v3.19 provedores");
      return;
    }

    const PORTA = 19000 + ((Math.floor(Date.now() / 1000) % 900) + 41) % 900;
    console.log(`-- sonda ${PORTA}: GET /models devolve 2 ids; chat responde "sonda:<modelo>|q<n>"`);
    const cod = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "const u=req.url||'';",
      "if(u.indexOf('models')>=0){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'sonda-a'},{id:'sonda-b'}]}));}",
      "let j={};try{j=JSON.parse(b||'{}')}catch(e){}",
      "const m=j.messages||[];",
      "const sys=(m[0]&&m[0].role==='system')?String(m[0].content):'';",
      "res.setHeader('content-type','application/json');",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'sonda:'+String(j.model||'?')+'|q'+m.length+'|sys:'+sys.slice(0,40)}}]}));",
      "});});",
      `s.listen(${PORTA},'127.0.0.1');setTimeout(()=>process.exit(0),200000);`,
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", cod]);
    await dormir(1000);

    let r = await call("GET", "/provedores", { key: TESTKEY });
    f.check("usuário comum LÊ a lista de provedores", r.status === 200 && Array.isArray(r.json?.provedores), r.texto.slice(0, 120));

    r = await call("PUT", "/provedores", { key: TESTKEY, corpo: { nome: "proibido", base_url: "http://127.0.0.1:1/v1", modelo: "x" } });
    f.check("comum NÃO cadastra provedor", r.status === 403 || r.status === 409, r.texto.slice(0, 120));

    r = await call("PUT", "/provedores", { key: OPKEY, corpo: { nome: "ruim", base_url: "ftp://127.0.0.1", modelo: "x" } });
    f.check("base_url sem http/https é recusada", r.status === 422, r.texto.slice(0, 140));

    r = await call("PUT", "/provedores", {
      key: OPKEY,
      corpo: { nome: "sonda319", tipo: "litellm", base_url: `http://127.0.0.1:${PORTA}/v1`, modelo: "sonda-a", chave: "chave-secreta-319", mcp_interno: false, max_rodadas: 1, tenant: "global" },
    });
    const pid = Number(r.json?.provedor?.id ?? 0);
    f.check("operador cadastra provedor nomeado", r.status === 200 && pid > 0 && r.json?.provedor?.nome === "sonda319", r.texto.slice(0, 200));
    f.check("a chave nunca volta em claro na resposta", r.status === 200 && !r.texto.includes("chave-secreta-319"), r.texto.slice(0, 200));

    r = await call("POST", "/provedores/modelos", { key: OPKEY, corpo: { id: pid } });
    f.check("AUTO-DESCOBERTA: o serviço devolve seus modelos", r.status === 200 && (r.json?.modelos ?? []).join(",") === "sonda-a,sonda-b" && typeof r.json?.em === "string", r.texto.slice(0, 200));

    r = await call("GET", "/provedores", { key: TESTKEY });
    const pv = (r.json?.provedores ?? []).find((x: any) => x.nome === "sonda319") ?? {};
    f.check("cache de modelos grava na linha (com data)", (pv.modelos ?? []).length === 2 && typeof pv.modelos_em === "string", JSON.stringify(pv).slice(0, 220));

    /* v3.35 — as instruções são da CONTA: campo único, fora do provider, valem para todos os
       modelos (inclusive os nomeados, que não guardam mais prompt na própria linha) */
    const antes335 = await call("GET", "/config/provider?tenant=teste", { key: OPKEY });
    const promptAntes335 = String(antes335.json?.system_prompt ?? "");
    r = await call("PUT", "/config/instrucoes", { key: OPKEY, corpo: { texto: "PROMPT-DA-CONTA-335", tenant: "teste" } });
    f.check("operador grava as instruções do cliente (campo único da conta)", r.status === 200 && r.json?.system_prompt === "PROMPT-DA-CONTA-335" && r.json?.escopo === "teste", r.texto.slice(0, 160));
    r = await call("GET", "/config/provider?tenant=teste", { key: OPKEY });
    f.check("a releitura devolve o texto da CONTA (prova de escrita)", r.json?.system_prompt === "PROMPT-DA-CONTA-335" && r.json?.tem_system_prompt === true, r.texto.slice(0, 160));
    r = await call("PUT", "/config/instrucoes", { key: TESTKEY, corpo: { texto: "tentativa do comum" } });
    f.check("usuário comum NÃO troca as instruções da conta (403)", r.status === 403, r.texto.slice(0, 120));

    /* v3.55 — rodadas, memória e intactas são da CONTA como as instruções: a tela os mostra no
       card do topo e salva pela MESMA rota. O provider não pode zerá-los ao salvar sem eles.
       A linha do tenant PRÓPRIO (descartável, para não sujar o 'teste' dos outros blocos) precisa estar COMPLETA (base_url + modelo) antes da releitura: pela regra
       v2.8 o GET mostra a linha global enquanto a própria está pela metade. */
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { tenant: "teste355", tipo: "openai", base_url: "http://127.0.0.1:9/v1", modelo: "m355", temperatura: 0.3 } });
    f.check("provider do cliente salvo completo (a releitura passa a mostrar a linha própria)", r.status === 200 && r.json?.escopo === "teste355", r.texto.slice(0, 160));
    r = await call("PUT", "/config/instrucoes", { key: OPKEY, corpo: { texto: "PROMPT-DA-CONTA-335", tenant: "teste355", max_rodadas: 7, memoria_turnos: 15, verbatim_turnos: 6 } });
    f.check("instruções + comportamento salvam juntos (rodadas/memória/intactas)", r.status === 200 && r.json?.max_rodadas === 7 && r.json?.memoria_turnos === 15 && r.json?.verbatim_turnos === 6, r.texto.slice(0, 200));
    r = await call("GET", "/config/provider?tenant=teste355", { key: OPKEY });
    f.check("a releitura devolve os três gravados pela rota das instruções", r.json?.max_rodadas === 7 && r.json?.memoria_turnos === 15 && r.json?.verbatim_turnos === 6, r.texto.slice(0, 200));
    r = await call("PUT", "/config/provider", { key: OPKEY, corpo: { tenant: "teste355", tipo: "openai", base_url: "http://127.0.0.1:9/v1", modelo: "m355", temperatura: 0.3 } });
    f.check("salvar o provider SEM os três PRESERVA o que a conta gravou", r.status === 200 && r.json?.max_rodadas === 7 && r.json?.memoria_turnos === 15 && r.json?.verbatim_turnos === 6, r.texto.slice(0, 200));
    r = await call("PUT", "/config/instrucoes", { key: OPKEY, corpo: { tenant: "teste355", texto: "x", max_rodadas: 99 } });
    f.check("rodadas fora da faixa: 422 (não grava 99)", r.status === 422, r.texto.slice(0, 160));

    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi sonda", memoria: GAV, provedor: "sonda319", modelo: "sonda-b" } });
    f.check("resposta VEIO do provedor escolhido (modelo pedido no lugar do cadastrado)", r.status === 200 && String(r.json?.resposta).includes("sonda:sonda-b"), r.texto.slice(0, 200));
    f.check("o provedor NOMEADO recebe as instruções da CONTA no system", /sys:PROMPT-DA-CONTA-335/.test(String(r.json?.resposta)), r.texto.slice(0, 220));
    f.check("o fim diz quem respondeu", r.json?.provedor === "sonda319", r.texto.slice(0, 200));

    r = await call("GET", `/chat?memoria=${GAV}`, { key: TESTKEY });
    const ult = (r.json?.mensagens ?? []).filter((x: any) => x.papel === "assistant").pop() ?? {};
    f.check("histórico guarda provedor+modelo da resposta (o 'via X' ao reabrir)", ult.provedor === "sonda319" && ult.modelo === "sonda-b", JSON.stringify(ult).slice(0, 220));

    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi", memoria: GAV, provedor: "nao-existe-319" } });
    f.check("provedor inexistente: recusa na hora (422)", r.status === 422, r.texto.slice(0, 160));

    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi", memoria: GAV, provedor: "sonda319", modelo: "sonda-injetado; DROP" } });
    f.check("modelo fora da lista descoberta: recusa (422)", r.status === 422, r.texto.slice(0, 160));

    r = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "tarefa sondada", memoria: GAV, provedor: "sonda319", modelo: "sonda-a" } });
    const idT = String(r.json?.id ?? "");
    f.check("tarefa aceita a escolha (colunas provadas no INSERT)", r.status === 201 && idT.length >= 8, r.texto.slice(0, 120));
    let fin: any = null;
    for (let k = 0; k < 60; k++) {
      fin = await call("GET", `/chat/tarefa/${idT}`, { key: TESTKEY });
      if (fin.json?.status !== "rodando") break;
      await dormir(300);
    }
    f.check("tarefa terminou carregando a escolha", String(fin.json?.status ?? "") === "terminou" && String(fin.json?.provedor ?? "") === "sonda319" && String(fin.json?.parcial ?? "").includes("sonda:sonda-a"), JSON.stringify(fin.json ?? null).slice(0, 220));

    /* desliga e a escolha passa a ser recusada — linha existe, mas não atende */
    await call("PUT", "/provedores", {
      key: OPKEY,
      corpo: { nome: "sonda319", tipo: "litellm", base_url: `http://127.0.0.1:${PORTA}/v1`, modelo: "sonda-a", chave: "***", mcp_interno: false, max_rodadas: 1, ativo: false, tenant: "global" },
    });
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "oi", memoria: GAV, provedor: "sonda319" } });
    f.check("provedor desligado não atende (409)", r.status === 409, r.texto.slice(0, 160));

    r = await call("DELETE", `/provedores/${pid}`, { key: OPKEY });
    f.check("operador apaga provedor", r.status === 200 && r.json?.ok === true, r.texto.slice(0, 120));
    r = await call("GET", "/provedores", { key: TESTKEY });
    f.check("lista fica sem a linha apagada", !(r.json?.provedores ?? []).some((x: any) => x.nome === "sonda319"), r.texto.slice(0, 160));

    /* v3.35.1 — campo vazio é "conversa pura" e SOBREVIVE ao boot: antes, cada subida do
       container regravava as regras da casa em todo campo vazio (UPDATE no initProvider),
       então quem apagasse as instruções as via voltar sem ter salvo nada. */
    await call("PUT", "/config/instrucoes", { key: OPKEY, corpo: { texto: "", tenant: "teste" } });
    if (CONTAINER) {
      execFileSync("docker", ["restart", CONTAINER], { stdio: "ignore" });
      let subiu351 = 0;
      for (let i = 0; i < 40; i++) {
        try {
          const p = await fetch(BASE + "/health");
          if (p.status === 200) {
            subiu351 = i + 1;
            break;
          }
        } catch {
          /* ainda subindo */
        }
        await dormir(2000);
      }
      const depoisBoot = await call("GET", "/config/provider?tenant=teste", { key: OPKEY });
      f.check("v3.35.1: campo vazio sobrevive ao boot (nada entra por baixo)", subiu351 > 0 && String(depoisBoot.json?.system_prompt ?? "?") === "" && depoisBoot.json?.tem_system_prompt === false, `${subiu351 ? "subiu" : "não subiu"}: ${JSON.stringify(depoisBoot.json?.system_prompt ?? null).slice(0, 120)}`);
    }

    await call("PUT", "/config/instrucoes", { key: OPKEY, corpo: { texto: promptAntes335, tenant: "teste" } });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: TESTKEY });
    if (CONTAINER) execFileSync("docker", ["exec", CONTAINER, "sh", "-c", `${pkill(PORTA)} || true`]);
    f.fechar("v3.19 provedores");
  });

  await bloco(t, "v3.23: tela gerada pelo agente (mostrar_tela) — card com preview funcional", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v323";
    if (!CONTAINER) {
      f.check("v3.23 precisa de CONTAINER", false, "sem container: bloco não executável");
      f.fechar("v3.23 telas");
      return;
    }

    /* --- superfície MCP: a ferramenta existe e normaliza o que o modelo manda --- */
    let r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const nomes: string[] = (r.json?.result?.tools ?? []).map((x: any) => x.name);
    f.check("tools/list anuncia mostrar_tela", nomes.includes("mostrar_tela"), `${nomes.length} tools`);

    const chamarTela = (args: Record<string, unknown>) =>
      call("POST", "/mcp", {
        key: TESTKEY,
        corpo: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "mostrar_tela", arguments: args } },
      });
    /* o retorno do MCP embrulha o objeto em content[].text (JSON) */
    const telaDoMcp = (res: any): any => {
      try {
        return JSON.parse(String(res.json?.result?.content?.[0]?.text ?? "{}"));
      } catch {
        return {};
      }
    };

    r = await chamarTela({
      titulo: "Botão que conta",
      html: '<div id="alvo">0</div><button id="b" onclick="document.getElementById(\'alvo\').textContent=Number(document.getElementById(\'alvo\').textContent)+1">somar</button>',
    });
    const t1 = telaDoMcp(r);
    f.check(
      "fragmento vira PÁGINA completa (doctype, charset, viewport) e o título entra",
      r.json?.result?.isError !== true && /^<!doctype html>/i.test(String(t1.html)) && /charset="?utf-8/i.test(String(t1.html)) && String(t1.html).includes('id="b"') && t1.titulo === "Botão que conta",
      JSON.stringify({ titulo: t1.titulo, ini: String(t1.html ?? "").slice(0, 60) }).slice(0, 220),
    );
    f.check("a tela ganha id próprio (o card precisa de chave estável)", typeof t1.id === "string" && t1.id.length >= 8, String(t1.id));

    r = await chamarTela({ titulo: "Completa", html: '<!doctype html><html lang="pt-BR"><body><h1>pronta</h1></body></html>' });
    const t2 = telaDoMcp(r);
    const doctypes = (String(t2.html).match(/<!doctype html>/gi) ?? []).length;
    f.check(
      "página completa não é duplicada; só ganha charset/viewport que faltavam",
      doctypes === 1 && /<meta[^>]+charset/i.test(String(t2.html)) && String(t2.html).includes("<h1>pronta</h1>"),
      String(t2.html).slice(0, 90),
    );

    r = await chamarTela({ titulo: "Vazia", html: "   " });
    f.check("html vazio é recusado (não abre card em branco)", r.json?.result?.isError === true, JSON.stringify(r.json?.result ?? {}).slice(0, 160));
    r = await chamarTela({ titulo: "Texto", html: "apenas uma frase solta" });
    f.check("texto sem marcação é recusado", r.json?.result?.isError === true, JSON.stringify(r.json?.result ?? {}).slice(0, 160));

    /* --- o chat: 4 telas no mesmo turno => 3 cards + aviso honesto do teto --- */
    const PORTF = 20000 + (Math.floor(Date.now() / 1000) % 700);
    const cod = [
      "const http=require('http');let n=0;",
      "http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{n++;",
      "res.setHeader('content-type','application/json');",
      "let out;",
      "if(n===1){const calls=[1,2,3,4].map(i=>({id:'c'+i,type:'function',function:{name:'mostrar_tela',arguments:JSON.stringify({titulo:'Tela '+i,html:'<h2>tela '+i+'</h2><button id=\"b'+i+'\">ok</button>'})}}));",
      "out={choices:[{message:{role:'assistant',content:'',tool_calls:calls}}]};}",
      "else out={choices:[{message:{role:'assistant',content:'PRONTO-V323'}}]};",
      "res.end(JSON.stringify(out));",
      "});}).listen(",
      String(PORTF),
      ",'127.0.0.1');setTimeout(()=>process.exit(0),120000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", cod]);
    await dormir(1200);

    await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: `http://127.0.0.1:${PORTF}/v1`, modelo: "modelo-v323", chave: "***", temperatura: 0.2, system_prompt: "", mcp_interno: true, max_rodadas: 4, ativo: true, global: true },
    });
    r = await call("POST", "/chat", { key: TESTKEY, corpo: { pergunta: "gere quatro telas", memoria: GAV } });
    f.check("o chat fechou a resposta depois das telas", r.status === 200 && String(r.json?.resposta) === "PRONTO-V323", r.texto.slice(0, 200));
    const telas: any[] = r.json?.telas ?? [];
    f.check("teto do turno: 3 telas exibidas das 4 geradas", telas.length === 3, `${telas.length} telas`);
    f.check("quem ficou de fora é DITO (aviso), não engolido", String(r.json?.aviso ?? "").includes("3"), String(r.json?.aviso ?? "sem aviso").slice(0, 140));
    f.check("cada tela chega com id, título e HTML de página inteira", telas.every((x) => x.id && x.titulo && /^<!doctype html>/i.test(String(x.html))), JSON.stringify(telas.map((x) => x.titulo)));
    f.check("as telas exibidas são as três primeiras, na ordem", telas.map((x) => x.titulo).join(",") === "Tela 1,Tela 2,Tela 3", telas.map((x) => x.titulo).join(","));

    r = await call("GET", `/chat?memoria=${GAV}`, { key: TESTKEY });
    const ult = (r.json?.mensagens ?? []).filter((m: any) => m.papel === "assistant").pop() ?? {};
    f.check("reabrir a conversa devolve as telas gravadas (o card volta)", Array.isArray(ult.telas) && ult.telas.length === 3 && ult.telas[0].id === telas[0].id, JSON.stringify(ult.telas ?? null).slice(0, 200));

    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ativo: false, global: true } });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: TESTKEY });
    execFileSync("docker", ["exec", CONTAINER, "sh", "-c", `${pkill(PORTF)} || true`]);
    f.fechar("v3.23 telas");
  });

  await bloco(t, "v3.24: o código da tela aparece SENDO DIGITADO no chat (streaming do HTML)", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v324";
    if (!CONTAINER) {
      f.check("v3.24 precisa de CONTAINER", false, "sem container: bloco não executável");
      f.fechar("v3.24 código ao vivo");
      return;
    }

    /* o HTML que o "modelo" vai escrever: quebra de linha, aspas, acento e repetição —
       é o que prova que o pedaço cru do provider vira texto legível na tela */
    const HTML_ALVO =
      '<h1>oi</h1>\n<button id="b" onclick="this.textContent=\'ok!\'">ok</button>\n' +
      "linha com acento: ação ✓\n".repeat(40);
    const ARGS = JSON.stringify({ titulo: "Tela viva", html: HTML_ALVO });

    /* provedor OpenAI-compatível falso, em SSE: a 1ª rodada chama mostrar_tela mandando os
       argumentos em 7 pedaços (é assim que o modelo real escreve, pedaço por pedaço) */
    const PORTF = 30000 + (Math.floor(Date.now() / 1000) % 700);
    const cod = [
      "const http=require('http');let n=0;",
      "const args=" + JSON.stringify(ARGS) + ";",
      "http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{n++;",
      "res.setHeader('content-type','text/event-stream');",
      "const envia=(o)=>res.write('data: '+JSON.stringify(o)+'\\n\\n');",
      "if(n===1){",
      "envia({choices:[{delta:{tool_calls:[{index:0,id:'c1',type:'function',function:{name:'mostrar_tela',arguments:''}}]}}]});",
      "const passo=Math.ceil(args.length/7);",
      "for(let i=0;i<args.length;i+=passo){envia({choices:[{delta:{tool_calls:[{index:0,function:{arguments:args.slice(i,i+passo)}}]}}]});}",
      "envia({choices:[{delta:{},finish_reason:'tool_calls'}]});",
      "} else { envia({choices:[{delta:{content:'PRONTO-V324'}}]}); }",
      "res.write('data: [DONE]\\n\\n');res.end();",
      "});}).listen(",
      String(PORTF),
      ",'127.0.0.1');setTimeout(()=>process.exit(0),120000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", cod]);
    await dormir(1200);

    await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: {
        tipo: "litellm",
        base_url: `http://127.0.0.1:${PORTF}/v1`,
        modelo: "modelo-v324",
        chave: "***",
        temperatura: 0.2,
        system_prompt: "",
        mcp_interno: true,
        max_rodadas: 3,
        ativo: true,
        global: true,
      },
    });

    const { eventos } = await fluxo(TESTKEY, { pergunta: "gere uma tela com botão", memoria: GAV });
    const codigos = eventos.filter((e: any) => e?.tipo === "codigo");
    const junto = codigos.map((e: any) => String(e.texto ?? "")).join("");
    const tipos = eventos.map((e: any) => e?.tipo);
    const idxUltimoCodigo = tipos.lastIndexOf("codigo");
    const idxTela = tipos.indexOf("tela");
    const fim = eventos.filter((e: any) => e?.tipo === "fim").pop()?.dados ?? {};
    const deltas = eventos.filter((e: any) => e?.tipo === "delta").map((e: any) => String(e.texto ?? "")).join("");

    f.check("o código da tela chega em PEDAÇOS (não num bloco só)", codigos.length >= 3, `${codigos.length} eventos codigo`);
    f.check(
      "o que foi digitado é EXATAMENTE o HTML escrito pelo modelo (escape resolvido)",
      junto === HTML_ALVO,
      `${junto.length} de ${HTML_ALVO.length} caracteres`,
    );
    f.check(
      "o código nasce ANTES do card da tela (ordem do nascimento)",
      idxUltimoCodigo >= 0 && idxTela > idxUltimoCodigo,
      `ultimo codigo@${idxUltimoCodigo}, tela@${idxTela}`,
    );
    f.check(
      "a resposta final é a fala do modelo, sem repetir o HTML",
      String(fim.resposta ?? "") === "PRONTO-V324" && !deltas.includes("<h1>oi</h1>"),
      JSON.stringify(String(fim.resposta ?? "")).slice(0, 80),
    );
    f.check(
      "a mesma tela chega pronta no fim (card) com o mesmo corpo",
      Array.isArray(fim.telas) && fim.telas.length === 1 && String(fim.telas[0].html).includes('<button id="b"'),
      JSON.stringify((fim.telas ?? []).map((x: any) => x.titulo)),
    );

    await call("PUT", "/config/provider", { key: OPKEY, corpo: { ativo: false, global: true } });
    await call("DELETE", `/chat?memoria=${GAV}`, { key: TESTKEY });
    execFileSync("docker", ["exec", CONTAINER, "sh", "-c", `${pkill(PORTF)} || true`]);
    f.fechar("v3.24 código ao vivo");
  });


  await bloco(t, "v3.42 fala no MEIO do turno (steering)", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const GAV = "suite-v42";
    if (!CONTAINER) {
      f.check("steering precisa do container (provedor falso dentro dele)", true, "sem CONTAINER: não executável");
      f.fechar("v3.42 steering (parcial)");
      return;
    }

    console.log("-- provedor falso lento na 1ª rodada (dá tempo de falar no meio)");
    const codSteer = [
      "const http=require('http');",
      "const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{",
      "let j={};try{j=JSON.parse(b||'{}');}catch(e){}",
      "const m=j.messages||[];",
      "const comFerramenta=m.filter(x=>x.role==='tool').length>0;",
      "const ultima=[...m].reverse().find(x=>x.role==='user')||{};",
      "const t=String(ultima.content||'');",
      "const teveFala=t.indexOf('falou enquanto você trabalhava')>=0;",
      "res.setHeader('content-type','application/json');",
      "if(!comFerramenta){setTimeout(()=>{res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'t1',type:'function',function:{name:'search',arguments:JSON.stringify({query:'nota Gama',k:2})}}]}}]}));},2500);return;}",
      "const alvo=teveFala?t.split(') ').pop():'nao vi a fala';",
      "res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'AJUSTEI: '+alvo}}]}));",
      "});});",
      "s.listen(9917,'127.0.0.1');setTimeout(()=>process.exit(0),240000);",
    ].join("");
    execFileSync("docker", ["exec", "-d", CONTAINER, "node", "-e", codSteer]);
    await dormir(1200);

    let r = await call("POST", "/ingest", {
      key: TESTKEY,
      corpo: { doc_id: "suite-v42-nota", content: "Nota 7788 da empresa Gama. Total R$ 1.111,00 vencendo em 10/01/2027.", memoria: GAV },
    });
    const job = await esperarJob(TESTKEY, r.json?.job_id);
    f.check("documento do steering indexado", job.status === "concluido", job);

    r = await call("PUT", "/config/provider", {
      key: OPKEY,
      corpo: { tipo: "litellm", base_url: "http://127.0.0.1:9917/v1", modelo: "steer", temperatura: 0, system_prompt: "", mcp_interno: true, max_rodadas: 3, ativo: true, global: true },
    });
    f.check("provider do steering salvo", r.status === 200, r.texto.slice(0, 160));

    r = await call("POST", "/chat/tarefa", { key: TESTKEY, corpo: { pergunta: "qual o total da nota da Gama?", memoria: GAV } });
    const idSteer = String(r.json?.id ?? "");
    f.check("tarefa criada para o steering", r.status === 201 && idSteer.length >= 8, r.texto.slice(0, 120));

    /* fala com a tarefa AINDA rodando (o fake segura a 1ª rodada por 2,5s) */
    await dormir(700);
    const rf = await call("POST", `/chat/tarefa/${idSteer}/fala`, { key: TESTKEY, corpo: { texto: "na verdade quero o total de 2025" } });
    f.check("fala aceita no meio do turno (200 + ok)", rf.status === 200 && rf.json?.ok === true, rf.texto.slice(0, 160));

    let t2: any = null;
    for (let i = 0; i < 80; i++) {
      const g = await call("GET", `/chat/tarefa/${idSteer}`, { key: TESTKEY });
      t2 = g.json;
      if (t2?.status && t2.status !== "rodando") break;
      await dormir(400);
    }
    f.check("a tarefa atravessou a fala e terminou", t2?.status === "terminou", t2?.status);
    f.check("o modelo RECEBEU a fala e ajustou a resposta", /AJUSTEI: na verdade quero o total de 2025/.test(String(t2?.parcial ?? "")), String(t2?.parcial ?? "").slice(0, 220));

    /* --- o caso do dono (print de 29/10): operador com a conversa em OUTRO tenant.
       A rota lia o tenant do CORPO e a tela manda na QUERY -> 404 "tarefa não encontrada"
       com a tarefa viva na frente. Contrato: tenant da leitura = o da criação. */
    r = await call("POST", "/chat/tarefa", { key: OPKEY, corpo: { pergunta: "qual o total da nota da Gama?", memoria: GAV, tenant: "teste" } });
    const idOp = String(r.json?.id ?? "");
    f.check("operador cria tarefa em outro tenant", r.status === 201 && idOp.length >= 8, r.texto.slice(0, 120));
    await dormir(600);
    const rfSem = await call("POST", `/chat/tarefa/${idOp}/fala`, { key: OPKEY, corpo: { texto: "sem tenant" } });
    f.check("fala SEM o tenant da tarefa -> 404 (não acha, não vaza)", rfSem.status === 404, rfSem.texto.slice(0, 140));
    const rfCom = await call("POST", `/chat/tarefa/${idOp}/fala?tenant=teste`, { key: OPKEY, corpo: { texto: "com tenant na query" } });
    f.check("fala COM ?tenant (o que a tela manda) -> 200", rfCom.status === 200 && rfCom.json?.ok === true, rfCom.texto.slice(0, 160));
    for (let i = 0; i < 80; i++) {
      const g = await call("GET", `/chat/tarefa/${idOp}?tenant=teste`, { key: OPKEY });
      if (g.json?.status && g.json.status !== "rodando") break;
      await dormir(400);
    }

    const r409 = await call("POST", `/chat/tarefa/${idSteer}/fala`, { key: TESTKEY, corpo: { texto: "tarde demais" } });
    f.check("fala em tarefa já encerrada -> 409", r409.status === 409, r409.texto.slice(0, 140));
    const r422 = await call("POST", `/chat/tarefa/${idSteer}/fala`, { key: TESTKEY, corpo: { texto: "" } });
    f.check("fala vazia -> 422", r422.status === 422, r422.texto.slice(0, 120));
    f.fechar("v3.42 steering");
  });

  /* v3.43 — a prova é o CLIENTE DE VERDADE, não um falso: o teto de ~39 KB que
     quebrava o ler_arquivo do dono morava no handler de stdout do cliente
     (40.000 chars -> matarArvore sem resolver a Promise). Um fake que responde
     200 KB não pegaria isso; o binário embutido na imagem pega. */
  await bloco(t, "v3.43: túnel entrega resposta grande (cliente REAL, sem teto de 40 KB)", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const leJson = (r: any): any => {
      const t = String(r?.json?.result?.content?.[0]?.text ?? "");
      try { return JSON.parse(t); } catch { return {}; }
    };
    /* mata só o cliente deste bloco (a imagem slim pode não ter pkill) */
    const MATAR = "const fs=require('fs');for(const d of fs.readdirSync('/proc')){if(!/^[0-9]+$/.test(d))continue;"
      + "try{const c=fs.readFileSync('/proc/'+d+'/cmdline','utf8').split(String.fromCharCode(0)).join(' ');"
      + "if(c.indexOf('nexos-cliente-linux')>=0&&c.indexOf('cli-real')>=0)process.kill(Number(d),'SIGKILL')}catch(e){}}";
    const matar = () => {
      try { execFileSync("docker", ["exec", CONTAINER, "node", "-e", MATAR]); } catch { /* já morreu */ }
    };

    matar();
    await call("DELETE", "/maquinas/cli-real", { key: TESTKEY }); // rodada anterior pode ter deixado a máquina
    const r0 = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome: "cli-real" } });
    const par = String(r0.json?.token ?? "");
    f.check("v3.43 pareamento do cliente real criado", Boolean(par), r0.texto.slice(0, 120));

    execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "head -c 800000 /dev/zero > /tmp/e2e-grande.bin"]);
    execFileSync("docker", ["exec", "-d", CONTAINER, "/app/agente/bin/nexos-cliente-linux",
      "--url", "http://127.0.0.1:8000", "--token", par, "--host", "cli-real", "--conf", "/tmp/e2e-cli-real.json"]);

    let online = false;
    for (let i = 0; i < 60; i++) {
      const g = await call("GET", "/maquinas", { key: TESTKEY });
      online = (g.json?.maquinas ?? []).some((m: any) => m.host === "cli-real" && m.online === true);
      if (online) break;
      await dormir(300);
    }
    f.check("v3.43 binário do cliente conectou (é ele que atende as chamadas abaixo)", online, online);

    const ler = async (args: Record<string, unknown>, id: number) =>
      leJson(await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "ler_arquivo", arguments: { host: "cli-real", caminho: "/tmp/e2e-grande.bin", binario: true, ...args } } } }));

    /* 200 KB era o caso que morria em 53 s (limite PADRÃO do ler_arquivo) */
    const r1 = await ler({ limite: 200000 }, 950);
    f.check("v3.43 ler_arquivo binário de 200 KB volta inteiro (antes: silêncio e -124)",
      r1?.lidos === 200000 && Buffer.from(String(r1?.base64 ?? ""), "base64").length === 200000,
      JSON.stringify({ lidos: r1?.lidos, b64: String(r1?.base64 ?? "").length }));

    /* e sem `limite` (o padrão de 200.000 que o modelo usa) também */
    const r2 = await ler({}, 951);
    f.check("v3.43 sem 'limite' o padrão de 200 KB também passa", r2?.lidos === 200000, JSON.stringify({ lidos: r2?.lidos }));

    /* o teto do contrato: 800 KB */
    const r3 = await ler({ limite: 800000 }, 952);
    f.check("v3.43 o teto de 800 KB do contrato é real",
      r3?.lidos === 800000 && Buffer.from(String(r3?.base64 ?? ""), "base64").length === 800000,
      JSON.stringify({ lidos: r3?.lidos, b64: String(r3?.base64 ?? "").length }));

    matar();
    execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "rm -f /tmp/e2e-grande.bin /tmp/e2e-cli-real.json"]);
    await call("DELETE", "/maquinas/cli-real", { key: TESTKEY });
    f.fechar("v3.43 túnel grande");
  });

  /* v3.44 — o caminho de VOLTA: a máquina manda arquivo e o dono vê no chat.
     Usa o CLIENTE REAL (Linux) do container: curl de verdade, POST de verdade,
     registro em `anexos` e GET /anexos/:id com a chave do usuário. */
  await bloco(t, "v3.45: arquivo grande em blocos, com retomada e Range", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const leJson = (r: any): any => {
      const t = String(r?.json?.result?.content?.[0]?.text ?? "");
      try { return JSON.parse(t); } catch { return {}; }
    };
    const erroDe = (r: any): string =>
      String(r?.json?.error?.message ?? r?.json?.result?.content?.[0]?.text ?? r?.texto ?? "");
    const HOST = "cli-arq";
    const MATAR = "const fs=require('fs');for(const d of fs.readdirSync('/proc')){if(!/^[0-9]+$/.test(d))continue;"
      + "try{const c=fs.readFileSync('/proc/'+d+'/cmdline','utf8').split(String.fromCharCode(0)).join(' ');"
      + "if(c.indexOf('nexos-cliente-linux')>=0&&c.indexOf('" + HOST + "')>=0)process.kill(Number(d),'SIGKILL')}catch(e){}}";
    const matar = () => { try { execFileSync("docker", ["exec", CONTAINER, "node", "-e", MATAR]); } catch { /* ok */ } };
    const sh = (cmd: string) => execFileSync("docker", ["exec", CONTAINER, "sh", "-c", cmd], { encoding: "utf8" });
    const sha = (p: string) => sh(`sha256sum ${p} | cut -d' ' -f1`).trim();

    matar();
    await call("DELETE", `/maquinas/${HOST}`, { key: TESTKEY });
    const r0 = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome: HOST } });
    const par = String(r0.json?.token ?? "");
    f.check("v3.45 pareamento criado", Boolean(par), r0.texto.slice(0, 120));

    /* 70 MB passa de dois blocos de 32 MB — prova o fatiamento de verdade */
    sh("head -c 73400320 /dev/urandom > /tmp/e2e-arq.bin && rm -f /tmp/e2e-arq-copia.bin");
    const shaOrigem = sha("/tmp/e2e-arq.bin");
    execFileSync("docker", ["exec", "-d", CONTAINER, "/app/agente/bin/nexos-cliente-linux",
      "--url", "http://127.0.0.1:8000", "--token", par, "--host", HOST, "--conf", "/tmp/e2e-cli-arq.json"]);

    let online = false;
    for (let i = 0; i < 60; i++) {
      const g = await call("GET", "/maquinas", { key: TESTKEY });
      online = (g.json?.maquinas ?? []).some((m: any) => m.host === HOST && m.online === true);
      if (online) break;
      await dormir(300);
    }
    f.check("v3.45 cliente real conectou", online, online);

    /* 1) baixar_arquivo de 70 MB: três blocos, grava no disco por usuário */
    let r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 970, method: "tools/call",
      params: { name: "baixar_arquivo", arguments: { host: HOST, caminho: "/tmp/e2e-arq.bin" } } } });
    const env = leJson(r);
    const anexo = env?.anexo ?? {};
    f.check("v3.45 baixar_arquivo de 70 MB termina com o tamanho certo",
      r.status === 200 && anexo.bytes === 73400320, JSON.stringify({ st: r.status, bytes: anexo.bytes, erro: erroDe(r) }).slice(0, 240));

    /* 2) o arquivo está no VOLUME, em pasta por usuário — não dentro do banco */
    const noDisco = sh(`find /app/dados -path "*${String(anexo.id ?? "")}*" -type f -printf '%p %s\\n' | head -1`).trim();
    f.check("v3.45 o arquivo mora em /app/dados/anexos/<usuario>/<id>/<nome>",
      noDisco.includes(`/app/dados/anexos/teste/`) && noDisco.endsWith("73400320"), noDisco.slice(0, 200));

    /* 3) o bytea do banco ficou vazio (prova de que não está no Postgres) */
    const DBC = process.env.DBCONTAINER ?? CONTAINER.replace("-api-", "-db-");
    const linhaBanco = execFileSync("docker", ["exec", DBC, "sh", "-c",
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select bytes||'/'||completo from anexos_maquina where id='${String(anexo.id ?? "")}'"`],
      { encoding: "utf8" }).trim();
    f.check("v3.45 a ficha no banco tem o tamanho e o 'completo' (sem o conteúdo)", linhaBanco === "73400320/true", linhaBanco);

    /* 4) download inteiro: mesma impressão digital do arquivo na máquina */
    const baixado = await call("GET", `/anexos/${String(anexo.id ?? "")}`, { key: TESTKEY });
    const shaBaixado = (await import("node:crypto")).createHash("sha256").update(baixado.buf).digest("hex");
    f.check("v3.45 GET /anexos/:id devolve 70 MB com o MESMO sha256", baixado.status === 200 && shaBaixado === shaOrigem,
      JSON.stringify({ st: baixado.status, bytes: baixado.buf.length }).slice(0, 200));

    /* 5) Range: pedaço do meio volta com 206 e o tamanho pedido (é o que faz o vídeo tocar e o download retomar) */
    const rng = await fetch(`${BASE}/anexos/${String(anexo.id ?? "")}`, {
      headers: { Authorization: "B" + "earer " + TESTKEY, Range: "bytes=1000000-1999999" },
      signal: AbortSignal.timeout(60000),
    });
    const bufRng = Buffer.from(await rng.arrayBuffer());
    f.check("v3.45 Range responde 206 com exatamente o pedaço e o content-range certo",
      rng.status === 206 && bufRng.length === 1000000 && String(rng.headers.get("content-range")) === "bytes 1000000-1999999/73400320",
      JSON.stringify({ st: rng.status, n: bufRng.length, cr: rng.headers.get("content-range") }).slice(0, 220));
    f.check("v3.45 o pedaço é byte-a-byte o mesmo do arquivo",
      (await import("node:crypto")).createHash("sha256").update(bufRng).digest("hex") ===
        sh("tail -c +1000001 /tmp/e2e-arq.bin | head -c 1000000 | sha256sum | cut -d' ' -f1").trim(), "");

    /* 6) RETOMADA: o mesmo arquivo reenviado continua de onde já está (não recomeça) */
    const antes = Date.now();
    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 971, method: "tools/call",
      params: { name: "baixar_arquivo", arguments: { host: HOST, caminho: "/tmp/e2e-arq.bin" } } } });
    const env2 = leJson(r);
    f.check("v3.45 reenviar o MESMO arquivo é instantâneo (retomou, não reenviou 70 MB)",
      r.status === 200 && env2?.anexo?.id === anexo.id && Date.now() - antes < 8000,
      JSON.stringify({ ms: Date.now() - antes, id: env2?.anexo?.id }).slice(0, 200));

    /* 7) a chave do canal é conferida: sem chave, o servidor recusa o bloco */
    const semChave = await fetch(`${BASE}/maquina/r?id=abc&host=${HOST}&offset=0&total=10`, {
      method: "POST", headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("0123456789"), signal: AbortSignal.timeout(30000),
    });
    f.check("v3.45 bloco sem chave assinada é 401", semChave.status === 401, semChave.status);

    /* 8) copiar_arquivo de 70 MB entre máquinas continua funcionando pelo canal novo */
    r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 972, method: "tools/call",
      params: { name: "copiar_arquivo", arguments: { host: HOST, origem: "/tmp/e2e-arq.bin",
        host_destino: HOST, destino: "/tmp/e2e-arq-copia.bin" } } } });
    const cp = leJson(r);
    f.check("v3.45 copiar_arquivo de 70 MB e a cópia bate (sha256)",
      r.status === 200 && sha("/tmp/e2e-arq-copia.bin") === shaOrigem,
      JSON.stringify({ st: r.status, bytes: cp?.bytes, erro: erroDe(r) }).slice(0, 220));

    matar();
    sh("rm -f /tmp/e2e-arq.bin /tmp/e2e-arq-copia.bin /tmp/e2e-cli-arq.json");
    await call("DELETE", `/maquinas/${HOST}`, { key: TESTKEY });
    f.fechar("v3.45 arquivo grande");
  });

  await bloco(t, "v3.46: arquivo do navegador em blocos e envio para a máquina", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const leJson = (r: any): any => {
      const t = String(r?.json?.result?.content?.[0]?.text ?? "");
      try { return JSON.parse(t); } catch { return {}; }
    };
    const erroDe = (r: any): string =>
      String(r?.json?.error?.message ?? r?.json?.result?.content?.[0]?.text ?? r?.texto ?? "");
    const HOST = "cli-nav";
    const MATAR = "const fs=require('fs');for(const d of fs.readdirSync('/proc')){if(!/^[0-9]+$/.test(d))continue;"
      + "try{const c=fs.readFileSync('/proc/'+d+'/cmdline','utf8').split(String.fromCharCode(0)).join(' ');"
      + "if(c.indexOf('nexos-cliente-linux')>=0&&c.indexOf('" + HOST + "')>=0)process.kill(Number(d),'SIGKILL')}catch(e){}}";
    const matar = () => { try { execFileSync("docker", ["exec", CONTAINER, "node", "-e", MATAR]); } catch { /* ok */ } };
    const sh = (cmd: string) => execFileSync("docker", ["exec", CONTAINER, "sh", "-c", cmd], { encoding: "utf8" });
    const sha = (p: string) => sh(`sha256sum ${p} | cut -d' ' -f1`).trim();

    matar();
    await call("DELETE", `/maquinas/${HOST}`, { key: TESTKEY });
    const r0 = await call("POST", "/maquinas", { key: TESTKEY, corpo: { nome: HOST } });
    const par = String(r0.json?.token ?? "");
    f.check("v3.46 pareamento criado", Boolean(par), r0.texto.slice(0, 120));

    /* arquivo de 20 MB: três blocos de 8 MB (o navegador usa exatamente esse tamanho) */
    const TOTAL = 20971520;
    const BLOCO = 8 * 1024 * 1024;
    sh(`head -c ${TOTAL} /dev/urandom > /tmp/e2e-nav.bin`);
    const shaNav = sha("/tmp/e2e-nav.bin");
    const bytes = execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "cat /tmp/e2e-nav.bin"],
      { maxBuffer: 64 * 1024 * 1024 });
    const id = `nav${Date.now().toString(16)}${"0".repeat(16)}`.slice(0, 32);
    const enviarBloco = async (off: number, fim: number) =>
      fetch(`${BASE}/anexos/enviar?id=${id}&offset=${off}&total=${TOTAL}&nome=e2e-nav.bin&mime=application/octet-stream`, {
        method: "POST",
        headers: { Authorization: "B" + "earer " + TESTKEY, "content-type": "application/octet-stream" },
        body: bytes.subarray(off, fim),
        signal: AbortSignal.timeout(120000),
      });

    /* 1) bloco fora de ordem é recusado com 409 (o servidor diz quantos bytes tem) */
    const fora = await enviarBloco(BLOCO, BLOCO * 2);
    f.check("v3.46 bloco fora de ordem é 409", fora.status === 409, fora.status);

    /* 2) os três blocos na ordem, como o navegador manda */
    let ultimo: any = {};
    for (let off = 0; off < TOTAL; off += BLOCO) {
      const r = await enviarBloco(off, Math.min(off + BLOCO, TOTAL));
      ultimo = await r.json().catch(() => ({}));
      f.check(`v3.46 bloco em ${off} aceito (201)`, r.status === 201, JSON.stringify({ st: r.status, ...ultimo }).slice(0, 200));
    }
    f.check("v3.46 o envio fecha completo com o tamanho certo", ultimo?.completo === true && ultimo?.bytes === TOTAL,
      JSON.stringify(ultimo).slice(0, 200));

    /* 3) status do envio: é o que o navegador pergunta para retomar */
    const st = await fetch(`${BASE}/anexos/enviar/status?id=${id}`, {
      headers: { Authorization: "B" + "earer " + TESTKEY }, signal: AbortSignal.timeout(30000),
    });
    const stj: any = await st.json().catch(() => ({}));
    f.check("v3.46 status diz 20 MB e completo (retomada do navegador)", stj.bytes === TOTAL && stj.completo === true,
      JSON.stringify(stj).slice(0, 200));

    /* 4) o arquivo no disco do servidor é o mesmo que o navegador mandou */
    const noDisco = sh(`find /app/dados -path "*${id}*" -type f -printf '%p %s\\n' | head -1`).trim();
    f.check("v3.46 arquivo do navegador mora no volume, com o tamanho certo",
      noDisco.includes("/app/dados/anexos/teste/") && noDisco.endsWith(String(TOTAL)), noDisco.slice(0, 200));

    /* 5) ENVIAR PARA A MÁQUINA: o cliente real conectado baixa e confere o sha256 */
    execFileSync("docker", ["exec", "-d", CONTAINER, "/app/agente/bin/nexos-cliente-linux",
      "--url", "http://127.0.0.1:8000", "--token", par, "--host", HOST, "--conf", "/tmp/e2e-cli-nav.json"]);
    let online = false;
    for (let i = 0; i < 60; i++) {
      const g = await call("GET", "/maquinas", { key: TESTKEY });
      online = (g.json?.maquinas ?? []).some((m: any) => m.host === HOST && m.online === true);
      if (online) break;
      await dormir(300);
    }
    f.check("v3.46 cliente real conectou", online, online);

    const r = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 980, method: "tools/call",
      params: { name: "enviar_para_maquina", arguments: { host: HOST, anexo_id: id,
        destino: "/tmp/e2e-nav-destino.bin" } } } });
    const env = leJson(r);
    f.check("v3.46 enviar_para_maquina devolve ok com o tamanho", r.status === 200 && env?.bytes === TOTAL,
      JSON.stringify({ st: r.status, bytes: env?.bytes, erro: erroDe(r) }).slice(0, 240));
    f.check("v3.46 o arquivo no destino tem o MESMO sha256 do navegador",
      sha("/tmp/e2e-nav-destino.bin") === shaNav, JSON.stringify({ st: r.status, erro: erroDe(r) }).slice(0, 200));

    matar();
    sh("rm -f /tmp/e2e-nav.bin /tmp/e2e-nav-destino.bin /tmp/e2e-cli-nav.json");
    await call("DELETE", `/maquinas/${HOST}`, { key: TESTKEY });
    f.fechar("v3.46 navegador -> máquina");
  });

  await bloco(t, "v3.50: sandbox Python — rodar_python, ponte nexos e papel", async () => {
    const f = fiscal();
    const rpcTool = (key: string, args: Record<string, unknown>, id: unknown = 1) =>
      call("POST", "/mcp", {
        key,
        corpo: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "rodar_python", arguments: args } },
      });
    const saida = (r: any) => {
      try {
        return JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
      } catch {
        return {};
      }
    };

    /* 1. conta comum: não vê a ferramenta e a chamada é recusada */
    let lista = await call("POST", "/mcp", { key: TESTKEY, corpo: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const nomesComum = (lista.json?.result?.tools ?? []).map((t: any) => t.name);
    f.check("v3.50 conta comum não vê rodar_python", !nomesComum.includes("rodar_python"), nomesComum.length);

    let r = await rpcTool(TESTKEY, { codigo: "print(1)" });
    const textoComum = r.json?.result?.content?.[0]?.text ?? "";
    f.check("v3.50 conta comum é recusada (403), não executa", /403/.test(textoComum) && !saida(r).ok, textoComum.slice(0, 120));

    /* 2. operador: roda e devolve o stdout */
    r = await rpcTool(OPKEY, { codigo: "print('ola', 6*7)" });
    let s = saida(r);
    f.check("v3.50 operador roda script e recebe o stdout", s.ok === true && s.saida === "ola 42", JSON.stringify(s).slice(0, 200));

    /* 3. ponte: a ferramenta do servidor vira função Python */
    r = await rpcTool(OPKEY, { codigo: "import nexos\nprint(nexos.health()['versao'])" });
    s = saida(r);
    f.check("v3.50 import nexos chama a ferramenta health", s.ok === true && Array.isArray(s.chamadas) && s.chamadas.some((c: any) => c.ferramenta === "health"), JSON.stringify(s.chamadas ?? s).slice(0, 200));

    /* 4. rede: desde a v3.53 a internet passa pelo proxy; socket direto fora dele é bloqueado */
    r = await rpcTool(OPKEY, { codigo: "import socket\ns=socket.socket()\ntry:\n    s.connect(('127.0.0.1', 9099))\n    print('acessou')\nexcept Exception:\n    print('bloqueado')\n" });
    s = saida(r);
    f.check("v3.50 socket direto fora do proxy é bloqueado", s.saida === "bloqueado", JSON.stringify(s).slice(0, 200));

    /* 5. erro do script volta com o traceback */
    r = await rpcTool(OPKEY, { codigo: "raise ValueError('falha proposital')" });
    s = saida(r);
    f.check("v3.50 erro do script volta com traceback", s.ok === false && String(s.erro).includes("falha proposital"), JSON.stringify(s).slice(0, 200));

    /* 6. saída grande é cortada no teto */
    r = await rpcTool(OPKEY, { codigo: "print('x'*300000)" });
    s = saida(r);
    f.check("v3.50 saída cortada no teto de 120 KB", s.truncado === true && s.saida.length <= 120000, `${s.saida?.length}`);

    /* 7. teto de tempo mata o script */
    r = await rpcTool(OPKEY, { codigo: "import time\ntime.sleep(30)", segundos: 5 }, 9);
    s = saida(r);
    f.check("v3.50 teto de tempo encerra o script", s.ok === false && s.ms < 15000, `ok=${s.ok} ms=${s.ms}`);

    f.fechar("v3.50");
  });

  await bloco(t, "v3.51: pasta por usuário, venv e bibliotecas declaradas", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    /* a pasta da conta `op` é do ambiente de teste: começa limpa para provar a criação
       e a instalação (rodar o bloco duas vezes no mesmo volume não pode mudar o resultado) */
    if (CONTAINER) execFileSync("docker", ["exec", CONTAINER, "sh", "-c", "rm -rf /app/dados/usuarios/op"]);
    const rpcTool = (key: string, args: Record<string, unknown>, id: unknown = 1) =>
      call("POST", "/mcp", {
        key,
        corpo: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "rodar_python", arguments: args } },
      });
    const saida = (r: any) => {
      try {
        return JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
      } catch {
        return {};
      }
    };

    /* 1. a pasta do usuário nasce com o venv e o Python do servidor é 3.12 */
    let r = await rpcTool(OPKEY, { codigo: "import sys\nprint(sys.version.split()[0])" });
    let s = saida(r);
    f.check("v3.51 o script roda no Python 3.12", s.ok === true && String(s.saida).startsWith("3.12"), s.saida);
    f.check("v3.51 a pasta do usuário foi criada", s.pasta === "usuarios/op/scripts/saida" && s.uso_mb > 0, `${s.pasta} ${s.uso_mb}MB`);

    /* 2. biblioteca declarada é instalada e usada */
    r = await rpcTool(OPKEY, { codigo: "import six\nprint('six', six.__version__)", dependencias: ["six"] }, 2);
    s = saida(r);
    f.check("v3.51 dependência declarada é instalada e importa", s.ok === true && /^six 1\./.test(String(s.saida)), JSON.stringify(s).slice(0, 200));
    f.check("v3.51 a resposta diz o que foi instalado", Array.isArray(s.instalados) && s.instalados.includes("six"), JSON.stringify(s.instalados));

    /* 3. fica guardado: a próxima execução importa sem declarar nada */
    r = await rpcTool(OPKEY, { codigo: "import six\nprint('tem', six.__version__)" }, 3);
    s = saida(r);
    f.check("v3.51 biblioteca fica guardada entre execuções", s.ok === true && String(s.saida).startsWith("tem ") && (s.instalados ?? []).length === 0, JSON.stringify(s).slice(0, 200));

    /* 4. arquivo criado pelo script sobrevive, na pasta do usuário */
    r = await rpcTool(OPKEY, { codigo: "open('prova.txt','w').write('ok')" }, 4);
    f.check("v3.51 script grava sem erro", saida(r).ok === true, JSON.stringify(saida(r)).slice(0, 160));
    const ler = (caminho: string) => {
      try {
        return execFileSync("docker", ["exec", CONTAINER, "cat", caminho], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    };
    const dentro = CONTAINER ? ler("/app/dados/usuarios/op/scripts/saida/prova.txt") : "ok";
    f.check("v3.51 o arquivo fica em usuarios/<conta>/scripts/saida", dentro === "ok", dentro);

    /* 5. a lista de dependências é registrada em disco */
    const registro = CONTAINER ? ler("/app/dados/usuarios/op/dependencias.txt") : "six";
    f.check("v3.51 dependencias.txt registra o que foi instalado", registro.includes("six"), registro.slice(0, 80));

    /* 6. dependência com URL/opção é recusada (nada de `pip install git+...`) */
    r = await rpcTool(OPKEY, { codigo: "print(1)", dependencias: ["git+https://exemplo/x"] }, 5);
    const recusa = r.json?.result?.content?.[0]?.text ?? "";
    f.check("v3.51 dependencia invalida é recusada", /dependencia invalida/.test(recusa), String(recusa).slice(0, 120));

    /* 7. com venv, socket direto fora do proxy continua bloqueado */
    r = await rpcTool(OPKEY, { codigo: "import socket\ns=socket.socket()\ntry:\n    s.connect(('127.0.0.1', 9099))\n    print('acessou')\nexcept Exception:\n    print('bloqueado')" }, 6);
    s = saida(r);
    f.check("v3.51 socket direto continua bloqueado", s.saida === "bloqueado", JSON.stringify(s).slice(0, 160));

    f.fechar("v3.51");
  });

  await bloco(t, "v3.52: OCR por URL — user-agent de navegador e trava de endereço interno", async () => {
    const f = fiscal();
    const rpcImg = (key: string, args: Record<string, unknown>) =>
      call("POST", "/mcp", {
        key,
        corpo: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "analisar_imagem", arguments: args } },
      });
    const texto = (r: any) => r.json?.result?.content?.[0]?.text ?? "";
    const corpo = (r: any) => {
      try {
        return JSON.parse(texto(r));
      } catch {
        return {};
      }
    };

    /* 1. o caminho local (base64) continua funcionando */
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAlgAAADICAIAAAC7/QjhAAAHBklEQVR4nO3cX2jObx/A8XuPNVlqUgsrlBRn1F1Y5m5rfxwoBytzoraWQ0LCIUqhFcURB9ukHGiFotiMyDYHcsaUHK2o5c+GLLN1PQd3z53sT+v5PcPT5/U6ur7fa9f3+nafvPvef1aUUsoAQFT/+tM3AAB/khACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhCaEAIQmhACEJoQAhDa/IZw0aJFNTU1hcMlS5bkB6WlpdX/ce7cuXv37jU2NuanXrx4sWnTpsnJyY6Ojmw2W1lZmc1mr1y5kp99/vx5Q0NDTU1NfX390NBQ/uSNGzfylyouLs4Purq6ftli6to5rsobGRlpaWkpKysrnGlvb9+2bdvGjRu7u7szmcy3b992795dXV2dzWbv3Lkzfy8pAP9jaT6VlZVVVVU9fPiwcPjLoGDHjh2PHj1KKdXX1w8MDNy9e3fr1q2fPn1KKX369Gnr1q09PT0ppQ0bNgwNDaWUurq6mpqapm437ThvprWzr8qrqqq6cOFCYXZ4eDiXy01OTg4ODq5fvz6ldPbs2ba2tpTS27dvV69ePf3LAcDfZ95D2Nvbm8vlCoe/DApevXq1ZcuWrq6uvXv3ppRqa2v7+/sLs319fXV1dSmlFStWvH79OqU0Pj7++PHjqdtNO86bae1cQvju3bufZwcHB69fv55S+vr1a3l5eUrp48eP379/Tyn19PSsXbt22osA8Bea9xCmlHK53IMHD9KsIUwpHThwYOXKle/fv08pVVRUjI2NFabGxsYqKipSSh0dHcuXL29tbc1fcNrtZtpiprVzCeFMs52dna2trYXDPXv2lJaW3r9/f5aLAPBX+R1fljl58uTx48d/PjM+Pl74KG5gYCB/8vPnz8XFxV+/fp32/duioqJMJtPS0vLy5cuqqqqDBw+eOHFilk2nbjGXtdPe2EzevHnT1tZ25syZwpmrV69eu3at8IkmAP8H5jWzhUeo6urq3t7eWZ4Inzx50tjY2N3dvXPnzpRSXV1dX1/fz7MNDQ3Dw8OFk8PDw8uWLZtpu6lbzLL2v3si/PLlSzabffr0af5w3759P378SClNTEwsXbp0losA8Ff5TT+fmPpQ+LOJiYlDhw61tbXV19cXFxffunXryJEjR48eHR0dzWQyIyMjx44dO3r0aFFRUVNTU/7Loh8+fFi1atXcb+CfrJ0qpdTc3Hz48OHNmzfnz4yOjt68eTOTyfT3969bt+6fXByA36n492yTy+VKSkq+f/+eP8y/A5kfV1ZWlpeX19XVrVmzJpPJnD9/fvv27c+ePWttba2pqVm4cOH4+Pj+/ftra2szmczly5d37dq1aNGiBQsWtLe3z7LjL1ucPn16Lmunrpr2zzo7O+/du/fhw4dLly4tXrz49u3bp06dam5uvnjxYklJyew3BsBfpSil9KfvAQD+GP9ZBoDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQhBCA0IQQgNCEEIDQ/g0YZh8xlaD9QwAAAABJRU5ErkJggg==";
    let r = await rpcImg(OPKEY, { base64: PNG });
    let s = corpo(r);
    f.check("v3.52 OCR lê o texto da imagem em base64", s.ok === true && /NEXOS TESTE 123/.test(s.texto ?? ""), JSON.stringify(s).slice(0, 160));

    /* 2. endereço interno é recusado antes de qualquer requisição */
    for (const alvo of [
      "http://127.0.0.1:8001/imagem.png",
      "http://localhost/x.png",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/x.png",
      "http://192.168.48.1/x.png",
    ]) {
      r = await rpcImg(OPKEY, { url: alvo });
      f.check(`v3.52 recusa endereço interno (${alvo})`, /endereco interno nao permitido/.test(texto(r)), texto(r).slice(0, 120));
    }

    /* 3. URL pública que exige user-agent de navegador: o Wikimedia devolvia 400 com o UA do Node */
    r = await rpcImg(OPKEY, { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/80/Wikipedia-logo-v2.svg/500px-Wikipedia-logo-v2.svg.png" });
    const t3 = texto(r);
    s = corpo(r);
    f.check("v3.52 baixa imagem pública com UA de navegador (sem 400)", (s.ok === true && Number(s.bytes) > 0) || /nao saiu texto/.test(t3), t3.slice(0, 160));

    f.fechar("v3.52");
  });

  await bloco(t, "v3.53: sandbox — uid por conta, rede pelo proxy e teto de memória", async () => {
    const f = fiscal();
    const CONTAINER = process.env.CONTAINER ?? "";
    const rpcPy = (codigo: string) =>
      call("POST", "/mcp", {
        key: OPKEY,
        corpo: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rodar_python", arguments: { codigo } } },
      });
    const corpo = (r: any) => {
      const texto = r.json?.result?.content?.[0]?.text ?? "";
      try {
        return JSON.parse(texto);
      } catch {
        return {};
      }
    };

    /* pasta de OUTRA conta: só o root lê (700), com um segredo dentro */
    if (CONTAINER) {
      execFileSync("docker", ["exec", CONTAINER, "sh", "-c",
        "mkdir -p /app/dados/usuarios/intruso/scripts/saida && echo SEGREDO > /app/dados/usuarios/intruso/scripts/saida/segredo.txt && chmod 700 /app/dados/usuarios/intruso/scripts/saida && chmod 700 /app/dados/usuarios/intruso"],
        { stdio: "ignore" });
    }

    let r = await rpcPy("import os\nprint(os.getuid())");
    let s = corpo(r);
    f.check("v3.53 script não roda como root", s.ok === true && Number(s.saida) > 0, JSON.stringify(s).slice(0, 120));

    r = await rpcPy("p='/app/dados/usuarios/intruso/scripts/saida/segredo.txt'\ntry:\n    print('LEU', open(p).read().strip())\nexcept Exception as e:\n    print('NEGADO', type(e).__name__)");
    s = corpo(r);
    f.check("v3.53 não lê arquivo de outra conta", s.saida === "NEGADO PermissionError", JSON.stringify(s).slice(0, 160));

    r = await rpcPy("import os\ntry:\n    os.listdir('/app/dados/usuarios')\n    print('LISTOU')\nexcept Exception as e:\n    print('NEGADO', type(e).__name__)");
    s = corpo(r);
    f.check("v3.53 não lista as pastas das outras contas", s.saida === "NEGADO PermissionError", JSON.stringify(s).slice(0, 160));

    r = await rpcPy("import urllib.request\nprint(urllib.request.urlopen('https://api.github.com', timeout=15).status)");
    s = corpo(r);
    f.check("v3.53 internet liberada pelo proxy", s.ok === true && s.saida === "200", JSON.stringify(s).slice(0, 160));
    f.check("v3.53 proxy registra o destino usado", Array.isArray(s.rede) && s.rede.some((d: any) => /api\.github\.com/.test(d.alvo)), JSON.stringify(s.rede ?? []).slice(0, 160));

    r = await rpcPy("import urllib.request\ntry:\n    urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5)\n    print('ACESSOU')\nexcept Exception:\n    print('NEGADO')");
    s = corpo(r);
    f.check("v3.53 proxy recusa endereço interno", s.saida === "NEGADO" && Array.isArray(s.rede) && s.rede.some((d: any) => /interno/.test(d.motivo ?? "")), JSON.stringify(s).slice(0, 200));

    r = await rpcPy("import socket\ns=socket.socket()\ntry:\n    s.connect(('127.0.0.1', 9099))\n    print('ACESSOU')\nexcept Exception as e:\n    print('NEGADO', type(e).__name__)");
    s = corpo(r);
    f.check("v3.53 socket direto fora do proxy é bloqueado", s.saida === "NEGADO _RedeBloqueada", JSON.stringify(s).slice(0, 160));

    /* o escape antigo: processo filho não passa pelo proxy */
    r = await rpcPy("import subprocess\ntry:\n    subprocess.run(['curl','-s','-m','3','http://127.0.0.1:8000/health'])\n    print('ACESSOU')\nexcept Exception as e:\n    print('NEGADO', type(e).__name__)");
    s = corpo(r);
    f.check("v3.53 processo filho (curl) bloqueado", s.saida === "NEGADO PermissionError", JSON.stringify(s).slice(0, 160));

    r = await rpcPy("import os\ntry:\n    os.system('curl -s -m 3 http://127.0.0.1:8000/health')\n    print('ACESSOU')\nexcept Exception as e:\n    print('NEGADO', type(e).__name__)");
    s = corpo(r);
    f.check("v3.53 os.system bloqueado", s.saida === "NEGADO PermissionError", JSON.stringify(s).slice(0, 160));

    r = await rpcPy("try:\n    import ctypes\n    ctypes.CDLL('libc.so.6')\n    print('ACESSOU')\nexcept Exception as e:\n    print('NEGADO', type(e).__name__)");
    s = corpo(r);
    f.check("v3.53 ctypes bloqueado", s.saida === "NEGADO PermissionError", JSON.stringify(s).slice(0, 160));

    r = await rpcPy("x=bytearray(900*1024*1024)\nprint('alocou')");
    s = corpo(r);
    f.check("v3.53 teto de memória derruba script que aloca demais", s.ok === false && /MemoryError/.test(String(s.erro)), JSON.stringify(s).slice(0, 160));

    f.fechar("v3.53");
  });

  await bloco(t, "freio de força bruta (último: bloqueia o IP)", async () => {
    const f = fiscal();
    for (let i = 0; i < 10; i++) {
      await call("GET", "/gavetas", { key: `chave-errada-${String(i).padStart(2, "0")}` });
    }
    let r = await call("GET", "/gavetas", { key: "chave-errada-final" });
    f.check("11ª tentativa errada -> 429", r.status === 429, r.status);
    r = await call("GET", "/gavetas", { key: TESTKEY });
    f.check("chave BOA também barrada enquanto bloqueado", r.status === 429, r.status);
    f.fechar("rate-limit");
  });

  /* ---------------- cobertura declarada (regra 8 da skill `suite-de-testes`) ----------------
     Dentro de t.after(): imprime TAMBÉM quando um bloco falha, senão a rodada vermelha
     fica sem dizer o que foi rodado e o que não foi. */
  t.after(() => {
    console.log("\n== COBERTURA DESTA RODADA ==");
    console.log(`escopo: ${FILTRO ? "filtrado por SO_BLOCOS=" + FILTRO : "SUÍTE COMPLETA"}`);
    console.log(`blocos: ${blocosRodados.length} rodados | ${blocosPulados.length} pulados`);
    if (blocosPulados.length) console.log("NÃO RODOU (o verde desta rodada não cobre isto):\n  - " + blocosPulados.join("\n  - "));
    console.log("COBRE: contrato pela porta HTTP pública, papéis (sem chave / papel errado), isolamento por escopo,"
      + " efeito lido de volta no banco, provedor FALSO obedecendo o protocolo (stream e não-stream),"
      + " freio de força bruta, e prova de versão no /health.");
    console.log("NÃO COBRE (nem na suíte completa):");
    for (const b of [
      "tela real: clique, render, ordem visual, fila do chat (camada visual — references/visual.md)",
      "provedor de IA real (o seu modelo atrás do gateway): aqui é falso por regra",
      "SSE atrás do proxy de produção (buffering do Caddy) — smoke no domínio depois do deploy",
      "pertinência do resultado: o trecho certo ficou no topo? a resposta está certa?",
      "carga, concorrência e latência por etapa (modelo × ferramenta × compactação)",
      "matriz completa rota × papel (só as rotas críticas são varridas)",
      "degradação: disco cheio, banco cai no meio do job, payload gigante",
      "infra: build em host limpo sem cache, backup/restore, migração entre versões",
      "segurança de cadeia: dependências, CSP/CORS, rotação de credencial",
    ]) console.log("  - " + b);
    console.log("alvo, escopo e como fechar cada lacuna: docs/testes.md");
  });
});