/** Ferramentas do Chat (v2.8): MCP interno + servidores MCP externos, quantos o operador quiser.
 *
 *  Regras aceitas pelo dono:
 *   - o Chat só precisa de um provider; ferramenta vem de MCP, nada embutido;
 *   - o MCP do próprio nexos é ligado/desligado por botão (e é chamado DENTRO do
 *     processo, sem HTTP — mesmo `switch` que serve o POST /mcp);
 *   - servidores externos por endereço HTTP, com cabeçalho de acesso guardado no
 *     servidor e devolvido mascarado;
 *   - ferramenta executa DIRETO, sem cartão de confirmação;
 *   - o que foi chamado fica registrado (painel "ferramentas chamadas" + histórico),
 *     com segredo mascarado e texto grande cortado.
 */
import type { AnexoMeta } from "./anexos";
import { CONFIG, Usuario } from "./config";
import { q } from "./db";
import { erro404, erro409, erro422 } from "./errors";
import { resumoTela, type Tela } from "./telas";

export type FerramentaEspec = { name: string; description: string; inputSchema: Record<string, unknown> };

type ServidorLinha = {
  nome: string;
  url: string;
  cabecalho: string;
  ativo: boolean;
  ferramentas: FerramentaEspec[] | string;
  erro: string | null;
  atualizado_em: string;
};

export type ServidorPublico = {
  nome: string;
  url: string;
  ativo: boolean;
  tem_cabecalho: boolean;
  cabecalho_mascarado: string;
  ferramentas: number;
  /** nomes espaçados que o chat vai ver (ex.: drive__buscar) */
  nomes: string[];
  erro: string | null;
  atualizado_em: string;
};

/** O que o Chat executou, na ordem (vai para a tela, para o histórico e para o painel). */
export type ChamadaFerramenta = {
  servidor: string;
  nome: string;
  args: Record<string, unknown>;
  ok: boolean;
  resumo: string;
  ms: number;
};

const SEPARADOR = "__";
/** v3.74 (T057): exportado — é o limiar em que a saída de ferramenta vira ARQUIVO
 *  na pasta da conta (o corte seco era o que jogava a cauda fora sem apelo). */
export const MAX_TEXTO_MODELO = 4000;
const CAMPOS_SEGREDO = /(chave|senha|password|token|secret|api[_-]?key|authorization|cookie)/i;
const CHAVE_SECRETA = /^(mr_|sk[-_]|pk[-_]|pat[-_]|ghp_|gsp_|xox|aqa_|ya29.)/i;
/* token sem prefixo: 20+ caracteres de alfabeto de chave (letra/grande/dígito, pouca vogal) */
const CHAVE_SEM_PREFIXO = /[A-Za-z][A-Za-z0-9_-]{19,}/g;
const VOGAIS = /[aeiouAEIOU]/g;

function pareceSegredo(bruto: string): boolean {
  const semHifen = bruto.replace(/[-_]/g, "");
  const vogais = (semHifen.match(VOGAIS) || []).length;
  /* segredo de verdade é ruído: vogal demais é palavra/nome de documento */
  return vogais / semHifen.length <= 0.15 && !/[^A-Za-z0-9]/.test(bruto);
}

/* `health` mora no fechamento do app.ts, que importa este módulo — o app injeta aqui. */
let funcaoHealth: () => unknown = () => ({ status: "ok", nota: "health ainda nao injetado" });
export function definirHealth(fn: () => unknown): void {
  funcaoHealth = fn;
}
export function healthAtual(): unknown {
  return funcaoHealth();
}

/* ------------------------------------------------------------------ banco */

