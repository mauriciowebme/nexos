/** Provider de linguagem do Chat (v2.8) + a conversa, que é um agente de ferramentas MCP.
 *
 *  Regras aceitas pelo dono:
 *   - o Chat só precisa de um **provider** configurado; sem ele o Chat fica desligado;
 *   - **nenhuma regra embutida**: as instruções iniciais vêm do `system_prompt` da tela.
 *     Campo vazio = nenhuma instrução (o modelo conversa puro);
 *   - **ferramenta vem de MCP**: o do próprio nexos (botão) + servidores externos
 *     cadastrados (quantos o operador quiser). Nada ligado = nenhuma ferramenta;
 *   - a ferramenta **executa direto**, sem cartão de confirmação — mas o que foi chamado
 *     fica registrado na tela, no histórico e na resposta, com segredo mascarado;
 *   - a chave do provider é guardada no servidor e devolvida SEMPRE mascarada;
 *   - cada usuário pode ter a sua configuração; o operador grava o padrão global (escopo '*').
 */
import { Usuario, log, tenantFor } from "./config";
import { REGRAS_CASA } from "./regras";
import { erro409, erro422 } from "./errors";
import { q } from "./db";
import { apertarRodada, custoDoPayload, type MsgChat, montarPayload, OPCOES_PADRAO, type Opcoes } from "./compactar";
import { abrirAnexo, type AnexoMeta } from "./anexos";
import { MAX_TELAS_TURNO, htmlParcial, type Tela } from "./telas";
import {
  type ChamadaFerramenta,
  executarFerramenta,
  mascararArgs,
  pacoteDeFerramentas,
  paraTexto,
  resumirSaida,
} from "./ferramentas";

export type TipoProvider = "litellm" | "openai" | "ollama";

const GLOBAL = "*";
const LIMITE_PROMPT = 8000;
export const RODADAS_PADRAO = 5;
/* v3.0 — memória e orçamento de contexto (heurística de tokens em compactar.ts) */
export const MEMORIA_PADRAO = 12; // turnos antigos que voltam ao modelo (0 = sem memória, como na v2.9)
export const VERBATIM_PADRAO = 20; // v3.56 — = protect_last_n do mini-compress (últimas verbatim)
export const RESERVA_PADRAO = 1024; // tokens livres para a resposta
export const JANELA_PADRAO = 8192; // usada quando nem o painel nem a detecção informaram
/* v3.56 — opções da compactação, iguais às do mini-compress do Hermes (context.engine_options) */
export const THRESHOLD_K_PADRAO = 200; // milhares de tokens (200 = 200k; 0 = nunca)
export const TAIL_CHARS_CAP_PADRAO = 80_000; // parte C (20K tokens)
export const PAIRS_BLOCK_CAP_PADRAO = 40_000; // parte B (10K tokens)
export const SUMMARY_CHARS_CAP_PADRAO = 12_000; // parte A (3K tokens)
export const MAX_PAIRS_PADRAO = 8;
/* v3.2 — o que derruba uma conversa não é a resposta ser LONGA, é ela PARAR de vir.
   Modelo local escreve por minutos e isso é legítimo; o teto total antigo de 90s cortava no meio
   e o painel mostrava "The operation was aborted due to timeout" (visto em produção em 21/10).
   Agora: orçamento de SILÊNCIO (renova a cada pedaço) + teto total de segurança. */
export const SILENCIO_PADRAO_S = 180; // 3 minutos sem escrever nada = o provider morreu
export const TETO_TOTAL_MS = 20 * 60_000; // mesmo escrevendo sem parar, 20 min é exagero
export const TETO_FERRAMENTA = 6000; // caracteres de cada resultado de ferramenta que entra no payload

type Linha = {
  escopo: string;
  tipo: TipoProvider;
  base_url: string;
  modelo: string;
  chave: string;
  temperatura: number;
  system_prompt: string;
  mcp_interno: boolean;
  max_rodadas: number;
  memoria_turnos: number | null;
  verbatim_turnos: number | null;
  /* v3.56 — opções da compactação (mesmas chaves do mini-compress) */
  threshold_k: number | null;
  tail_chars_cap: number | null;
  pairs_block_cap: number | null;
  summary_chars_cap: number | null;
  max_pairs: number | null;
  reserva_tokens: number | null;
  contexto_tokens: number | null;
  contexto_detectado: number | null;
  silencio_s: number;
  ativo: boolean;
  atualizado_em: string;
};

export type CfgResolvida = {
  escopo: string;
  /** v3.19: nome do provedor escolhido (null = provider "padrão" da casa) */
  provedor: string | null;
  tipo: TipoProvider;
  base_url: string;
  modelo: string;
  chave: string;
  temperatura: number;
  system_prompt: string;
  mcp_interno: boolean;
  max_rodadas: number;
  memoria_turnos: number;
  verbatim_turnos: number;
  /** v3.56 — opções da compactação (da CONTA, como o system prompt) */
  comp: Opcoes;
  reserva_tokens: number;
  /** v3.2: segundos que o provider pode ficar sem escrever nada antes de eu desistir (0 = padrão) */
  silencio_s: number;
  /** janela efetiva em tokens (configurada > detectada > padrão) */
  janela: number;
  origem_janela: "configurada" | "detectada" | "padrao";
  ativo: boolean;
};

export function mascararChave(chave: string): string {
  if (!chave) return "";
  if (chave.length <= 4) return "••••";
  return `••••${chave.slice(-4)}`;
}

export async function initProvider(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS provider_config (
       escopo TEXT PRIMARY KEY,
       tipo TEXT NOT NULL DEFAULT 'litellm',
       base_url TEXT NOT NULL,
       modelo TEXT NOT NULL,
       chave TEXT NOT NULL DEFAULT '',
       temperatura DOUBLE PRECISION NOT NULL DEFAULT 0.2,
       system_prompt TEXT NOT NULL DEFAULT '',
       mcp_interno BOOLEAN NOT NULL DEFAULT false,
       max_rodadas INT NOT NULL DEFAULT ${RODADAS_PADRAO},
       ativo BOOLEAN NOT NULL DEFAULT true,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  /* a v2.7 tinha `trechos` para a busca automática; a v2.8 não busca por conta própria
     (ferramenta é o caminho). A coluna fica para não quebrar banco velho e deixa de ser lida. */
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS mcp_interno BOOLEAN NOT NULL DEFAULT false`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS max_rodadas INT NOT NULL DEFAULT ${RODADAS_PADRAO}`);
  /* v3.0: memória e orçamento de contexto. NULL = "não configurado" (usa o padrão do código);
     contexto_tokens/contexto_detectado ficam NULL até alguém configurar ou o teste de conexão detectar. */
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS memoria_turnos INT NOT NULL DEFAULT ${MEMORIA_PADRAO}`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS verbatim_turnos INT NOT NULL DEFAULT ${VERBATIM_PADRAO}`);
  /* v3.56 — compactação com a mecânica do mini-compress: gatilho + tetos por parte (A/B/C).
     São da CONTA (como o system prompt), não do provider: valem para qualquer modelo escolhido. */
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS threshold_k INT NOT NULL DEFAULT ${THRESHOLD_K_PADRAO}`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS tail_chars_cap INT NOT NULL DEFAULT ${TAIL_CHARS_CAP_PADRAO}`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS pairs_block_cap INT NOT NULL DEFAULT ${PAIRS_BLOCK_CAP_PADRAO}`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS summary_chars_cap INT NOT NULL DEFAULT ${SUMMARY_CHARS_CAP_PADRAO}`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS max_pairs INT NOT NULL DEFAULT ${MAX_PAIRS_PADRAO}`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS reserva_tokens INT NOT NULL DEFAULT ${RESERVA_PADRAO}`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS contexto_tokens INT`);
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS contexto_detectado INT`);
  /* v3.2: 0 = usa o padrão do código (180s de silêncio). É o único tempo que o operador pode ajustar:
     resposta longa que não para de escrever nunca é cortada antes do teto de 20 min. */
  await q(`ALTER TABLE provider_config ADD COLUMN IF NOT EXISTS silencio_s INT NOT NULL DEFAULT 0`);
  await q(
    `CREATE TABLE IF NOT EXISTS chat_mensagens (
       id BIGSERIAL PRIMARY KEY,
       tenant TEXT NOT NULL,
       memoria TEXT NOT NULL DEFAULT '',
       papel TEXT NOT NULL,
       texto TEXT NOT NULL,
       fontes JSONB,
       ferramentas JSONB,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS ferramentas JSONB`);
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS falas JSONB`);
  /* v3.13: raciocínio do modelo gravado junto da resposta (bloco "Pensou por Ns" ao reabrir) */
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS raciocinio TEXT`);
  /* v3.15: o rastro do turno na ordem real (o jeito do IA_GO): pensamento com o tempo dele,
     fala de caminho e ferramenta com o tempo dela. Gravado para a trilha sobreviver a
     reabrir a conversa — a string única de `raciocinio` não guarda essa ordem. */
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS rastro JSONB`);
  /* v3.18 (T018): quanto custou cada resposta — {tok_in, tok_out, ms, modelo}. A coluna
     `fontes` nasceu em 2.0 e nunca foi escrita: passa a viver na T004. */
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS custo JSONB`);
  /* v3.23: telas geradas pelo agente (HTML+CSS+JS) viajam com a resposta */
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS telas JSONB`);
  /* v3.44: print/arquivo vindo da máquina, reaberto junto com a conversa */
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS anexos JSONB`);
  await q(`CREATE INDEX IF NOT EXISTS chat_tenant_idx ON chat_mensagens (tenant, memoria, id)`);
  /* v3.35.1: o texto das regras da casa NÃO é mais injetado no boot. Antes, cada subida regravava
     as regras em todo campo vazio — quem apagasse as instruções ("conversa pura") as via voltar
     no próximo restart, sem ter salvo nada. `REGRAS_CASA` agora só serve de semente para o botão
     "restaurar instruções padrão" da tela; nenhum texto entra no campo por baixo. */
}

/** Janela de contexto efetiva: o que o operador digitou > o que a detecção achou > padrão. */
function planoDeJanela(l: Linha | null | undefined): { janela: number; origem_janela: "configurada" | "detectada" | "padrao" } {
  const configurada = Number(l?.contexto_tokens ?? 0);
  const detectada = Number(l?.contexto_detectado ?? 0);
  if (configurada > 0) return { janela: configurada, origem_janela: "configurada" };
  if (detectada > 0) return { janela: detectada, origem_janela: "detectada" };
  return { janela: JANELA_PADRAO, origem_janela: "padrao" };
}

