/**
 * v3.36 — O nexos como SERVIDOR MCP passa a ter dono de cada ferramenta.
 *
 * Duas camadas, nesta ordem:
 *
 *  1. **Interruptor do admin** (`mcp_cfg.usuarios_habilitado`): desligado, só o operador
 *     usa o MCP; todo mundo mais recebe 403. Nasce LIGADO para não quebrar os agentes que
 *     já conversam com o serviço (Hermes, IA_GO) — o operador desliga quando quiser.
 *
 *  2. **Lista do próprio usuário** (`mcp_permissoes`): o que ele quer liberar para os
 *     agentes dele. Guardamos só o que está DESLIGADO — assim ferramenta nova nasce
 *     liberada, sem precisar de migração nem de aprovação.
 *
 * O papel continua valendo acima de tudo: ferramenta de operador não é liberada por
 * interruptor nenhum (o toggle não dá poder que o papel não tem).
 */
import { q } from "./db";
import { log } from "./config";
import { controleDeMaquinaAtivo } from "./maquinas";
import { NOMES_MAQUINA_TOOLS } from "./maquinas_tools";

/** Nomes que só o operador pode chamar (bate com o exigirOperador do src/mcp.ts). */
export const SO_OPERADOR = new Set([
  "rodar_python",
  "listar_usuarios",
  "criar_usuario",
  "apagar_usuario",
  "esquecimento",
  "gerir_mcp",
]);

/** Ferramentas de máquina (mesma origem do filtro do src/mcp.ts): só com o controle ligado. */
const MAQUINAS = new Set<string>(["rodar_comando", ...NOMES_MAQUINA_TOOLS]);

export function eDeMaquina(nome: string): boolean {
  return MAQUINAS.has(nome);
}

export type Grupo = "documentos" | "gavetas" | "operação" | "usuários" | "máquinas" | "pareamento";

const GRUPOS: Record<string, Grupo> = {
  search: "documentos", ingest: "documentos", ingest_status: "documentos", list_docs: "documentos",
  delete_doc: "documentos", upload_file: "documentos", get_file: "documentos", edit_doc: "documentos",
  rename_doc: "documentos", archive_doc: "documentos",
  list_gavetas: "gavetas", create_gaveta: "gavetas", delete_gaveta: "gavetas",
  health: "operação", list_jobs: "operação", chat: "operação", config_provider: "operação",
  mostrar_tela: "operação", web_search: "operação", web_open: "operação", rodar_python: "operação",
  listar_usuarios: "usuários", criar_usuario: "usuários", apagar_usuario: "usuários",
  esquecimento: "usuários", listar_mcp: "usuários", gerir_mcp: "usuários",
  gerar_pareamento: "pareamento",
};

export function grupoDaFerramenta(nome: string): Grupo {
  if (eDeMaquina(nome)) return "máquinas";
  return GRUPOS[nome] ?? "operação";
}

/* ------------------------------------------------------------- estado ---- */

let habilitadoParaTodos = true;
/** tenant → nomes DESLIGADOS por ele. Ausência = liberado. */
const bloqueadas = new Map<string, Set<string>>();

export function mcpLiberadoParaTodos(): boolean {
  return habilitadoParaTodos;
}

export async function gravarMcpLiberadoParaTodos(v: boolean): Promise<void> {
  await q(
    `INSERT INTO mcp_cfg (chave, valor, atualizado_em) VALUES ('usuarios_habilitado', $1, now())
     ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = now()`,
    [v ? "1" : "0"],
  );
  habilitadoParaTodos = v;
  log(`mcp: acesso de usuários ${v ? "liberado" : "restrito ao administrador"}`);
}

export async function initMcpAcesso(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS mcp_cfg (
       chave         TEXT PRIMARY KEY,
       valor         TEXT NOT NULL,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  await q(
    `CREATE TABLE IF NOT EXISTS mcp_permissoes (
       tenant        TEXT NOT NULL,
       ferramenta    TEXT NOT NULL,
       permitida     BOOLEAN NOT NULL DEFAULT true,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (tenant, ferramenta))`,
  );
  const cfg = await q<{ valor: string }>(`SELECT valor FROM mcp_cfg WHERE chave = 'usuarios_habilitado'`);
  habilitadoParaTodos = cfg.rows[0]?.valor !== "0";
  await recarregarPermissoes();
  log(`mcp: usuários ${habilitadoParaTodos ? "liberados" : "bloqueados"} · ${bloqueadas.size} conta(s) com ajuste`);
}

export async function recarregarPermissoes(): Promise<void> {
  const r = await q<{ tenant: string; ferramenta: string }>(
    `SELECT tenant, ferramenta FROM mcp_permissoes WHERE permitida = false`,
  );
  bloqueadas.clear();
  for (const linha of r.rows) {
    const set = bloqueadas.get(linha.tenant) ?? new Set<string>();
    set.add(linha.ferramenta);
    bloqueadas.set(linha.tenant, set);
  }
}

/* ------------------------------------------------------------- decisão ---- */

export type Motivo = "papel" | "maquinas" | "desligada" | "servidor_desligado" | null;

/**
 * Por que ESTA ferramenta não serve para este usuário — `null` = pode usar.
 * A ordem importa: papel > interruptor de máquinas > lista do próprio usuário.
 */
export function motivoDeBloqueio(tenant: string, operador: boolean | undefined, nome: string): Motivo {
  if (SO_OPERADOR.has(nome) && !operador) return "papel";
  if (eDeMaquina(nome) && !controleDeMaquinaAtivo()) return "maquinas";
  if (!operador && !habilitadoParaTodos) return "servidor_desligado";
  if (bloqueadas.get(tenant)?.has(nome)) return "desligada";
  return null;
}

export function ferramentaPermitida(tenant: string, operador: boolean | undefined, nome: string): boolean {
  return motivoDeBloqueio(tenant, operador, nome) === null;
}

/** O que a tela mostra: a ferramenta pode ser ligada/desligada pelo próprio usuário? */
export function ajustavelPeloUsuario(operador: boolean | undefined, nome: string): boolean {
  if (SO_OPERADOR.has(nome) && !operador) return false;
  if (eDeMaquina(nome) && !controleDeMaquinaAtivo()) return false;
  if (!operador && !habilitadoParaTodos) return false;
  return true;
}

export async function gravarPermissao(
  tenant: string,
  operador: boolean | undefined,
  nome: string,
  permitida: boolean,
): Promise<void> {
  if (SO_OPERADOR.has(nome) && !operador) {
    throw Object.assign(new Error("ferramenta de administrador: o papel manda mais que a lista"), { status: 403 });
  }
  if (permitida) {
    await q(`DELETE FROM mcp_permissoes WHERE tenant = $1 AND ferramenta = $2`, [tenant, nome]);
    bloqueadas.get(tenant)?.delete(nome);
  } else {
    await q(
      `INSERT INTO mcp_permissoes (tenant, ferramenta, permitida, atualizado_em)
       VALUES ($1, $2, false, now())
       ON CONFLICT (tenant, ferramenta) DO UPDATE SET permitida = false, atualizado_em = now()`,
      [tenant, nome],
    );
    const set = bloqueadas.get(tenant) ?? new Set<string>();
    set.add(nome);
    bloqueadas.set(tenant, set);
  }
}

export function nomesDesligados(tenant: string): string[] {
  return [...(bloqueadas.get(tenant) ?? new Set<string>())];
}