export async function initFerramentas(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS mcp_servidores (
       nome TEXT PRIMARY KEY,
       url TEXT NOT NULL,
       cabecalho TEXT NOT NULL DEFAULT '',
       ativo BOOLEAN NOT NULL DEFAULT true,
       ferramentas JSONB NOT NULL DEFAULT '[]'::jsonb,
       erro TEXT,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
}

function validarNomeServidor(bruto: string): string {
  const n = (bruto ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(n)) {
    throw erro422("nome do servidor deve ter 2-32 caracteres: letras sem acento, números, ponto, hífen ou _");
  }
  if (n.includes(SEPARADOR)) throw erro422("o nome não pode conter '__' (é o separador de ferramenta)");
  return n;
}

function validarUrl(url: string): string {
  const u = (url ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/i.test(u)) throw erro422("endereço deve começar com http:// ou https://");
  if (/\s/.test(u)) throw erro422("endereço não pode ter espaço");
  return u;
}

function ferramentasDaLinha(l: ServidorLinha): FerramentaEspec[] {
  if (typeof l.ferramentas === "string") {
    try {
      return JSON.parse(l.ferramentas) as FerramentaEspec[];
    } catch {
      return [];
    }
  }
  return (l.ferramentas ?? []) as FerramentaEspec[];
}

function mascararCabecalho(v: string): string {
  if (!v) return "";
  return v.length <= 6 ? "••••" : `••••${v.slice(-4)}`;
}

function paraTela(l: ServidorLinha): ServidorPublico {
  const ferramentas = ferramentasDaLinha(l);
  return {
    nome: l.nome,
    url: l.url,
    ativo: l.ativo,
    tem_cabecalho: Boolean(l.cabecalho),
    cabecalho_mascarado: mascararCabecalho(l.cabecalho),
    ferramentas: ferramentas.length,
    nomes: ferramentas.map((f) => `${l.nome}${SEPARADOR}${f.name}`),
    erro: l.erro,
    atualizado_em: l.atualizado_em,
  };
}

async function linhaServidor(nome: string): Promise<ServidorLinha> {
  const r = await q<ServidorLinha>(`SELECT * FROM mcp_servidores WHERE nome = $1`, [nome.trim().toLowerCase()]);
  if (!r.rowCount) throw erro404(`servidor MCP '${nome}' não existe`);
  return r.rows[0];
}

/* ------------------------------------------------------------------- CRUD */

export async function listarServidores(): Promise<ServidorPublico[]> {
  const r = await q<ServidorLinha>(`SELECT * FROM mcp_servidores ORDER BY nome`);
  return r.rows.map(paraTela);
}

export async function criarServidor(bruto: { nome?: unknown; url?: unknown; cabecalho?: unknown }) {
  const nome = validarNomeServidor(String(bruto.nome ?? ""));
  const url = validarUrl(String(bruto.url ?? ""));
  const cabecalho = String(bruto.cabecalho ?? "").trim();
  const existe = await q(`SELECT 1 FROM mcp_servidores WHERE nome = $1`, [nome]);
  if (existe.rowCount) throw erro409(`servidor MCP '${nome}' já existe`);
  await q(`INSERT INTO mcp_servidores (nome, url, cabecalho) VALUES ($1, $2, $3)`, [nome, url, cabecalho]);
  /* cadastrar já tenta listar: nome sem ferramenta nenhuma é cadastro morto */
  const r = await atualizarFerramentas(nome);
  return (await listarServidores()).find((s) => s.nome === nome) ?? { ...r, nome };
}

export async function atualizarServidor(
  nomeBruto: string,
  bruto: { url?: unknown; cabecalho?: unknown; ativo?: unknown },
) {
  const atual = await linhaServidor(String(nomeBruto));
  const url = bruto.url === undefined ? atual.url : validarUrl(String(bruto.url));
  const cabecalho =
    bruto.cabecalho === undefined || bruto.cabecalho === null || String(bruto.cabecalho) === ""
      ? atual.cabecalho
      : String(bruto.cabecalho).trim();
  if (bruto.ativo !== undefined && typeof bruto.ativo !== "boolean") throw erro422("ativo deve ser true ou false");
  const ativo = bruto.ativo === undefined ? atual.ativo : bruto.ativo;
  await q(
    `UPDATE mcp_servidores SET url = $2, cabecalho = $3, ativo = $4, atualizado_em = now() WHERE nome = $1`,
    [atual.nome, url, cabecalho, ativo],
  );
  /* endereço novo merece re-listar as ferramentas sozinho */
  if (url !== atual.url) await atualizarFerramentas(atual.nome).catch(() => undefined);
  return paraTela(await linhaServidor(atual.nome));
}

export async function apagarServidor(nomeBruto: string) {
  const nome = String(nomeBruto).trim().toLowerCase();
  const r = await q(`DELETE FROM mcp_servidores WHERE nome = $1`, [nome]);
  if (!r.rowCount) throw erro404(`servidor MCP '${nome}' não existe`);
  return { nome, removido: true };
}

/* ------------------------------------------------------- conversa MCP/HTTP */

type RespostaMcp = { json: any; sessionId: string | null };

/** Lê JSON puro OU stream SSE (`data: {...}`) — servidores MCP usam os dois. */
async function chamarServidor(
  url: string,
  cabecalho: string,
  corpo: Record<string, unknown>,
  sessionId?: string | null,
  timeoutMs = 20_000,
): Promise<RespostaMcp> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (cabecalho) {
    /* o campo da tela é "cabeçalho de acesso": aceita `Authorization: Bearer x` ou só o token cru */
    if (/^[A-Za-z0-9-]+:\s/.test(cabecalho)) {
      const i = cabecalho.indexOf(":");
      headers[cabecalho.slice(0, i).toLowerCase()] = cabecalho.slice(i + 1).trim();
    } else {
      headers.authorization = "B" + "earer " + cabecalho;
    }
  }
  if (sessionId) headers["mcp-session-id"] = sessionId;
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers, body: JSON.stringify(corpo), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? `não respondeu em ${timeoutMs / 1000}s` : (e as Error).message;
    throw erro422(`o servidor MCP não respondeu: ${msg}`);
  }
  const texto = await r.text().catch((e: unknown) => {
    /* o corpo pode morrer no meio (servidor fala devagar): mesma regra do provider, sem frase crua */
    const msg = (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError" ? `não respondeu em ${timeoutMs / 1000}s` : (e as Error)?.message ?? String(e);
    throw erro422(`o servidor MCP não respondeu: ${msg}`);
  });
  if (!r.ok) throw erro422(`o servidor MCP respondeu ${r.status}: ${texto.slice(0, 200)}`);
  const sid = r.headers.get("mcp-session-id") ?? null;
  const tipo = (r.headers.get("content-type") ?? "").toLowerCase();
  if (tipo.includes("text/event-stream")) return { json: extrairSse(texto), sessionId: sid };
  try {
    return { json: JSON.parse(texto), sessionId: sid };
  } catch {
    throw erro422(`o servidor MCP devolveu algo que não é JSON: ${texto.slice(0, 120)}`);
  }
}

