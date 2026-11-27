/**
 * v3.84 — HABILIDADES (atalhos do usuário).
 *
 * O que resolve: os cartões da tela inicial eram fixos no código (`EXEMPLOS_VAZIO`), então a
 * frase que ia para o agente era suposição de quem escreveu a tela. Aqui a própria conta
 * escreve o pedido uma vez e ele aparece como cartão na home quando marcado como favorito.
 *
 * Desenho (o mesmo que faz a habilidade valer de verdade):
 *  - o ÍNDICE (nome + quando usar) entra curto no prompt de todo turno;
 *  - o CORPO completo só é lido quando o agente precisa, pela tool `ler_habilidade`
 *    (ou pelo "use a habilidade X", que a tool resolve).
 * Guardar texto e nunca mostrar o caminho de leitura produz pasta que ninguém abre.
 *
 * Regras:
 *  - tudo escopado por tenant; nada de uma conta aparece em outra;
 *  - remover é DELETE de verdade (é texto do usuário, não documento: não há o que preservar);
 *  - `favorita` manda no cartão da home; `ordem` desempata (menor primeiro).
 */
import { q } from "./db.js";
import { erro404, erro422 } from "./errors.js";
import type { Usuario } from "./config.js";

export type Habilidade = {
  id: number;
  nome: string;
  quando_usar: string;
  corpo: string;
  favorita: boolean;
  ordem: number;
  criado_em: string;
  atualizado_em: string;
};

const MAX_NOME = 60;
const MAX_QUANDO = 200;
const MAX_CORPO = 8000;
/** teto de habilidades por conta: lista infinita vira bagunça e come contexto no índice */
export const MAX_POR_CONTA = 60;
/** quantas o índice do prompt carrega (as favoritas primeiro) */
const INDICE_MAX = 40;
/** teto do índice inteiro dentro do prompt, em caracteres */
const INDICE_CHARS = 2400;