/** v3.19: linha da tabela `provedores` → config pronta para o chat. */
function cfgDeProvedorLinha(l: Record<string, any> | undefined): CfgResolvida | null {
  if (!l || !l.ativo || !l.base_url || !l.modelo) return null;
  const tipo = l.tipo === "openai" ? "openai" : l.tipo === "ollama" ? "ollama" : "litellm";
  return {
    escopo: String(l.escopo),
    provedor: String(l.nome),
    tipo,
    base_url: String(l.base_url).replace(/\/+$/, ""),
    modelo: String(l.modelo),
    chave: String(l.chave ?? ""),
    temperatura: Number(l.temperatura ?? 0.2),
    system_prompt: String(l.system_prompt ?? ""),
    mcp_interno: Boolean(l.mcp_interno),
    max_rodadas: Number(l.max_rodadas ?? RODADAS_PADRAO),
    memoria_turnos: Number(l.memoria_turnos ?? MEMORIA_PADRAO),
    verbatim_turnos: Number(l.verbatim_turnos ?? VERBATIM_PADRAO),
    /* preenchido por resolverProvider com as opções da CONTA */
    comp: { ...OPCOES_PADRAO },
    reserva_tokens: Number(l.reserva_tokens ?? RESERVA_PADRAO),
    silencio_s: Number(l.silencio_s ?? 0),
    ...planoDeJanela(l as unknown as Linha),
    ativo: true,
  };
}

/** Config efetiva (ordem): provedor escolhido na hora › nomeado padrão › linha própria › global.
 *  Uma tela salva pela metade (sem modelo) não tapa mais o padrão de todos — defeito achado
 *  em 20/10 e corrigido aqui. Desligar a própria linha completa continua valendo. */
export async function resolverProvider(
  tenant: string,
  escolha?: { provedor?: string; modelo?: string },
): Promise<CfgResolvida | null> {
  /* v3.56 — a compactação é da CONTA (como as instruções): vale igual para provider
     nomeado, padrão da casa ou linha própria. */
  const comp = await lerOpcoesCompactacao(tenant);
  const nome = String(escolha?.provedor ?? "").trim();
  if (nome) {
    const r = await q<Linha>(
      `SELECT * FROM provedores WHERE escopo = ANY($1) AND (nome = $2 OR id::text = $2)
       ORDER BY (escopo = $3) DESC LIMIT 1`,
      [[tenant, GLOBAL], nome, tenant],
    );
    const l = r.rows[0];
    if (!l) throw erro422(`provedor "${nome}" não está cadastrado`);
    const cfg = cfgDeProvedorLinha(l);
    if (!cfg) throw erro409(`provedor "${nome}" está incompleto ou desligado`);
    const modelo = String(escolha?.modelo ?? "").trim();
    if (modelo && modelo !== cfg.modelo) {
      /* v3.19: com cache de modelos descoberto, só lista cadastrada ou cache — trocar
         para um modelo que o serviço não anuncia é erro de tela, não passagem livre. */
      const modelosLinha = (l as Record<string, any>).modelos;
      const cache = Array.isArray(modelosLinha) ? (modelosLinha as unknown[]).map(String) : [];
      if (cache.length && !cache.includes(modelo)) {
        throw erro422(`o provedor "${nome}" não anuncia o modelo "${modelo}" — descubra os modelos em Configurações`);
      }
      cfg.modelo = modelo;
    }
    cfg.comp = comp;
    return cfg;
  }
  /* v3.19: um nomeado marcado como "padrão" do escopo manda no provider_config */
  const pd = await q<Linha>(
    `SELECT * FROM provedores WHERE escopo = ANY($1) AND padrao = true AND ativo = true
     ORDER BY (escopo = $2) DESC LIMIT 1`,
    [[tenant, GLOBAL], tenant],
  );
  const viaPadrao = cfgDeProvedorLinha(pd.rows[0]);
  const modeloSolto = String(escolha?.modelo ?? "").trim();
  if (viaPadrao) {
    if (modeloSolto) viaPadrao.modelo = modeloSolto;
    viaPadrao.comp = comp;
    return viaPadrao;
  }
  const r = await q<Linha>(
    `SELECT * FROM provider_config
     WHERE escopo IN ($1, $2)
     ORDER BY (escopo = $1 AND base_url <> '' AND modelo <> '') DESC,
              (escopo = $2) DESC,
              (escopo = $1) DESC
     LIMIT 1`,
    [tenant, GLOBAL],
  );
  const l = r.rows[0];
  if (!l || !l.ativo || !l.base_url || !l.modelo) return null;
  return {
    escopo: l.escopo,
    provedor: null,
    tipo: l.tipo,
    base_url: l.base_url.replace(/\/+$/, ""),
    modelo: l.modelo,
    chave: l.chave,
    temperatura: Number(l.temperatura),
    system_prompt: l.system_prompt ?? "",
    mcp_interno: Boolean(l.mcp_interno),
    max_rodadas: Number(l.max_rodadas ?? RODADAS_PADRAO),
    memoria_turnos: Number(l.memoria_turnos ?? MEMORIA_PADRAO),
    verbatim_turnos: Number(l.verbatim_turnos ?? VERBATIM_PADRAO),
    comp,
    reserva_tokens: Number(l.reserva_tokens ?? RESERVA_PADRAO),
    silencio_s: Number(l.silencio_s ?? 0),
    ...planoDeJanela(l),
    ativo: l.ativo,
  };
}

/** v3.35 — instruções do modelo são da CONTA, não do modelo: o texto vale para qualquer
 *  provider escolhido na conversa. Mora na linha do ESCOPO em `provider_config` (a linha do
 *  provider nomeado não carrega prompt próprio). Linha própria, mesmo vazia, vence a global —
 *  apagar o campo é escolha de "conversa pura", não herança silenciosa. */
export async function lerInstrucoes(tenant: string): Promise<string> {
  const r = await q<{ escopo: string; system_prompt: string }>(
    `SELECT escopo, system_prompt FROM provider_config WHERE escopo IN ($1, $2)
     ORDER BY (escopo = $1) DESC LIMIT 1`,
    [tenant, GLOBAL],
  );
  return String(r.rows[0]?.system_prompt ?? "");
}

/** v3.56 — opções da compactação da CONTA (linha própria vence a global), com os
 *  mesmos nomes/faixas do mini-compress: threshold_k, protect_last_n, tail_chars_cap,
 *  pairs_block_cap, summary_chars_cap, max_pairs. */
export function opcoesDaLinha(l: Linha | null | undefined): Opcoes {
  if (!l) return { ...OPCOES_PADRAO };
  const n = (v: unknown, padrao: number): number => (Number.isFinite(Number(v)) ? Number(v) : padrao);
  return {
    thresholdK: n(l.threshold_k, OPCOES_PADRAO.thresholdK),
    protectLastN: n(l.verbatim_turnos, OPCOES_PADRAO.protectLastN),
    tailCharsCap: n(l.tail_chars_cap, OPCOES_PADRAO.tailCharsCap),
    pairsBlockCap: n(l.pairs_block_cap, OPCOES_PADRAO.pairsBlockCap),
    summaryCharsCap: n(l.summary_chars_cap, OPCOES_PADRAO.summaryCharsCap),
    maxPairs: n(l.max_pairs, OPCOES_PADRAO.maxPairs),
  };
}

export async function lerOpcoesCompactacao(tenant: string): Promise<Opcoes> {
  const r = await q<Linha>(
    `SELECT * FROM provider_config WHERE escopo IN ($1, $2)
     ORDER BY (escopo = $1) DESC LIMIT 1`,
    [tenant, GLOBAL],
  );
  return opcoesDaLinha(r.rows[0]);
}

/** Grava as instruções e o comportamento do agente (v3.55: rodadas, memória e intactas
 *  também são da CONTA — a tela os mostra junto do system prompt, não no formulário do provider). */
export async function salvarInstrucoes(
  user: Usuario,
  body: {
    texto?: unknown;
    tenant?: unknown;
    max_rodadas?: unknown;
    memoria_turnos?: unknown;
    verbatim_turnos?: unknown;
    threshold_k?: unknown;
    tail_chars_cap?: unknown;
    pairs_block_cap?: unknown;
    summary_chars_cap?: unknown;
    max_pairs?: unknown;
  },
): Promise<{
  escopo: string;
  system_prompt: string;
  tem_system_prompt: boolean;
  regras_padrao: string;
  max_rodadas: number;
  memoria_turnos: number;
  verbatim_turnos: number;
  comp: Opcoes;
}> {
  const escopo = tenantFor(user, typeof body.tenant === "string" ? body.tenant : null);
  const anterior = (await q<Linha>(`SELECT * FROM provider_config WHERE escopo = $1`, [escopo])).rows[0];
  /* texto ausente = preserva o que está gravado (a tela pode salvar só os números) */
  const texto = body.texto === undefined ? String(anterior?.system_prompt ?? "") : String(body.texto ?? "");
  if (texto.length > LIMITE_PROMPT) {
    throw erro422(`as instruções do modelo têm no máximo ${LIMITE_PROMPT} caracteres`);
  }
  /* mesmas faixas do salvarProvider: sem isso a tela aceitaria 999 rodadas e o agente rodaria solto */
  const inteiro = (v: unknown, antes: unknown, nome: string, min: number, max: number): number => {
    if (v === undefined || v === null || v === "") return Number(antes ?? 0);
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw erro422(`${nome} deve ser um número entre ${min} e ${max}`);
    return n;
  };
  const maxRodadas = body.max_rodadas === undefined
    ? Number(anterior?.max_rodadas ?? RODADAS_PADRAO)
    : Number(body.max_rodadas);
  if (!Number.isInteger(maxRodadas) || maxRodadas < 0 || maxRodadas > 60) {
    throw erro422("max_rodadas deve ser um número entre 0 e 60");
  }
  const memoriaTurnos = inteiro(body.memoria_turnos, anterior?.memoria_turnos ?? MEMORIA_PADRAO, "memoria_turnos", 0, 100);
  const verbatimTurnos = inteiro(body.verbatim_turnos, anterior?.verbatim_turnos ?? VERBATIM_PADRAO, "verbatim_turnos", 0, 50);
  /* v3.56 — opções da compactação, com as MESMAS faixas do mini-compress */
  const thresholdK = inteiro(body.threshold_k, anterior?.threshold_k ?? THRESHOLD_K_PADRAO, "threshold_k", 0, 2000);
  const tailCharsCap = inteiro(body.tail_chars_cap, anterior?.tail_chars_cap ?? TAIL_CHARS_CAP_PADRAO, "tail_chars_cap", 2000, 400000);
  const pairsBlockCap = inteiro(body.pairs_block_cap, anterior?.pairs_block_cap ?? PAIRS_BLOCK_CAP_PADRAO, "pairs_block_cap", 2000, 200000);
  const summaryCharsCap = inteiro(body.summary_chars_cap, anterior?.summary_chars_cap ?? SUMMARY_CHARS_CAP_PADRAO, "summary_chars_cap", 2000, 100000);
  const maxPairs = inteiro(body.max_pairs, anterior?.max_pairs ?? MAX_PAIRS_PADRAO, "max_pairs", 0, 20);
  await q(
    `INSERT INTO provider_config (escopo, base_url, modelo, system_prompt, max_rodadas, memoria_turnos, verbatim_turnos,
       threshold_k, tail_chars_cap, pairs_block_cap, summary_chars_cap, max_pairs)
     VALUES ($1, '', '', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (escopo) DO UPDATE SET system_prompt = EXCLUDED.system_prompt, max_rodadas = EXCLUDED.max_rodadas,
       memoria_turnos = EXCLUDED.memoria_turnos, verbatim_turnos = EXCLUDED.verbatim_turnos,
       threshold_k = EXCLUDED.threshold_k, tail_chars_cap = EXCLUDED.tail_chars_cap,
       pairs_block_cap = EXCLUDED.pairs_block_cap, summary_chars_cap = EXCLUDED.summary_chars_cap,
       max_pairs = EXCLUDED.max_pairs, atualizado_em = now()`,
    [escopo, texto, maxRodadas, memoriaTurnos, verbatimTurnos, thresholdK, tailCharsCap, pairsBlockCap, summaryCharsCap, maxPairs],
  );
  return {
    escopo,
    system_prompt: texto,
    tem_system_prompt: Boolean(texto.trim()),
    regras_padrao: REGRAS_CASA,
    max_rodadas: maxRodadas,
    memoria_turnos: memoriaTurnos,
    verbatim_turnos: verbatimTurnos,
    comp: {
      thresholdK,
      protectLastN: verbatimTurnos,
      tailCharsCap,
      pairsBlockCap,
      summaryCharsCap,
      maxPairs,
    },
  };
}