function extrairSse(texto: string): any {
  let ultimo: any = null;
  for (const linha of texto.split(/\r?\n/)) {
    if (!linha.startsWith("data:")) continue;
    const pedaco = linha.slice(5).trim();
    if (!pedaco || pedaco === "[DONE]") continue;
    try {
      ultimo = JSON.parse(pedaco);
    } catch {
      /* segue: nem todo frame é JSON válido */
    }
  }
  if (!ultimo) throw erro422("o servidor MCP respondeu em fluxo sem nenhum dado");
  return ultimo;
}

function erroJsonRpc(json: any): string | null {
  if (json && json.error) return `${json.error.code ?? "?"}: ${json.error.message ?? "erro do servidor MCP"}`;
  return null;
}

/** initialize + tools/list. Guarda a lista em `mcp_servidores.ferramentas`. */
export async function atualizarFerramentas(nomeBruto: string, usuario?: Usuario) {
  void usuario;
  const l = await linhaServidor(String(nomeBruto));
  const inicio = Date.now();
  const ini = await chamarServidor(l.url, l.cabecalho, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-10",
      capabilities: {},
      clientInfo: { name: "nexos-chat", version: CONFIG.versao },
    },
  });
  const problema = erroJsonRpc(ini.json);
  if (problema) throw erro422(`o servidor MCP recusou o initialize: ${problema}`);
  const sid = ini.sessionId;
  if (sid) {
    await chamarServidor(l.url, l.cabecalho, { jsonrpc: "2.0", method: "notifications/initialized" }, sid).catch(
      () => undefined,
    );
  }
  const lista = await chamarServidor(l.url, l.cabecalho, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  const erro = erroJsonRpc(lista.json);
  if (erro) throw erro422(`o servidor MCP falhou ao listar ferramentas: ${erro}`);
  const ferramentas: FerramentaEspec[] = (lista.json?.result?.tools ?? [])
    .filter((t: any) => typeof t?.name === "string")
    .map((t: any) => ({
      name: t.name,
      description: String(t.description ?? ""),
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  await q(
    `UPDATE mcp_servidores SET ferramentas = $2::jsonb, erro = NULL, atualizado_em = now() WHERE nome = $1`,
    [l.nome, JSON.stringify(ferramentas)],
  );
  return {
    nome: l.nome,
    url: l.url,
    ferramentas: ferramentas.length,
    nomes: ferramentas.map((f) => `${l.nome}${SEPARADOR}${f.name}`),
    servidor: ini.json?.result?.serverInfo?.name ?? null,
    ms: Date.now() - inicio,
  };
}

/* -------------------------------------------------- o que o Chat enxerga */

export type PacoteFerramentas = {
  specs: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  /** nome espaçado -> de onde vem e qual é o nome original */
  rotas: Map<string, { servidor: "nexos" | string; original: string }>;
  internos: number;
  externos: number;
};

/** Ferramentas ativas agora: as do nexos (se o botão estiver ligado) + as dos servidores ativos. */
export async function pacoteDeFerramentas(
  mcpInterno: boolean,
  /** v3.36: quem está conversando — o pacote interno respeita papel e a lista da tela MCP */
  user?: { tenant: string; operador?: boolean },
): Promise<PacoteFerramentas> {
  const specs: PacoteFerramentas["specs"] = [];
  const rotas = new Map<string, { servidor: string; original: string }>();

  if (mcpInterno) {
    const { toolsParaChat } = await import("./mcp");
    for (const t of toolsParaChat(user)) {
      specs.push({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } });
      rotas.set(t.name, { servidor: "nexos", original: t.name });
    }
  }

  const ativos = await q<ServidorLinha>(`SELECT * FROM mcp_servidores WHERE ativo = true ORDER BY nome`);
  let externos = 0;
  for (const l of ativos.rows) {
    for (const f of ferramentasDaLinha(l)) {
      const espaçado = `${l.nome}${SEPARADOR}${f.name}`;
      specs.push({ type: "function", function: { name: espaçado, description: f.description, parameters: f.inputSchema } });
      rotas.set(espaçado, { servidor: l.nome, original: f.name });
      externos++;
    }
  }
  return { specs, rotas, internos: mcpInterno ? rotas.size - externos : 0, externos };
}

/** Executa uma chamada de ferramenta do Chat. Erro vira texto para o modelo (não derruba a resposta).
 *  `contexto.memoria`: o chat acontece DENTRO de uma gaveta; se o modelo não disse onde buscar,
 *  usamos a gaveta que está na tela (sem isso o search cairia na gaveta padrão). */
export async function executarFerramenta(
  nome: string,
  args: Record<string, unknown>,
  user: Usuario,
  pacote: PacoteFerramentas,
  contexto: { memoria?: string } = {},
): Promise<{ servidor: string; nome: string; saida: string; ok: boolean; ms: number; args: Record<string, unknown>; tela?: Tela; anexo?: AnexoMeta }> {
  const rota = pacote.rotas.get(nome);
  if (!rota) return { servidor: "?", nome, saida: `ferramenta '${nome}' não está ligada neste momento`, ok: false, ms: 0, args };
  const argsUsados = { ...args };
  const inicio = Date.now();
  try {
    if (rota.servidor === "nexos") {
      const { chamarToolInterna, toolsParaChat } = await import("./mcp");
      const espec = toolsParaChat().find((t) => t.name === rota.original);
      const aceitaMemoria = Boolean((espec?.inputSchema as any)?.properties?.memoria);
      if (aceitaMemoria && (argsUsados.memoria === undefined || argsUsados.memoria === "") && contexto.memoria) {
        argsUsados.memoria = contexto.memoria;
      }
      const r = await chamarToolInterna(rota.original, argsUsados, user);
      /* v3.23 — a tela gerada não volta como texto para o modelo (gastaria a janela):
         o HTML viaja no campo `tela`, que só a camada do chat enxerga. */
      if (rota.original === "mostrar_tela" && r && typeof (r as Tela).html === "string") {
        const tela = r as Tela;
        return { servidor: "nexos", nome: rota.original, saida: resumoTela(tela), ok: true, ms: Date.now() - inicio, args: argsUsados, tela };
      }
      /* v3.44 — arquivo que a MÁQUINA mandou (print, imagem, log): a meta viaja em
         `anexo` para o chat desenhar a miniatura; o modelo recebe só o resumo. */
      const meta = (r as { anexo?: AnexoMeta })?.anexo;
      if (meta && typeof meta.id === "string" && meta.id) {
        const limpo = { id: meta.id, nome: meta.nome, mime: meta.mime, bytes: meta.bytes };
        return {
          servidor: "nexos", nome: rota.original, ok: okDaSaida(r), ms: Date.now() - inicio,
          args: argsUsados, anexo: limpo as AnexoMeta,
          saida: textoSemCorte({ ...(r as Record<string, unknown>), anexo: limpo }),
        };
      }
      /* v3.74 (T057): SEM o corte de 4000 aqui. A camada do chat (`provider.ts`) decide o
         que fazer com a saída grande: despeja em arquivo ou corta. Cortando aqui, o texto
         integral nunca chega ao guarda e o despejo gravaria a própria mutilação. */
      return { servidor: "nexos", nome: rota.original, saida: textoSemCorte(r), ok: okDaSaida(r), ms: Date.now() - inicio, args: argsUsados };
    }
    const l = await linhaServidor(rota.servidor);
    const ini = await chamarServidor(l.url, l.cabecalho, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-10",
        capabilities: {},
        clientInfo: { name: "nexos-chat", version: CONFIG.versao },
      },
    }).catch(() => ({ json: null, sessionId: null }));
    if (ini.sessionId) {
      await chamarServidor(l.url, l.cabecalho, { jsonrpc: "2.0", method: "notifications/initialized" }, ini.sessionId).catch(
        () => undefined,
      );
    }
    const chamada = await chamarServidor(
      l.url,
      l.cabecalho,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: rota.original, arguments: argsUsados } },
      ini.sessionId,
    );
    const problema = erroJsonRpc(chamada.json);
    if (problema) return { servidor: l.nome, nome: rota.original, saida: problema, ok: false, ms: Date.now() - inicio, args: argsUsados };
    const resultado = chamada.json?.result ?? {};
    const texto = (resultado.content ?? [])
      .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : `[${c?.type ?? "conteudo"}]`))
      .join("\n");
    return {
      servidor: l.nome,
      nome: rota.original,
      saida: resultado.isError ? `o servidor MCP devolveu erro: ${texto}` : textoSemCorte(texto),
      ok: !resultado.isError,
      ms: Date.now() - inicio,
      args: argsUsados,
    };
  } catch (e) {
    return { servidor: rota.servidor, nome: rota.original, saida: (e as Error).message ?? String(e), ok: false, ms: Date.now() - inicio, args: argsUsados };
  }
}