export async function garantirHabilidades(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS habilidades (
       id BIGSERIAL PRIMARY KEY,
       tenant TEXT NOT NULL,
       nome TEXT NOT NULL,
       quando_usar TEXT NOT NULL DEFAULT '',
       corpo TEXT NOT NULL DEFAULT '',
       favorita BOOLEAN NOT NULL DEFAULT false,
       ordem INT NOT NULL DEFAULT 100,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (tenant, nome))`,
  );
  await q(`CREATE INDEX IF NOT EXISTS habilidades_tenant_idx ON habilidades (tenant, favorita DESC, ordem, nome)`);
}

function limpar(v: unknown, teto: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, teto);
}

/** nome é o identificador que o agente usa para ler a habilidade: sem barra, sem espaço duplo. */
function nomeDe(v: unknown): string {
  const n = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOME);
  if (n.length < 2) throw erro422("nome da habilidade: mínimo de 2 caracteres");
  return n;
}

const CAMPOS = `id, nome, quando_usar, corpo, favorita, ordem, criado_em, atualizado_em`;

export async function listarHabilidades(user: Usuario, soFavoritas = false): Promise<Habilidade[]> {
  const r = await q<Habilidade>(
    `SELECT ${CAMPOS} FROM habilidades
      WHERE tenant = $1 ${soFavoritas ? "AND favorita" : ""}
      ORDER BY favorita DESC, ordem, nome`,
    [user.tenant],
  );
  return r.rows.map((l) => ({ ...l, id: Number(l.id), ordem: Number(l.ordem) }));
}

export async function obterHabilidade(user: Usuario, idOuNome: unknown): Promise<Habilidade> {
  const bruto = String(idOuNome ?? "").trim();
  if (!bruto) throw erro422("informe a habilidade (nome ou id)");
  const n = Number(bruto);
  const r = Number.isFinite(n) && n > 0
    ? await q<Habilidade>(`SELECT ${CAMPOS} FROM habilidades WHERE tenant = $1 AND id = $2`, [user.tenant, n])
    : await q<Habilidade>(
        `SELECT ${CAMPOS} FROM habilidades WHERE tenant = $1 AND lower(nome) = lower($2)`,
        [user.tenant, bruto],
      );
  const h = r.rows[0];
  if (!h) throw erro404(`habilidade não encontrada: ${bruto}`);
  return { ...h, id: Number(h.id), ordem: Number(h.ordem) };
}

export async function criarHabilidade(user: Usuario, body: Record<string, unknown>): Promise<Habilidade> {
  const nome = nomeDe(body.nome ?? body.titulo);
  const quando = limpar(body.quando_usar ?? body.quando, MAX_QUANDO);
  const corpo = String(body.corpo ?? body.texto ?? "").trim().slice(0, MAX_CORPO);
  if (!corpo) throw erro422("corpo da habilidade: escreva o pedido/instrução (não pode ficar vazio)");
  const total = await q<{ n: string }>(`SELECT count(*)::text AS n FROM habilidades WHERE tenant = $1`, [user.tenant]);
  if (Number(total.rows[0]?.n ?? 0) >= MAX_POR_CONTA) {
    throw erro422(`limite de ${MAX_POR_CONTA} habilidades por conta — remova alguma antes de criar outra`);
  }
  const r = await q<Habilidade>(
    `INSERT INTO habilidades (tenant, nome, quando_usar, corpo, favorita, ordem)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${CAMPOS}`,
    [user.tenant, nome, quando, corpo, body.favorita === true, Number(body.ordem ?? 100)],
  );
  return { ...r.rows[0], id: Number(r.rows[0].id), ordem: Number(r.rows[0].ordem) };
}

export async function editarHabilidade(user: Usuario, idOuNome: unknown, body: Record<string, unknown>): Promise<Habilidade> {
  const atual = await obterHabilidade(user, idOuNome);
  const nome = body.nome === undefined ? atual.nome : nomeDe(body.nome);
  const quando = body.quando_usar === undefined && body.quando === undefined
    ? atual.quando_usar
    : limpar(body.quando_usar ?? body.quando, MAX_QUANDO);
  const corpo = body.corpo === undefined && body.texto === undefined
    ? atual.corpo
    : String(body.corpo ?? body.texto ?? "").trim().slice(0, MAX_CORPO);
  if (!corpo) throw erro422("corpo da habilidade: escreva o pedido/instrução (não pode ficar vazio)");
  const favorita = body.favorita === undefined ? atual.favorita : body.favorita === true;
  const ordem = body.ordem === undefined ? atual.ordem : Number(body.ordem);
  const r = await q<Habilidade>(
    `UPDATE habilidades SET nome = $2, quando_usar = $3, corpo = $4, favorita = $5, ordem = $6,
            atualizado_em = now()
      WHERE tenant = $1 AND id = $7 RETURNING ${CAMPOS}`,
    [user.tenant, nome, quando, corpo, favorita, ordem, atual.id],
  );
  return { ...r.rows[0], id: Number(r.rows[0].id), ordem: Number(r.rows[0].ordem) };
}

export async function removerHabilidade(user: Usuario, idOuNome: unknown): Promise<{ removida: string }> {
  const h = await obterHabilidade(user, idOuNome);
  await q(`DELETE FROM habilidades WHERE tenant = $1 AND id = $2`, [user.tenant, h.id]);
  return { removida: h.nome };
}

export async function favoritarHabilidade(user: Usuario, idOuNome: unknown, favorita: boolean): Promise<Habilidade> {
  const h = await obterHabilidade(user, idOuNome);
  return editarHabilidade(user, h.id, { favorita });
}

/**
 * Índice curto que entra no prompt: nome + quando usar. O corpo NÃO vai aqui — vai sob demanda
 * por `ler_habilidade`. Sem índice, o agente não sabe que a habilidade existe; com corpo, o
 * contexto vira lixo de 8k por turno.
 */
export async function indiceHabilidades(tenant: string): Promise<string> {
  const r = await q<{ nome: string; quando_usar: string }>(
    `SELECT nome, quando_usar FROM habilidades
      WHERE tenant = $1 ORDER BY favorita DESC, ordem, nome LIMIT $2`,
    [tenant, INDICE_MAX],
  );
  if (!r.rows.length) return "";
  let texto = "\n\n[Habilidades desta conta — atalhos escritos pelo próprio usuário]\n";
  for (const l of r.rows) {
    const linha = `- ${l.nome}${l.quando_usar ? ` — ${l.quando_usar}` : ""}\n`;
    if (texto.length + linha.length > INDICE_CHARS) break;
    texto += linha;
  }
  texto +=
    "Quando o pedido da pessoa bater com uma delas, chame a ferramenta ler_habilidade (nome) " +
    "ANTES de responder e siga o que está escrito lá. Se nada bater, ignore esta lista.\n";
  return texto;
}