/** O que o painel pode ver: tudo menos a chave em claro. */
export async function verProvider(user: Usuario, tenantArg?: string | null) {
  const tenant = tenantFor(user, tenantArg);
  const propria = await q<Linha>(`SELECT * FROM provider_config WHERE escopo = $1`, [tenant]);
  const global = await q<Linha>(`SELECT * FROM provider_config WHERE escopo = $1`, [GLOBAL]);
  /* regra v2.8: a linha própria só vale completa (base_url E modelo) — igual ao chat.
     Linha própria pela metade não pode esconder do usuário o provider que está em uso. */
  const completa = (l?: Linha | null) => Boolean(l && l.base_url && l.modelo);
  const usaPropria = tenant !== GLOBAL && (completa(propria.rows[0]) || !global.rows[0]);
  const l = (usaPropria ? propria.rows[0] : global.rows[0]) ?? propria.rows[0] ?? global.rows[0] ?? null;
  const plano = planoDeJanela(l);
  /* v3.35: a instrução mostrada é a da CONTA (não a da linha que por acaso serve o chat) */
  const instrucoes = await lerInstrucoes(tenant);
  return {
    configurado: Boolean(l?.ativo && l?.base_url && l?.modelo),
    escopo: l?.escopo ?? null,
    origem: usaPropria && propria.rows[0] ? "propria" : global.rows[0] ? "global" : null,
    tem_global: Boolean(global.rows[0]),
    tipo: l?.tipo ?? "litellm",
    base_url: l?.base_url ?? "",
    modelo: l?.modelo ?? "",
    temperatura: l ? Number(l.temperatura) : 0.2,
    system_prompt: instrucoes,
    tem_system_prompt: Boolean(instrucoes.trim()),
    /** v3.34: o texto padrão da casa, para o botão "restaurar instruções padrão" da tela */
    regras_padrao: REGRAS_CASA,
    mcp_interno: Boolean(l?.mcp_interno ?? false),
    max_rodadas: l ? Number(l.max_rodadas ?? RODADAS_PADRAO) : RODADAS_PADRAO,
    memoria_turnos: l ? Number(l.memoria_turnos ?? MEMORIA_PADRAO) : MEMORIA_PADRAO,
    verbatim_turnos: l ? Number(l.verbatim_turnos ?? VERBATIM_PADRAO) : VERBATIM_PADRAO,
    /* v3.56 — compactação (é da CONTA, igual às instruções): lê com a MESMA precedência
       de `lerInstrucoes` (linha própria vence a global), não a linha que serve o provider */
    comp: await lerOpcoesCompactacao(tenant),
    reserva_tokens: l ? Number(l.reserva_tokens ?? RESERVA_PADRAO) : RESERVA_PADRAO,
    silencio_s: l ? Number(l.silencio_s ?? 0) : 0,
    silencio_efetivo_s: l && Number(l.silencio_s) > 0 ? Number(l.silencio_s) : SILENCIO_PADRAO_S,
    contexto_tokens: l?.contexto_tokens === null || l?.contexto_tokens === undefined ? null : Number(l.contexto_tokens),
    contexto_detectado: l?.contexto_detectado === null || l?.contexto_detectado === undefined ? null : Number(l.contexto_detectado),
    janela_efetiva: plano.janela,
    origem_janela: plano.origem_janela,
    ativo: Boolean(l?.ativo ?? false),
    tem_chave: Boolean(l?.chave),
    chave_mascarada: mascararChave(l?.chave ?? ""),
    atualizado_em: l?.atualizado_em ?? null,
  };
}

export async function salvarProvider(
  user: Usuario,
  body: {
    tipo?: unknown;
    base_url?: unknown;
    modelo?: unknown;
    chave?: unknown;
    temperatura?: unknown;
    system_prompt?: unknown;
    mcp_interno?: unknown;
    max_rodadas?: unknown;
    memoria_turnos?: unknown;
    verbatim_turnos?: unknown;
    reserva_tokens?: unknown;
    contexto_tokens?: unknown;
    silencio_s?: unknown;
    tenant?: unknown;
    ativo?: unknown;
    global?: unknown;
  },
) {
  const tipo: TipoProvider = body.tipo === "openai" ? "openai" : body.tipo === "ollama" ? "ollama" : "litellm";
  const baseUrl = String(body.base_url ?? "").trim().replace(/\/+$/, "");
  const modelo = String(body.modelo ?? "").trim();
  if (!baseUrl && body.ativo !== false) throw erro422("base_url é obrigatória");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw erro422("base_url deve começar com http:// ou https://");
  if (body.ativo !== false && !modelo) throw erro422("modelo é obrigatório");

  const usaGlobal = Boolean(body.global);
  if (usaGlobal && !user.operador) throw erro409("só o operador grava o padrão global");
  /* v3.0: a tela mostra o provider do cliente selecionado (GET ?tenant=...), entao o SALVAR tem que
     ir para o MESMO escopo. Antes o `tenant` do corpo era ignorado: instruções digitadas para um
     cliente eram gravadas na linha do operador e, ao reler o cliente, pareciam apagadas
     (reproduzido no container de teste em 20/10). tenantFor já protege: usuário comum não alcança
     tenant alheio nem aqui. */
  const escopo = usaGlobal ? GLOBAL : tenantFor(user, typeof body.tenant === "string" ? body.tenant : null);

  const anterior = await q<Linha>(`SELECT * FROM provider_config WHERE escopo = $1`, [escopo]);
  const linhaAnterior = anterior.rows[0];
  const chaveNova =
    body.chave === undefined || body.chave === null || body.chave === "***" ? linhaAnterior?.chave ?? "" : String(body.chave);

  const temperatura = body.temperatura === undefined ? 0.2 : Number(body.temperatura);
  if (!Number.isFinite(temperatura) || temperatura < 0 || temperatura > 1) {
    throw erro422("temperatura deve estar entre 0 e 1");
  }

  /* v3.34: sem regra embutida — provider novo sem instruções continua nascendo vazio (conversa
     pura). As regras da casa são o VALOR INICIAL do campo para quem já existia + o botão
     "restaurar instruções padrão"; quem apaga o campo escolhe conversa pura. */
  const systemPrompt =
    body.system_prompt === undefined ? linhaAnterior?.system_prompt ?? "" : String(body.system_prompt);
  if (systemPrompt.length > LIMITE_PROMPT) {
    throw erro422(`as instruções do modelo têm no máximo ${LIMITE_PROMPT} caracteres`);
  }

  if (body.mcp_interno !== undefined && typeof body.mcp_interno !== "boolean") {
    throw erro422("mcp_interno deve ser true ou false");
  }
  const mcpInterno = body.mcp_interno === undefined ? Boolean(linhaAnterior?.mcp_interno) : body.mcp_interno;

  const maxRodadas =
    body.max_rodadas === undefined ? Number(linhaAnterior?.max_rodadas ?? RODADAS_PADRAO) : Number(body.max_rodadas);
  if (!Number.isInteger(maxRodadas) || maxRodadas < 0 || maxRodadas > 60) {
    throw erro422("max_rodadas deve ser um número entre 0 e 60");
  }

  /* v3.0 — memória e orçamento. `contexto_tokens: 0` significa "deixa automático". */
  const inteiro = (v: unknown, anterior: unknown, nome: string, min: number, max: number): number => {
    if (v === undefined || v === null || v === "") return Number(anterior ?? 0);
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw erro422(`${nome} deve ser um número entre ${min} e ${max}`);
    return n;
  };
  const memoriaTurnos = inteiro(body.memoria_turnos, linhaAnterior?.memoria_turnos ?? MEMORIA_PADRAO, "memoria_turnos", 0, 100);
  const verbatimTurnos = inteiro(body.verbatim_turnos, linhaAnterior?.verbatim_turnos ?? VERBATIM_PADRAO, "verbatim_turnos", 0, 40);
  const reservaTokens = inteiro(body.reserva_tokens, linhaAnterior?.reserva_tokens ?? RESERVA_PADRAO, "reserva_tokens", 1, 200000);
  const contextoBruta = inteiro(body.contexto_tokens, linhaAnterior?.contexto_tokens ?? 0, "contexto_tokens", 0, 4000000);
  const contextoTokens = contextoBruta > 0 ? contextoBruta : null;
  /* v3.2: silêncio em segundos (0 = padrão do código). Não confundir com "tempo total da resposta":
     resposta que não para de escrever tem quanto tempo quiser. */
  const silencioS = inteiro(body.silencio_s, linhaAnterior?.silencio_s ?? 0, "silencio_s", 0, 1800);

  await q(
    `INSERT INTO provider_config (escopo, tipo, base_url, modelo, chave, temperatura, system_prompt, mcp_interno, max_rodadas,
       ativo, memoria_turnos, verbatim_turnos, reserva_tokens, contexto_tokens, silencio_s, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
     ON CONFLICT (escopo) DO UPDATE SET
       tipo = EXCLUDED.tipo, base_url = EXCLUDED.base_url, modelo = EXCLUDED.modelo,
       chave = EXCLUDED.chave, temperatura = EXCLUDED.temperatura,
       system_prompt = EXCLUDED.system_prompt, mcp_interno = EXCLUDED.mcp_interno,
       max_rodadas = EXCLUDED.max_rodadas, ativo = EXCLUDED.ativo,
       memoria_turnos = EXCLUDED.memoria_turnos, verbatim_turnos = EXCLUDED.verbatim_turnos,
       reserva_tokens = EXCLUDED.reserva_tokens, contexto_tokens = EXCLUDED.contexto_tokens,
       silencio_s = EXCLUDED.silencio_s,
       atualizado_em = now()`,
    [
      escopo, tipo, baseUrl, modelo, chaveNova, temperatura, systemPrompt, mcpInterno, maxRodadas,
      body.ativo !== false, memoriaTurnos, verbatimTurnos, reservaTokens, contextoTokens, silencioS,
    ],
  );
  /* devolve a linha que foi escrita (antes, salvar o global mostrava a própria e parecia "não configurado") */
  /* devolve a linha que FOI ESCRITA (escopo), não a do usuário: a tela recarrega o mesmo alvo
     que gravou, senão o texto salvo parece sumir quando o painel está num cliente selecionado. */
  return verProvider(user, escopo);
}