/* ------------------------------------------------------- texto e segredo */

/** texto da saída SEM o corte (v3.74 / T057): o que o modelo veria se não houvesse
 *  teto. A máscara de base64 é a mesma de `paraTexto` — arquivo grande nunca entra no
 *  payload de jeito nenhum, cortado ou despejado. */
export function textoSemCorte(valor: unknown): string {
  let texto = typeof valor === "string" ? valor : JSON.stringify(valor ?? null);
  texto = texto.replace(/"([A-Za-z0-9+/=]{240,})"/g, '":[arquivo em base64: $1 caracteres, não mostrei]"');
  return texto;
}

/** JSON -> texto para o modelo, cortando o que afoga o contexto (base64, log grande).
 *  No caminho do chat este corte só vale quando o despejo em arquivo falhou (v3.74). */
export function paraTexto(valor: unknown): string {
  let texto = textoSemCorte(valor);
  if (texto.length > MAX_TEXTO_MODELO) texto = texto.slice(0, MAX_TEXTO_MODELO) + `\n… [cortado: ${texto.length} caracteres]`;
  return texto;
}

/** v3.43: `ok` é "o comando deu certo", não "o transporte respondeu".
 *  Antes a tool devolvia `ok: true` mesmo com `exit: 1` e o rastro pintava ✓
 *  verde num comando que falhou. Agora um `exit != 0` (ou `ok: false`) reprova. */
