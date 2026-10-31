/** Configuração do Nexos — aceita as variáveis novas NEXOS_* e as antigas MINIRAG_*. */
import os from "node:os";

/* v3.47: o produto passou a se chamar Nexos. O Dokploy ainda injeta MINIRAG_*, e
   ninguém precisa parar o deploy para migrar: aqui as antigas viram NEXOS_* quando
   a nova não existe. Definir as duas = a NEXOS_* vence, sem aviso de conflito. */
for (const [chave, valor] of Object.entries(process.env)) {
  if (!chave.startsWith("MINIRAG_") || valor === undefined) continue;
  const nova = "NEXOS_" + chave.slice("MINIRAG_".length);
  if (process.env[nova] === undefined) process.env[nova] = valor;
}

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? def : n;
}

function flt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? def : n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return def;
  return ["1", "true", "sim", "yes"].includes(raw.trim().toLowerCase());
}

export const CONFIG = {
  versao: "3.56.0",
  model: process.env.NEXOS_MODEL ?? "nomic-ai/nomic-embed-text-v1.5",
  modelDir: process.env.NEXOS_MODEL_DIR ?? "/app/models",

  dbHost: process.env.NEXOS_DB_HOST ?? "nexos-db",
  dbPort: int("NEXOS_DB_PORT", 5432),
  dbUser: process.env.NEXOS_DB_USER ?? "minirag",
  dbPassword: process.env.NEXOS_DB_PASSWORD ?? "minirag",
  dbName: process.env.NEXOS_DB_NAME ?? "minirag",
  dbWaitTries: int("NEXOS_DB_WAIT_TRIES", 30),
  dbWaitSeconds: int("NEXOS_DB_WAIT_SECONDS", 2),

  maxChunkWords: int("NEXOS_MAX_CHUNK_WORDS", 500),
  chunkOverlap: int("NEXOS_CHUNK_OVERLAP", 80),
  topK: int("NEXOS_TOP_K", 5),
  minScore: flt("NEXOS_MIN_SCORE", 0.55),

  /* v3.45: arquivos da máquina vivem em DISCO (pasta por usuário), não no banco.
     O teto é o espaço do volume; 10 GB é o padrão pedido pelo dono. */
  arquivosDir: process.env.NEXOS_ARQUIVOS_DIR ?? "/app/dados/anexos",
  maxArquivoBytes: int("NEXOS_MAX_ARQUIVO_MB", 10_240) * 1024 * 1024,
  arquivosDias: int("NEXOS_ARQUIVOS_DIAS", 7),

  maxContentChars: int("NEXOS_MAX_CONTENT_CHARS", 500_000),
  maxQueryChars: int("NEXOS_MAX_QUERY_CHARS", 2_000),
  maxChunksTenant: int("NEXOS_MAX_CHUNKS_TENANT", 10_000),

  decayAtivo: bool("NEXOS_DECAY_ATIVO", true),
  // v3.5 (dono, 21/10): o esquecimento padrão passou de 30 dias para 6 MESES, e os três
  // números (arquivar / morte do arquivado / carência do apagar usuário) podem ser
  // gravados na tela — a tabela `esquecimento_cfg` tem precedência sobre estes defaults.
  decayDias: int("NEXOS_DECAY_DIAS", 180),
  expurgoArquivadoDias: int("NEXOS_EXPURGO_ARQUIVADO_DIAS", 365),
  carenciaDias: int("NEXOS_CARENCIA_DIAS", 30),
  decayMinAcessos: int("NEXOS_DECAY_MIN_ACESSOS", 2),
  decayIntervaloMinutos: int("NEXOS_DECAY_INTERVALO_MINUTOS", 60),

  corsOrigins: (process.env.NEXOS_CORS_ORIGINS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean),

  loginMaxFalhas: int("NEXOS_LOGIN_MAX_FALHAS", 10),
  loginJanelaSeg: int("NEXOS_LOGIN_JANELA_SEG", 300),

  port: int("NEXOS_PORT", 8000),
  host: process.env.NEXOS_HOST ?? "0.0.0.0",

  embedderPort: int("NEXOS_EMBEDDER_PORT", 8001),
  embedderUrl: process.env.NEXOS_EMBEDDER_URL ?? "http://127.0.0.1:8001",
  embedderModo: (process.env.NEXOS_EMBEDDER_MODO ?? "filho") as "filho" | "externo",
  pythonBin: process.env.NEXOS_PYTHON ?? "python3",

  painelDir:
    process.env.NEXOS_PAINEL_DIR ??
    require("node:path").resolve(__dirname, "..", "frontend", "dist"),
  workerAtivo: bool("NEXOS_WORKER_ATIVO", true),
} as const;

export type Usuario = { tenant: string; operador?: boolean };

/** 'nome:chave, outro:outra' -> [{nome, chave}] */
export function parseUsers(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of raw.split(",")) {
    const e = entry.trim();
    if (!e || !e.includes(":")) continue;
    const idx = e.indexOf(":");
    const nome = e.slice(0, idx).trim();
    const chave = e.slice(idx + 1).trim();
    if (nome && chave) out.push([nome, chave]);
  }
  return out;
}

export const USERS = parseUsers(process.env.NEXOS_USERS ?? "");
/* v3.4 (21/10): o nome canônico é MINIRAG_ADMIN. MINIRAG_OPERADOR continua valendo como
 * apelido antigo — ambiente que ainda não trocou a variável segue bootando igual.
 * Com as duas presentes, ADMIN vence. */
const ENV_ADMIN = process.env.NEXOS_ADMIN || process.env.NEXOS_OPERADOR || "";
export const OPERADOR = parseUsers(ENV_ADMIN);

export function isOperador(u: Usuario): boolean {
  return Boolean(u.operador);
}

/** Tenant ALVO: login comum = o próprio (arg ignorado); operador = ?tenant. */
export function tenantFor(u: Usuario, arg?: string | null): string {
  if (isOperador(u)) return (arg ?? "").trim() || u.tenant;
  return u.tenant;
}

/** Filtro de agregados: null = ver tudo (operador sem ?tenant). */
export function tenantFilter(u: Usuario, arg?: string | null): string | null {
  if (isOperador(u)) {
    const a = (arg ?? "").trim();
    return a || null;
  }
  return u.tenant;
}

export function log(msg: string): void {
  // stdout sem buffer, prefixo fixo (o docker logs fica legível)
  process.stdout.write(`[nexos] ${msg}${os.EOL}`);
}