type ChamadaTool = { id: string; type: "function"; function: { name: string; arguments: string } };
type Mensagem = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChamadaTool[];
  tool_call_id?: string;
};

/** Sinal de abort que vence no SILÊNCIO, não na duração total: renova a cada pedaço que chega.
 *  Assim um modelo local que escreve devagar por 6 minutos conversa normal, e um provider morto
 *  é cortado cedo com nome na etiqueta (antes morriam ambos com a mesma mensagem crua do fetch). */
function vigiaSilencio(silencioMs: number, tetoMs: number) {
  const ctrl = new AbortController();
  const inicio = Date.now();
  let porque = "";
  let t: ReturnType<typeof setTimeout> | undefined;
  const armar = (): void => {
    if (t) clearTimeout(t);
    const resto = tetoMs - (Date.now() - inicio);
    if (resto <= 0) {
      porque = `nao terminou em ${Math.round(tetoMs / 60000)} min`;
      ctrl.abort();
      return;
    }
    t = setTimeout(() => {
      porque = `ficou sem mandar nada por ${Math.round(silencioMs / 1000)}s`;
      ctrl.abort();
    }, Math.min(silencioMs, resto));
    /* unref: se a deriva sair por um caminho de erro, este relógio não segura o processo vivo */
    t.unref?.();
  };
  armar();
  return {
    signal: ctrl.signal,
    renovar: armar,
    fechar: (): void => {
      if (t) clearTimeout(t);
    },
    /** motivo do meu próprio abort ("" quando quem abortou foi outra coisa) */
    porque: (): string => porque,
    /** v3.18 (T001): cancelamento humano — aborta e marca o motivo como "cancelado",
       distinguindo "usuário parou" de "rede caiu" nos três pontos de queda do stream */
    cancelar: (): void => {
      porque = "cancelado";
      ctrl.abort();
    },
    silencioMs,
  };
}

/** Erro de rede/abort vira frase que o humano entende; o motivo técnico nunca some do log. */
function etiquetaQueda(e: unknown, vigia: { porque(): string; silencioMs: number }, fallback: string): string {
  if (vigia.porque()) return vigia.porque();
  const nome = (e as Error)?.name ?? "";
  if (nome === "TimeoutError" || nome === "AbortError") return `não respondeu em ${Math.round(vigia.silencioMs / 1000)}s`;
  return (e as Error)?.message || fallback;
}

/** Lê um pedaço do corpo do provider. Se a queda foi minha (silêncio/teto), a etiqueta é minha:
 *  sem isso o abort estourava no meio do stream e o painel mostrava a frase crua do fetch —
 *  foi exatamente o "The operation was aborted due to timeout" reportado em 21/10. */
async function lerPedaco<T>(
  leitor: { read(): Promise<T> },
  vigia: ReturnType<typeof vigiaSilencio>,
): Promise<T> {
  try {
    const p = await leitor.read();
    vigia.renovar();
    return p;
  } catch (e) {
    if (vigia.porque() === "cancelado") throw new Error("cancelado-pelo-usuario");
    throw erro422(`a resposta do provider parou: ${etiquetaQueda(e, vigia, "a conexão caiu no meio")}`);
  }
}

/** Chama o provider (OpenAI-compatível) sem streaming; devolve a mensagem crua para ver tool_calls. */
/** v3.41 — a última mensagem do usuário vira partes [texto, imagens...]; as demais seguem
 *  string. Só o payload ENVIADO muda: o que fica gravado, compactado e contado em tokens
 *  continua texto, então memória/compactação não precisam saber que existe imagem. */
function comVisao(
  mensagens: Mensagem[],
  visao?: { mime: string; base64: string }[],
): unknown[] {
  if (!visao?.length) return mensagens;
  let ultimo = -1;
  for (let k = mensagens.length - 1; k >= 0; k--) {
    if (mensagens[k].role === "user") { ultimo = k; break; }
  }
  if (ultimo < 0) return mensagens;
  return mensagens.map((m, k) =>
    k === ultimo
      ? {
          ...m,
          content: [
            { type: "text", text: m.content },
            ...visao.map((v) => ({
              type: "image_url",
              image_url: { url: `data:${v.mime};base64,${v.base64}` },
            })),
          ],
        }
      : m,
  );
}

export async function chamarModelo(
  cfg: { base_url: string; modelo: string; chave: string; temperatura: number; tipo: TipoProvider; silencio_s?: number },
  mensagens: Mensagem[],
  opts: {
    tools?: unknown[];
    timeoutMs?: number;
    tetoMs?: number;
    stream?: boolean;
    onDelta?: (t: string) => void;
    /** pedaços do raciocínio do modelo (reasoning_content/thinking) — o chat mostra ao vivo */
    onRaciocinio?: (t: string) => void;
    /** v3.24: pedaço dos ARGUMENTOS de uma chamada de ferramenta, como o provider mandou.
       É por aqui que o código da tela aparece sendo digitado no chat. */
    onArgs?: (indice: number, nome: string, pedaco: string) => void;
    /** v3.18 (T001): sinal externo ("parar" do usuário). Abortado: o erro lançado é
       exatamente "cancelado-pelo-usuario" — quem chama preserva o parcial e não grava falha. */
    sinal?: AbortSignal;
    /** v3.41: imagens anexadas no chat (data URL no formato OpenAI). Só a ÚLTIMA mensagem
       do usuário recebe o array de partes; o histórico continua texto puro, para a
       compactação e a memória não terem de entender imagem. */
    visao?: { mime: string; base64: string }[];
  } = {},
): Promise<{
  message: { role: "assistant"; content: string; tool_calls?: ChamadaTool[] };
  texto: string;
  /** tudo que o modelo pensou nesta rodada (vazio nos modelos que não expõem) */
  pensamento: string;
  ms: number;
}> {
  /* v3.2: `timeoutMs` deixou de ser "tempo total da resposta" e virou ORÇAMENTO DE SILÊNCIO.
     O valor da tela (provider_config.silencio_s) manda em cima do padrão do código. */
  const silencioMs =
    Number(cfg.silencio_s) > 0 ? Number(cfg.silencio_s) * 1000 : opts.timeoutMs ?? SILENCIO_PADRAO_S * 1000;
  const vigia = vigiaSilencio(silencioMs, opts.tetoMs ?? TETO_TOTAL_MS);
  if (opts.sinal) {
    if (opts.sinal.aborted) throw new Error("cancelado-pelo-usuario");
    opts.sinal.addEventListener("abort", () => vigia.cancelar(), { once: true });
  }
  const inicio = Date.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.chave) headers.authorization = "B" + "earer " + cfg.chave;
  const corpo: Record<string, unknown> = {
    model: cfg.modelo,
    messages: comVisao(mensagens, opts.visao),
    temperature: cfg.temperatura,
    stream: Boolean(opts.stream && opts.onDelta),
  };
  if (opts.tools?.length) corpo.tools = opts.tools;
  let r: Response;
  try {
    r = await fetch(`${cfg.base_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(corpo),
      signal: vigia.signal,
    });
  } catch (e) {
    if (vigia.porque() === "cancelado") throw new Error("cancelado-pelo-usuario");
    throw erro422(`nao consegui falar com o provider: ${etiquetaQueda(e, vigia, "sem conexão com o provider")}`);
  }
  if (!r.ok) {
    const corpoErro = await r.text().catch(() => "");
    throw erro422(`provider respondeu ${r.status}: ${corpoErro.slice(0, 200)}`);
  }

  /* caminho com streaming: SSE (`data: {...}` linha a linha) */
  const tipoConteudo = r.headers.get("content-type") ?? "";
  if (corpo.stream && tipoConteudo.includes("event-stream") && r.body) {
    const pecas: string[] = [];
    const pensado: string[] = [];
    const chamadas: Record<number, { id: string; nome: string; args: string }> = {};
    const leitor = r.body.getReader();
    const dec = new TextDecoder();
    let sobra = "";
    for (;;) {
      const { done, value } = await lerPedaco(leitor, vigia);
      if (done) break;
      sobra += dec.decode(value, { stream: true });
      const partes = sobra.split("\n");
      sobra = partes.pop() ?? "";
      for (const linha of partes) {
        const dados = linha.startsWith("data:") ? linha.slice(5).trim() : "";
        if (!dados || dados === "[DONE]") continue;
        let j: any;
        try {
          j = JSON.parse(dados);
        } catch {
          continue; /* comentário de manutenção de conexão */
        }
        const delta = j?.choices?.[0]?.delta ?? {};
        /* raciocínio do modelo (v3.13): os três nomes que os providers usam para o mesmo campo */
        const pens =
          typeof delta.reasoning_content === "string" ? delta.reasoning_content
          : typeof delta.reasoning === "string" ? delta.reasoning
          : typeof delta.thinking === "string" ? delta.thinking
          : "";
        if (pens) {
          pensado.push(pens);
          opts.onRaciocinio?.(pens);
        }
        if (typeof delta.content === "string" && delta.content) {
          pecas.push(delta.content);
          opts.onDelta?.(delta.content);
        }
        for (const c of delta.tool_calls ?? []) {
          const k = Number(c.index ?? 0);
          const alvo = (chamadas[k] ??= { id: "", nome: "", args: "" });
          if (c.id) alvo.id = c.id;
          if (c.function?.name) alvo.nome += c.function.name;
          if (c.function?.arguments) {
            alvo.args += c.function.arguments;
            /* v3.24: o pedaço cru também vai para quem quiser mostrar o código nascendo */
            opts.onArgs?.(k, alvo.nome, c.function.arguments);
          }
        }
      }
    }
    const texto = pecas.join("");
    vigia.fechar();
    const toolCalls: ChamadaTool[] = Object.values(chamadas)
      .filter((c) => c.nome)
      .map((c, n) => ({ id: c.id || `call_${Date.now()}_${n}`, type: "function", function: { name: c.nome, arguments: c.args || "{}" } }));
    if (!texto && !toolCalls.length) throw erro422("provider respondeu sem texto e sem chamada de ferramenta");
    return {
      message: { role: "assistant", content: texto, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      texto: texto.trim(),
      pensamento: pensado.join("").trim(),
      ms: Date.now() - inicio,
    };
  }

  /* sem streaming: o corpo chega inteiro de uma vez; silêncio aqui é modelo travado no meio do caminho */
  let texto: string;
  try {
    texto = await r.text();
  } catch (e) {
    if (vigia.porque() === "cancelado") throw new Error("cancelado-pelo-usuario");
    throw erro422(`a resposta do provider parou: ${etiquetaQueda(e, vigia, "o corpo da resposta não chegou")}`);
  } finally {
    vigia.fechar();
  }
  let json: any;
  try {
    json = JSON.parse(texto);
  } catch {
    throw erro422(`resposta do provider nao e JSON: ${texto.slice(0, 120)}`);
  }
  const mensagem = json?.choices?.[0]?.message ?? json?.message ?? {};
  const conteudo = typeof mensagem.content === "string" ? mensagem.content : "";
  const toolCalls = Array.isArray(mensagem.tool_calls) ? (mensagem.tool_calls as ChamadaTool[]) : undefined;
  if (!conteudo && !toolCalls?.length) throw erro422("provider respondeu sem texto e sem chamada de ferramenta");
  return {
    message: { role: "assistant", content: conteudo, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    texto: conteudo.trim(),
    pensamento: String(mensagem.reasoning_content ?? mensagem.reasoning ?? mensagem.thinking ?? "").trim(),
    ms: Date.now() - inicio,
  };
}

/** Botão "testar conexão": usa o que veio na tela, com a chave salva quando vier mascarada. */
export async function testarProvider(user: Usuario, body: Record<string, unknown>) {
  const escopoAlvo = body.global ? GLOBAL : tenantFor(user, typeof body.tenant === "string" ? body.tenant : null);
  const atual = await resolverProvider(escopoAlvo);
  const base = String(body.base_url ?? atual?.base_url ?? "").trim().replace(/\/+$/, "");
  const modelo = String(body.modelo ?? atual?.modelo ?? "").trim();
  const chaveBruta = body.chave === undefined || body.chave === null || body.chave === "***" ? "" : String(body.chave);
  const chave = chaveBruta || atual?.chave || "";
  if (!base) throw erro422("informe a URL base antes de testar");
  if (!modelo) throw erro422("informe o modelo antes de testar");
  const tipo: TipoProvider = body.tipo === "openai" ? "openai" : body.tipo === "ollama" ? "ollama" : "litellm";
  const r = await chamarModelo(
    { base_url: base, modelo, chave, temperatura: 0, tipo },
    [
      { role: "system", content: "responda apenas: ok" },
      { role: "user", content: "teste de conexao" },
    ],
    { timeoutMs: 20_000, tetoMs: 60_000 },
  );
  /* v3.0: aproveita a conexão que acabou de funcionar e pergunta a janela do modelo.
     Detecção é conveniência, não requisito: a tela também aceita número digitado, e nada aqui
     pode derrubar o teste de conexão. */
  let contexto_detectado: number | null = null;
  try {
    const m = await fetch(`${base}/models`, {
      headers: { ...(chave ? { authorization: `Bearer ${chave}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (m.ok) {
      const lista: any = await m.json().catch(() => null);
      const itens = Array.isArray(lista?.data) ? lista.data : Array.isArray(lista?.models) ? lista.models : [];
      const escolhido = itens.find((x: any) => String(x?.id ?? x?.name ?? x?.model ?? "") === modelo) ?? itens[0];
      const bruto = Number(escolhido?.context_length ?? escolhido?.max_model_len ?? escolhido?.n_ctx ?? 0);
      if (Number.isFinite(bruto) && bruto >= 128) {
        contexto_detectado = Math.floor(bruto);
        /* grava na linha testada, sem nunca amassar o número que o humano digitou */
        await q(
          `UPDATE provider_config SET contexto_detectado = $2, atualizado_em = now()
           WHERE escopo = $1 AND (contexto_tokens IS NULL OR contexto_tokens = 0)`,
          [escopoAlvo, contexto_detectado],
        );
      }
    }
  } catch {
    /* provider sem /models: segue sem detecção */
  }
  return { ok: true, ms: r.ms, modelo, resposta: r.texto.slice(0, 120), contexto_detectado };
}