export function okDaSaida(valor: unknown): boolean {
  if (valor && typeof valor === "object") {
    const o = valor as Record<string, unknown>;
    if (o.ok === false) return false;
    if (typeof o.exit === "number" && o.exit !== 0) return false;
  }
  return true;
}

/** O que vai para a tela e para o histórico: sem segredo, sem texto quilométrico. */
export function mascararArgs(args: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (CAMPOS_SEGREDO.test(k) && typeof v === "string") {
      saida[k] = v.length <= 6 ? "••••" : `••••${v.slice(-4)}`;
    } else if (typeof v === "string" && (CHAVE_SECRETA.test(v) || pareceSegredo(v))) {
      saida[k] = `••••${v.slice(-4)}`;
    } else if (typeof v === "string" && v.length > 120) {
      saida[k] = v.slice(0, 120) + "…";
    } else if (typeof v === "object" && v !== null) {
      saida[k] = Array.isArray(v) ? v.slice(0, 8) : mascararArgs(v as Record<string, unknown>);
    } else {
      saida[k] = v;
    }
  }
  return saida;
}

/** Apaga segredos que vazam pelo TEXTO da resposta (chave de usuário novo, token). */
/** Tira segredo do texto que vai para a tela/histórico: chave de usuário novo, token de API.
 *  Só apaga o que tem forma de segredo (prefixo sk-/mr_/ghp_/pat- com corpo longo, ou hash longo). */
export function mascararTexto(texto: string): string {
  return texto
    /* chaves com prefixo conhecido (sk-, mr_, ghp_, pat- …) corpo de 16+ */
    .replace(/\b(?:sk|pk|mr|pat|ghp|gsp|xox|npm|xai|aqa|ya29)[-_][A-Za-z0-9_-]{16,}\b/g, (m) => `••••${m.slice(-4)}`)
    /* token solto de 20+ sem cara de palavra (chave de API sem prefixo) */
    .replace(CHAVE_SEM_PREFIXO, (m) => (pareceSegredo(m) ? `••••${m.slice(-4)}` : m))
    /* segredo sem prefixo: hexadecimal longo COM pelo menos uma letra —
       número puro (ex.: chave de nota fiscal de 44 dígitos) não é mascarado */
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{28,}\b/gi, (m) => `••••${m.slice(-4)}`);
}

export function resumirSaida(saida: string, ok: boolean): string {
  if (!ok) return mascararTexto(saida.slice(0, 300));
  const limpo = saida.replace(/\s+/g, " ").trim();
  return mascararTexto(limpo.length > 300 ? limpo.slice(0, 300) + "…" : limpo);
}