/* ------------------------------------------------------------------- chat */

/** v3.15 — segmento do RASTRO DO TURNO, na ordem em que aconteceu (o jeito do IA_GO):
 *  pensamento com o tempo dele, fala de caminho, ferramenta com o tempo dela. A resposta
 *  final NÃO entra aqui: ela é a própria bolha. */
export type SegmentoRastro =
  /** `em` (v3.34): ms desde o começo do turno em que o passo ACONTECEU — a tela ordena por ele,
   *  nunca pela ordem de chegada (é o que garante a trilha cronológica ao vivo e ao reabrir). */
  | { tipo: "pensamento"; texto: string; ms: number; em?: number }
  | { tipo: "narracao"; texto: string; em?: number }
  | { tipo: "ferramenta"; servidor: string; nome: string; ok: boolean; ms: number; em?: number }
  /** v3.43: a pessoa falou no MEIO do turno — entra na trilha na posição em que chegou,
   *  para a interrupção não virar um balão solto depois da resposta. */
  | { tipo: "interrupcao"; texto: string; em?: number };

/** Evento do chat com streaming (rota /chat/stream). */
export type EventoChat =
  | { tipo: "delta"; texto: string }
  /** v3.13: pedaço do raciocínio do modelo (estilo Open WebUI) — mostrado ao vivo, recolhido no fim */
  | { tipo: "raciocinio"; texto: string }
  | { tipo: "descartar" }
  /** v3.34: a ferramenta COMEÇOU (linha viva "Consultando X… Ns" enquanto ela roda) */
  | { tipo: "ferramenta_inicio"; nome: string }
  | { tipo: "ferramenta"; servidor: string; nome: string; ok: boolean; ms: number }
  | { tipo: "fala"; texto: string }
  /** v3.42: a pessoa falou no MEIO do turno — a tela mostra que o ajuste foi encaixado */
  | { tipo: "steer"; texto: string }
  /** v3.23: tela gerada (HTML+CSS+JS) — o card com preview funcional aparece ao vivo */
  | { tipo: "tela"; tela: Tela }
  /** v3.44: print/arquivo que a máquina mandou — entra na conversa ao vivo */
  | { tipo: "anexo"; anexo: AnexoMeta }
  /** v3.24: código da tela sendo ESCRITO (pedaço do HTML ainda em construção) */
  | { tipo: "codigo"; texto: string }
  | { tipo: "fim"; dados: Record<string, unknown> }
  | { tipo: "erro"; detalhe: string };

/** Conversa com o provider. Ele tem as ferramentas do MCP ligado; sem nada ligado, conversa pura.
 *  `emitir` (opcional) liga o modo streaming: o texto chega em pedaços, conforme o modelo escreve. */
/* ---- raciocínio que vaza pelo `content` (medido 20/10 com modelo local) ----
 * Alguns modelos de chat local (llama.cpp, vLLM com template de raciocínio) escrevem
 * o pensamento DENTRO de `message.content` antes de chamar a ferramenta — e ainda
 * repetem o mesmo texto em `reasoning_content`/`thinking`. Aquilo não é resposta:
 * se a rodada pediu ferramenta, o texto dela é rascunho. */
const MARCA_PENSO = /^(thinking|thought|reasoning|analysis|reflex[\u00e3a]o|racioc[\u00edi]nio|vou |deixa eu |primeiro |agora vou)/i;
const LIMITE_RASCUNHO = 160;

/* v3.35 — a NARRAÇÃO nasce dentro do rastro. O texto do começo da rodada fica RETIDO: se a
 * rodada pedir ferramenta, ele é narração e entra na trilha sem nunca ter aparecido na bolha.
 * Narração é uma frase de até 12 palavras; o que passar do limite (ou demorar demais sem pedir
 * ferramenta) é resposta e passa a fluir normalmente. */
const LIMITE_RETIDO = 140;
const ESPERA_RETIDO_MS = 1200;

/** o texto desta rodada é rascunho de raciocínio? (com ferramenta na mesa, bloco longo também) */
function textoDeRaciocinio(texto: string, pedindoFerramenta: boolean): boolean {
  const t = String(texto ?? "").trim();
  if (!t) return false;
  if (MARCA_PENSO.test(t)) return true;
  return pedindoFerramenta && (t.length > LIMITE_RASCUNHO || t.split("\n").length > 1);
}

/** último resultado de ferramenta disponível no histórico (usado quando o modelo trava) */
function ultimoResultadoTool(mensagens: Mensagem[]): string {
  for (let k = mensagens.length - 1; k >= 0; k--) {
    if (mensagens[k].role === "tool") return String(mensagens[k].content ?? "");
  }
  return "";
}

/** as últimas mensagens gravadas desta gaveta, no formato que o modelo lê (v3.0) */
async function mensagensDoHistorico(tenant: string, memoria: string, turnos: number): Promise<MsgChat[]> {
  /* a gaveta PADRAO e string vazia: comprimir `!memoria` desligava a conversa justamente nela */
  if (turnos <= 0) return [];
  const r = await q<{ papel: string; texto: string }>(
    `SELECT papel, texto FROM chat_mensagens
     WHERE tenant = $1 AND memoria = $2 ORDER BY id DESC LIMIT $3`,
    [tenant, memoria, Math.min(turnos, 100)],
  );
  return r.rows
    .reverse()
    .map((m: any) => ({ role: m.papel === "user" ? "user" : "assistant", content: String(m.texto ?? "") })) as MsgChat[];
}

const MIMES_VISAO = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMG_BYTES = 4 * 1024 * 1024;
const MAX_IMGS_TURNO = 3;

/** v3.41 — valida o que a tela colou: 3 imagens, 4MB cada, só o que o provider lê.
 *  Aceita com ou sem o prefixo `data:image/...;base64,` (o front manda cru). */
function validarImagens(entrada: unknown): { mime: string; base64: string }[] {
  if (!Array.isArray(entrada) || entrada.length === 0) return [];
  if (entrada.length > MAX_IMGS_TURNO)
    throw erro422(`no máximo ${MAX_IMGS_TURNO} imagens por mensagem (vieram ${entrada.length})`);
  return entrada.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const mime = String(o.mime ?? "").toLowerCase().trim();
    const b64 = String(o.base64 ?? "").replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
    if (!MIMES_VISAO.has(mime))
      throw erro422(`imagem ${i + 1}: formato ${mime || "?"} não aceito (png, jpeg ou webp)`);
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64))
      throw erro422(`imagem ${i + 1}: base64 inválido`);
    const bytes = Math.floor((b64.length * 3) / 4);
    if (bytes > MAX_IMG_BYTES)
      throw erro422(`imagem ${i + 1}: ${(bytes / 1024 / 1024).toFixed(1)}MB passa do teto de 4MB`);
    return { mime, base64: b64 };
  });
}

export async function responderChat(
  user: Usuario,
  body: {
    pergunta: string; memoria?: string; tenant?: string | null; provedor?: string; modelo?: string;
    /** v3.41: imagens coladas/coladas no chat (base64 puro, sem o prefixo data:) */
    imagens?: { mime: string; base64: string }[];
    /** v3.46: arquivos JÁ no servidor (upado pelo navegador em blocos) — só id/nome */
    anexos?: { id: string; nome?: string; bytes?: number }[];
  },
  emitir?: (e: EventoChat) => void,
  /** v3.18 (T001): sinal de cancelamento da tarefa (botão "parar")
   *  v3.42: `falas` entrega o que a pessoa mandou no meio — drenado a cada rodada */
  opts: { sinal?: AbortSignal; falas?: () => string[] } = {},
) {
  const pergunta = body.pergunta.trim();
  /* v3.41 — imagem colada no chat: vai como parte do turno, não como documento. */
  const imagens = validarImagens(body.imagens);
  /* v3.46: o arquivo grande não entra no prompt — fica no servidor e o modelo recebe
     o id. É esse id que a ferramenta enviar_para_maquina usa. `abrirAnexo` valida dono. */
  const anexosDoUsuario: AnexoMeta[] = [];
  for (const a of (body.anexos ?? []).slice(0, 10)) {
    const id = String(a?.id ?? "").slice(0, 64);
    if (!id) continue;
    try {
      const f = await abrirAnexo(id, user);
      anexosDoUsuario.push({ id, nome: f.nome, mime: f.mime, bytes: f.bytes });
    } catch {
      /* id inexistente ou de outro usuário: fica de fora, sem derrubar o turno */
    }
  }
  const tenant = tenantFor(user, body.tenant ?? null);
  const memoria = (body.memoria ?? "").trim();
  /* v3.19: o usuário pode escolher o provedor (e o modelo) na hora da conversa */
  const cfg = await resolverProvider(tenant, { provedor: body.provedor, modelo: body.modelo });
  if (!cfg) {
    throw erro409(
      "chat desligado: configure um provider em Configurações (tipo, URL, modelo e chave). A Busca continua funcionando.",
    );
  }
  /* v3.35 — a instrução é da CONTA, não do modelo: vale para o provider nomeado escolhido na
     conversa tanto quanto para o padrão da casa (antes, escolher um nomeado zerava as regras). */
  cfg.system_prompt = await lerInstrucoes(tenant);

  const pacote = await pacoteDeFerramentas(cfg.mcp_interno, { tenant, operador: user.operador });
  const toolsTokens = custoDoPayload([], pacote.specs.length ? pacote.specs : undefined);

  /* v3.0 — memória + orçamento. A conversa anterior volta para o modelo (por gaveta), e o payload
     INTEIRO é cortado para caber na janela. A compactação é regra determinística, sem LLM e sem
     custo: mensagem antiga vira linha curta, a cauda fica verbatim, resultado de ferramenta velho
     é aparado antes de qualquer descarte, e o que ainda não couber cai do mais antigo — avisando
     quantas foram, porque "sumiu sem dizer" é pior que sumir.
     Regra v2.8 mantida: nenhuma instrução embutida — system prompt vazio = modelo conversa puro. */
  const historico = await mensagensDoHistorico(tenant, memoria, cfg.memoria_turnos);
  const plano = montarPayload({
    system: cfg.system_prompt,
    historico,
    pergunta,
    toolsTokens,
    janela: cfg.janela,
    reserva: cfg.reserva_tokens,
    opcoes: cfg.comp,
  });
  const mensagens: Mensagem[] = plano.mensagens as Mensagem[];
  /* v3.46: a nota vai só para o que o MODELO lê; `pergunta` continua limpa para a
     busca e para o histórico (prefixo em pergunta envenenaria o embedding) */
  if (anexosDoUsuario.length > 0) {
    const nota =
      "\n\n[Arquivos que a pessoa anexou nesta mensagem — já estão no servidor]\n" +
      anexosDoUsuario
        .map((a) => `- ${a.nome} — id: ${a.id} (${(a.bytes / 1048576).toFixed(1)} MB)`)
        .join("\n") +
      "\n[Para levar um deles a uma máquina, chame enviar_para_maquina com esse id.]";
    const ultima = [...mensagens].reverse().find((m) => m.role === "user");
    if (ultima) ultima.content = String(ultima.content ?? "") + nota;
  }
  const compactacao = {
    memoria_turnos: cfg.memoria_turnos,
    historico_lido: historico.length,
    /* v3.56: a compactação só age no gatilho (min(threshold_k, 90% da janela)) */
    compactou: plano.compactou,
    gatilho: plano.gatilho,
    resumidas: plano.resumidas,
    pares: plano.pares,
    aparadas: plano.cortadas,
    descartadas: plano.descartadas,
    tokens: plano.tokens,
    disponivel: plano.disponivel,
    janela: cfg.janela,
    origem_janela: cfg.origem_janela,
    coube: plano.coube,
  };

  const chamadas: ChamadaFerramenta[] = [];
  /* v3.23: telas geradas neste turno (viram cards no chat e ficam gravadas na mensagem) */
  const telas: Tela[] = [];
  /* v3.44: arquivos que as ferramentas trouxeram neste turno (print de tela, anexo) */
  const anexos: AnexoMeta[] = [];
  const falas: string[] = []; // v3.8: as falas de caminho da rodada ficam na tela (e na gaveta)
  /* v3.15: a trilha do turno na ordem real. O bloco de pensamento da rodada em curso fecha
     quando a rodada decide (fala, chama ferramenta ou responde) — assim o tempo dele NÃO
     carrega o tempo da ferramenta, que é linha separada. */
  const rastro: SegmentoRastro[] = [];
  /* v3.24 — o código da tela nasce na tela. Cada chamada de ferramenta acumula os argumentos
     crus; se for a ferramenta de tela, o campo `html` já desescapado é emitido em pedaços
     (só o que ainda não foi mostrado). O dono pediu: "quero ver o streaming digitando o código". */
  const parciais = new Map<number, { nome: string; bruto: string; emitido: number }>();
  /* v3.34: o relógio do turno começa AQUI — cada linha do rastro grava `em` (ms desde este
     instante) para a tela poder ordenar a trilha pelo que aconteceu, não pela chegada. */
  const inicio = Date.now();
  const decorrido = (de = Date.now()): number => Math.max(0, de - inicio);
  let bloco: { texto: string; inicio: number } | null = null;
  const fecharBloco = (): void => {
    if (!bloco) return;
    const texto = bloco.texto.trim();
    const ms = Math.max(0, Date.now() - bloco.inicio);
    if (texto) rastro.push({ tipo: "pensamento", texto, ms, em: decorrido(bloco.inicio) });
    bloco = null;
  };
  /* v3.13: o raciocínio do modelo (reasoning_content/thinking) vai para a tela AO VIVO e
     fica gravado na mensagem — o Open WebUI faz assim ("Thinking…" → "Thought for Ns"). */
  let pensamento = "";
  let texto = "";
  /** v3.42: trechos já fechados quando uma fala no meio obrigou mais uma rodada */
  const partes: string[] = [];
  let rodadas = 0;
  let aviso: string | null = null;
  /* v3.18: `emitido` é o texto JÁ MOSTRADO da rodada em curso (zera a cada rodada com
     ferramenta, porque rascunho de rodada não é resposta) — é o que sobrevive ao "parar".
     `fontes` (T004): nomes de documento que a ferramenta de busca devolveu nesta resposta. */
  let emitido = "";
  /* v3.35: `retido` é o começo da rodada que ainda não foi para a tela — pode virar narração
     (vai para o rastro) ou resposta (é liberado e passa a fluir). `liberado` fecha a decisão. */
  let retido = "";
  let retidoInicio = 0;
  let liberado = false;
  const fontes = new Set<string>();
  /* embrulho único da saída: caminho normal e caminho cancelado dizem a mesma coisa */
  const empacotar = (respostaTexto: string, avisoTexto: string | null, cancelada: boolean) => ({
    resposta: respostaTexto,
    cancelada,
    fontes: [...fontes],
    ferramentas: chamadas,
    falas,
    rastro,
    /* v3.23: telas geradas neste turno (o card do chat) */
    telas,
    /* v3.44: arquivos/prints que as ferramentas trouxeram */
    anexos,
    /** v3.13: raciocínio do modelo, para a tela recolher "Pensou por Ns" ao reabrir a conversa */
    raciocinio: pensamento.trim(),
    rodadas,
    modelo: cfg.modelo,
    provider: cfg.escopo,
    /* v3.19: qual provedor nomeado respondeu (null = padrão da casa) */
    provedor: cfg.provedor,
    mcp_interno: cfg.mcp_interno,
    ferramentas_ligadas: pacote.specs.length,
    servidores: { interno: cfg.mcp_interno, externos: pacote.externos },
    tem_system_prompt: Boolean(cfg.system_prompt.trim()),
    compactacao,
    ms: Date.now() - inicio,
    /** v3.18 (T018): tokens de entrada (conta do plano de contexto) e de saída (resposta) */
    custo: { tok_in: compactacao.tokens, tok_out: custoDoPayload([{ content: respostaTexto }]) },
    aviso: avisoTexto,
  });

  try {
  for (;;) {
    if (opts.sinal?.aborted) throw new Error("cancelado-pelo-usuario");
    emitido = "";
    retido = "";
    retidoInicio = 0;
    liberado = false;
    parciais.clear(); /* v3.24: argumentos são por rodada — índice 0 de uma rodada ≠ da outra */
    rodadas++;
    /* v3.42 — fala no meio do turno: injeta ANTES de o modelo pensar nesta rodada */
    const chegadas = opts.falas?.() ?? [];
    for (const fala of chegadas) {
      mensagens.push({
        role: "user",
        content: `(a pessoa falou enquanto você trabalhava — leve isto em conta e ajuste a resposta) ${fala}`,
      });
      rastro.push({ tipo: "interrupcao", texto: fala, em: Date.now() - inicio });
      emitir?.({ tipo: "steer", texto: fala });
    }
    const usaFerramentas = pacote.specs.length > 0 && cfg.max_rodadas > 0;
    let saiuTexto = false;
    /* cada rodada coloca mais um resultado de ferramenta no payload: aperta ANTES de chamar */
    if (rodadas > 1) {
      const apertado = apertarRodada(mensagens as MsgChat[], {
        janela: cfg.janela,
        reserva: cfg.reserva_tokens,
        toolsTokens,
        verbatim: cfg.comp.protectLastN,
      });
      mensagens.length = 0;
      mensagens.push(...(apertado.mensagens as Mensagem[]));
      compactacao.aparadas += apertado.cortadas;
      compactacao.descartadas += apertado.descartadas;
      compactacao.tokens = apertado.tokens;
      compactacao.disponivel = apertado.disponivel;
      if (apertado.tokens > apertado.disponivel) compactacao.coube = false;
    }
    const r = await chamarModelo(cfg, mensagens, {
      tools: usaFerramentas ? pacote.specs : undefined,
      stream: Boolean(emitir),
      /* v3.24: cada rodada traz chamadas novas — o acumulador de argumentos zera aqui */
      onArgs: emitir
        ? (indice, nome, pedaco) => {
            let p = parciais.get(indice);
            if (!p) {
              p = { nome: "", bruto: "", emitido: 0 };
              parciais.set(indice, p);
            }
            if (nome) p.nome = nome;
            p.bruto += pedaco;
            if (!/tela/i.test(p.nome)) return; /* só a tela interessa para o olho */
            const html = htmlParcial(p.bruto);
            if (html.length > p.emitido) {
              emitir({ tipo: "codigo", texto: html.slice(p.emitido) });
              p.emitido = html.length;
            }
          }
        : undefined,
      onDelta: emitir
        ? (t) => {
            /* v3.35 — retém o começo da rodada: se ela pedir ferramenta, esse texto é
               NARRAÇÃO e vai direto para o rastro, sem nunca ter passado pela bolha. */
            if (!liberado) {
              if (!retido) retidoInicio = Date.now();
              retido += t;
              if (retido.length > LIMITE_RETIDO || Date.now() - retidoInicio > ESPERA_RETIDO_MS) {
                saiuTexto = true;
                liberado = true;
                emitido += retido;
                emitir({ tipo: "delta", texto: retido });
                retido = "";
              }
              return;
            }
            saiuTexto = true;
            emitido += t;
            emitir({ tipo: "delta", texto: t });
          }
        : undefined,
      /* sempre coleta (para gravar); só emite quando há tela ouvindo */
      onRaciocinio: (t) => {
        pensamento += t;
        if (!bloco) bloco = { texto: t, inicio: Date.now() };
        else bloco.texto += t;
        emitir?.({ tipo: "raciocinio", texto: t });
      },
      /* v3.18 (T001): o sinal da tarefa chega até aqui — "parar" aborta a chamada em curso */
      sinal: opts.sinal,
      /* v3.41: a imagem colada acompanha a pergunta nas rodadas do turno — o modelo
         precisa poder olhar de novo depois de chamar uma ferramenta. */
      visao: imagens,
    });
    const pedidas = r.message.tool_calls ?? [];
    if (!emitir && r.pensamento) {
      pensamento += r.pensamento + "\n\n";
      /* sem streaming não dá para medir quanto tempo foi pensamento: grava sem tempo e a
         tela escreve "Pensou" em vez de "Pensou por Ns" — não invento número que não medi */
      const bruto = String(r.pensamento).trim();
      if (bruto) rastro.push({ tipo: "pensamento", texto: bruto, ms: 0, em: decorrido() });
    }
    fecharBloco();
    if (!pedidas.length) {
      /* v3.35: era resposta, não narração — o que estava retido sai agora e segue fluindo */
      if (emitir && !liberado && retido) {
        saiuTexto = true;
        emitir({ tipo: "delta", texto: retido });
        retido = "";
      }
      /* v3.42 — a fala pode chegar depois de ele já ter concluído: em vez de perder,
         guarda o que ele disse e abre mais uma rodada só para encaixar o ajuste. */
      const ultimas = opts.falas?.() ?? [];
      if (ultimas.length) {
        if (r.texto) {
          partes.push(r.texto);
          mensagens.push({ role: "assistant", content: r.texto });
        }
        for (const fala of ultimas) {
          mensagens.push({
            role: "user",
            content: `(a pessoa falou enquanto você trabalhava — leve isto em conta e ajuste a resposta) ${fala}`,
          });
          rastro.push({ tipo: "interrupcao", texto: fala, em: Date.now() - inicio });
          emitir?.({ tipo: "steer", texto: fala });
        }
        continue;
      }
      texto = partes.length ? [...partes, r.texto].filter(Boolean).join("\n\n") : r.texto;
      break;
    }
    /* a rodada chamou ferramenta: o texto dela NÃO é a resposta — mas é FALA DE
     * CAMINHO (v3.8, pedido do dono): mostra e FICA na tela como balão próprio.
     * Para o modelo continua rascunho: o eco histórico segue sem ele. */
    const rascunho = textoDeRaciocinio(r.texto, true);
    const falaRodada = String(r.texto ?? "").trim();
    if (falaRodada) {
      falas.push(falaRodada);
      rastro.push({ tipo: "narracao", texto: falaRodada, em: decorrido() });
      emitir?.({ tipo: "fala", texto: falaRodada });
    } else if (emitir && saiuTexto) emitir({ tipo: "descartar" });
    if (rodadas > cfg.max_rodadas) {
      texto = rascunho ? ultimoResultadoTool(mensagens) || "" : r.texto;
      aviso = `o modelo ainda queria ferramenta e bateu o limite de ${cfg.max_rodadas} rodadas`;
      break;
    }
    /* devolve ao histórico SEM o rascunho e SEM os campos internos de pensamento —
     * se voltassem no contexto, o modelo repetiria o raciocínio na resposta final */
    const eco: Record<string, unknown> = { ...r.message, content: rascunho ? "" : r.texto };
    delete eco.reasoning_content;
    delete eco.reasoning;
    delete eco.thinking;
    mensagens.push(eco as Mensagem);
    for (const c of pedidas) {
      const nome = String(c.function?.name ?? "");
      let args: Record<string, unknown> = {};
      try {
        args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        args = { argumento_nao_entendido: String(c.function?.arguments ?? "").slice(0, 200) };
      }
      /* v3.34: avisa a tela ANTES de executar — a linha viva "Consultando X… Ns" aparece
         enquanto a ferramenta roda (antes, a linha só nascia no fim e a trilha parecia parada) */
      emitir?.({ tipo: "ferramenta_inicio", nome });
      const antes = Date.now();
      const exec = await executarFerramenta(nome, args, user, pacote, { memoria });
      const duracao = Date.now() - antes;
      chamadas.push({
        servidor: exec.servidor,
        nome: exec.nome,
        args: mascararArgs(exec.args ?? args),
        ok: exec.ok,
        resumo: resumirSaida(exec.saida, exec.ok),
        ms: duracao,
      });
      rastro.push({ tipo: "ferramenta", servidor: exec.servidor, nome: exec.nome, ok: exec.ok, ms: duracao, em: decorrido(antes) });
      emitir?.({ tipo: "ferramenta", servidor: exec.servidor, nome: exec.nome, ok: exec.ok, ms: exec.ms });
      /* v3.23: tela gerada aparece na hora, sem esperar o fim do turno */
      if (exec.tela) {
        if (telas.length < MAX_TELAS_TURNO) {
          telas.push(exec.tela);
          emitir?.({ tipo: "tela", tela: exec.tela });
        } else {
          aviso = aviso ?? `o modelo gerou mais de ${MAX_TELAS_TURNO} telas neste turno — as excedentes não foram exibidas`;
        }
      }
      /* v3.44: arquivo/print achado pela ferramenta vai direto para a conversa */
      if (exec.anexo) {
        anexos.push(exec.anexo);
        emitir?.({ tipo: "anexo", anexo: exec.anexo });
      }
      /* o resultado entra já aparado: ferramenta gulosamente verbosa não pode estourar a janela */
      const brutoTool = paraTexto(exec.saida);
      /* v3.18 (T004): documentos que a BUSCA devolveu são as fontes da resposta. A coluna
         `fontes` existia desde o 2.0 e nunca recebeu uma letra — passa a viver. Só ferramentas
         de busca: saída de outra ferramenta com campo "nome" não contamina. */
      if (exec.ok && (nome === "search" || /buscar|busca/i.test(nome))) {
        /* forma real da busca: {items:[{doc_id,title,...}]} — título quando existe, senão doc_id */
        let achou = false;
        try {
          const j = JSON.parse(brutoTool);
          for (const d of Array.isArray(j?.items) ? j.items : []) {
            const nomeDoc = String(d?.title || d?.doc_id || "").trim();
            if (nomeDoc && fontes.size < 12) { fontes.add(nomeDoc); achou = true; }
          }
        } catch { /* saída não-JSON: cai no regex */ }
        if (!achou) {
          for (const mm of brutoTool.matchAll(/"(?:title|doc_id|nome)"\s*:\s*"([^"]{1,140})"/g)) {
            if (mm[1] && fontes.size < 12) fontes.add(mm[1]);
          }
        }
      }
      mensagens.push({
        role: "tool",
        tool_call_id: c.id,
        content: brutoTool.length > TETO_FERRAMENTA ? `${brutoTool.slice(0, TETO_FERRAMENTA)}\n…(cortado por orçamento de contexto)` : brutoTool,
      });
      if (brutoTool.length > TETO_FERRAMENTA) compactacao.aparadas++;
    }
  }
  } catch (e) {
    /* v3.18 (T001): "parar" não é falha — o que chegou ao usuário fica gravado como resposta
       parcial, a tarefa fecha como cancelada e nenhuma frase de erro aparece. */
    if (String((e as Error)?.message ?? e) !== "cancelado-pelo-usuario") throw e;
    const parcial = emitido.trim();
    await gravarMensagens(
      tenant, memoria, pergunta, parcial, chamadas, falas, pensamento.trim(), rastro, [...fontes],
      cfg.provedor, cfg.modelo, telas, anexos, Date.now() - inicio, anexosDoUsuario,
    );
    return empacotar(parcial, "parada pelo usuário — o que chegou ficou gravado", true);
  }

  if (!texto) {
    const achado = ultimoResultadoTool(mensagens).trim();
    texto = achado
      ? `busquei, mas o modelo parou sem responder. O que a ferramenta achou: ${achado.slice(0, 600)}`
      : "o modelo chamou as ferramentas mas não devolveu resposta escrita";
    aviso =
      aviso ??
      (pacote.specs.length
        ? `nem o MCP interno${cfg.mcp_interno ? " (ligado)" : " (desligado)"} nem servidor externo emprestou ferramenta que servisse para esta pergunta`
        : "nenhuma ferramenta está ligada em Configurações → Ferramentas (MCP)");
  }

  await gravarMensagens(tenant, memoria, pergunta, texto, chamadas, falas, pensamento.trim(), rastro, [...fontes], cfg.provedor, cfg.modelo, telas, anexos, Date.now() - inicio, anexosDoUsuario);
  return empacotar(texto, aviso, false);
}

async function gravarMensagens(
  tenant: string,
  memoria: string,
  pergunta: string,
  resposta: string,
  chamadas: ChamadaFerramenta[],
  falas: string[] = [],
  raciocinio = "",
  rastro: SegmentoRastro[] = [],
  fontes: string[] = [],
  provedor: string | null = null,
  modelo = "",
  telas: Tela[] = [],
  anexos: AnexoMeta[] = [],
  msTurno = 0,
  /** v3.46: arquivos que a PESSOA anexou (a linha 'user' mostra eles no histórico) */
  anexosDoUsuario: AnexoMeta[] = [],
): Promise<void> {
  await q(
    `INSERT INTO chat_mensagens (tenant, memoria, papel, texto, ferramentas, anexos) VALUES ($1, $2, 'user', $3, NULL, $4::jsonb)`,
    [tenant, memoria, pergunta, JSON.stringify(anexosDoUsuario)],
  );
  await q(
    `INSERT INTO chat_mensagens (tenant, memoria, papel, texto, ferramentas, falas, raciocinio, rastro, fontes, custo, provedor, modelo, telas, anexos) VALUES ($1, $2, 'assistant', $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb)`,
    [
      tenant, memoria, resposta, JSON.stringify(chamadas), JSON.stringify(falas), raciocinio || null,
      JSON.stringify(rastro), JSON.stringify(fontes),
      /* v3.18 (T018): tok_out medido pela mesma régua do orçamento; tok_in fica por conta de quem
         chamou (a resposta pode ser parcial) — gravamos só o que temos aqui. */
      JSON.stringify({ tok_out: custoDoPayload([{ content: resposta }]), ...(msTurno > 0 ? { ms: msTurno } : {}) }),
      /* v3.19: quem respondeu (nome do provedor escolhido; null = padrão da casa) */
      provedor, modelo || "",
      /* v3.23: telas geradas neste turno */
      JSON.stringify(telas),
      /* v3.44: prints/arquivos da máquina */
      JSON.stringify(anexos),
    ],
  );
}

export async function historicoChat(
  user: Usuario,
  opts: { memoria?: string; tenant?: string | null; limit?: number },
) {
  const tenant = tenantFor(user, opts.tenant ?? null);
  const memoria = (opts.memoria ?? "").trim();
  const limite = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const r = await q(
    `SELECT id, papel, texto, ferramentas, falas, raciocinio, rastro, fontes, custo, provedor, modelo, telas, anexos, criado_em FROM chat_mensagens
     WHERE tenant = $1 AND memoria = $2 ORDER BY id DESC LIMIT $3`,
    [tenant, memoria, limite],
  );
  return {
    tenant,
    memoria,
    mensagens: r.rows.reverse().map((m: any) => ({
      id: Number(m.id),
      papel: m.papel,
      texto: m.texto,
      ferramentas: m.ferramentas ?? [],
      falas: m.falas ?? [],
      raciocinio: m.raciocinio ?? "",
      rastro: m.rastro ?? [],
      /* v3.18: fontes (T004) e custo (T018) voltam com a mensagem — a tela mostra ao reabrir */
      fontes: m.fontes ?? [],
      custo: m.custo ?? null,
      /* v3.19: qual provedor respondeu esta mensagem (null = padrão da casa) */
      provedor: m.provedor ?? "",
      modelo: m.modelo ?? "",
      /* v3.23: telas geradas (o card com preview volta ao reabrir a conversa) */
      telas: m.telas ?? [],
      /* v3.44: prints/arquivos voltam com a conversa */
      anexos: m.anexos ?? [],
      quando: m.criado_em,
    })),
  };
}

export async function limparChat(
  user: Usuario,
  opts: { memoria?: string; tenant?: string | null },
) {
  const tenant = tenantFor(user, opts.tenant ?? null);
  const memoria = (opts.memoria ?? "").trim();
  const r = await q(`DELETE FROM chat_mensagens WHERE tenant = $1 AND memoria = $2`, [tenant, memoria]);
  return { tenant, memoria, apagadas: r.rowCount ?? 0 };
}

/* ============================ v3.18 — básico de chat ============================ */

/** T002 (regenerar): corta o ÚLTIMO par pergunta+resposta e devolve a pergunta para a tela
 *  reenviar pelo caminho normal (tarefa, fila, streaming — não criamos segunda via).
 *  Termina com pergunta solta (resposta falhou): corta só ela e devolve o texto. */
export async function truncarParaRegenerar(
  user: Usuario,
  o: { memoria?: string; tenant?: string | null },
) {
  const tenant = tenantFor(user, o.tenant ?? null);
  const memoria = (o.memoria ?? "").trim();
  const r = await q<{ id: string; papel: string; texto: string }>(
    `SELECT id, papel, texto FROM chat_mensagens WHERE tenant = $1 AND memoria = $2 ORDER BY id DESC LIMIT 2`,
    [tenant, memoria],
  );
  if (!r.rows.length) throw erro422("não há nada aqui para regenerar");
  if (r.rows[0].papel === "assistant") {
    if (r.rows.length < 2 || r.rows[1].papel !== "user") throw erro422("o histórico terminou de um jeito estranho — digite a pergunta de novo");
    await q(`DELETE FROM chat_mensagens WHERE tenant = $1 AND memoria = $2 AND id >= $3`, [tenant, memoria, r.rows[1].id]);
    return { pergunta: r.rows[1].texto, removidas: 2 };
  }
  await q(`DELETE FROM chat_mensagens WHERE tenant = $1 AND memoria = $2 AND id = $3`, [tenant, memoria, r.rows[0].id]);
  return { pergunta: r.rows[0].texto, removidas: 1 };
}

/** T003 (editar e reenviar): corta do histórico a pergunta apontada (inclusive) e tudo depois
 *  dela. A tela reenvia o texto editado pelo caminho normal. A mensagem precisa ser do dono. */
export async function cortarParaReenviar(
  user: Usuario,
  o: { memoria?: string; tenant?: string | null; id: number },
) {
  const tenant = tenantFor(user, o.tenant ?? null);
  const memoria = (o.memoria ?? "").trim();
  if (!Number.isInteger(o.id) || o.id <= 0) throw erro422("id de mensagem inválido");
  const m = await q<{ papel: string }>(
    `SELECT papel FROM chat_mensagens WHERE id = $1 AND tenant = $2 AND memoria = $3`,
    [o.id, tenant, memoria],
  );
  if (!m.rows.length) throw erro422("essa pergunta não está mais nesta gaveta");
  if (m.rows[0].papel !== "user") throw erro422("só pergunta pode ser reenviada");
  const d = await q(`DELETE FROM chat_mensagens WHERE tenant = $1 AND memoria = $2 AND id >= $3`, [tenant, memoria, o.id]);
  return { cortadas: d.rowCount ?? 0 };
}

/** T021 (buscar no histórico): ILIKE simples, 50 resultados, trecho ao redor do achado.
 *  Só o tenant do usuário (operador continua preso ao tenant corrente como no resto do chat). */
export async function buscarMensagensChat(user: Usuario, termo: string, limite = 50, tenantArg?: string | null) {
  const tenant = tenantFor(user, tenantArg ?? null);
  const t = termo.trim().slice(0, 120);
  if (t.length < 2) throw erro422("digite pelo menos 2 caracteres para buscar");
  const r = await q(
    `SELECT id, memoria, papel, texto, criado_em FROM chat_mensagens
     WHERE tenant = $1 AND texto ILIKE $2 ORDER BY id DESC LIMIT $3`,
    [tenant, `%${t}%`, Math.min(Math.max(limite, 1), 100)],
  );
  const agulha = t.toLowerCase();
  return {
    termo: t,
    resultados: r.rows.map((m: any) => {
      const txt = String(m.texto);
      const i = Math.max(0, txt.toLowerCase().indexOf(agulha) - 70);
      return {
        id: Number(m.id),
        memoria: String(m.memoria ?? ""),
        papel: m.papel,
        trecho: `${i > 0 ? "…" : ""}${txt.slice(i, i + 180).replace(/\n/g, " ")}`,
        quando: m.criado_em,
      };
    }),
  };
}

/** T016 (título automático): depois da primeira troca de uma gaveta nomeada sem título.
 *  Um chamarModelo pequeno, sem stream nem ferramentas. Engole os próprios erros — título
 *  nenhum vale derrubar uma resposta entregue. Título manual (T015) sempre vence: só escrevemos
 *  onde COALESCE acha NULL. */
export async function gerarTituloAutomatico(
  user: Usuario,
  o: { tenant: string; memoria: string; pergunta: string; resposta: string },
): Promise<void> {
  const memoria = o.memoria.trim();
  if (!memoria) return; // a gaveta padrão não ganha título
  try {
    const ja = await q<{ titulo: string | null }>(
      `SELECT titulo FROM gavetas WHERE tenant = $1 AND memoria = $2`,
      [o.tenant, memoria],
    );
    if (ja.rows.length && ja.rows[0].titulo) return;
    const cfg = await resolverProvider(o.tenant);
    if (!cfg) return;
    const r = await chamarModelo(
      cfg,
      [
        { role: "system", content: "Dê a esta conversa um titulo de no maximo 5 palavras, em minusculas, sem pontuacao no fim. Responda apenas o titulo." },
        { role: "user", content: `${o.pergunta.slice(0, 400)}\n\nresposta: ${o.resposta.slice(0, 400)}` },
      ],
      { tetoMs: 30000 },
    );
    const titulo = String(r.texto ?? "")
      .trim()
      .split("\n")[0]
      .replace(/^["'\s]+|["'.\s]+$/g, "")
      .slice(0, 60);
    if (!titulo) return;
    await q(
      `INSERT INTO gavetas (tenant, memoria, titulo) VALUES ($1, $2, $3)
       ON CONFLICT (tenant, memoria) DO UPDATE SET titulo = COALESCE(gavetas.titulo, EXCLUDED.titulo)`,
      [o.tenant, memoria, titulo],
    );
  } catch (e) {
    log(`titulo automatico ${o.tenant}/${memoria}: ${String((e as Error).message ?? e)}`);
  }
}

