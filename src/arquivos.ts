/**
 * v3.85 — EXPLORADOR DA CONTA (pastas de verdade + lixeira).
 *
 * O que resolve: a tela Arquivos era uma lista plana de anexos sem hierarquia nenhuma e
 * apagar era irreversível. O dono pediu "cara de Windows" (criar pasta, renomear, mover,
 * baixar, lixeira) e confirmou as duas decisões que mandam no desenho:
 *   - MÁQUINA NÃO entra na árvore (continua sendo ação "enviar para máquina");
 *   - EXCLUIR vai para a LIXEIRA e fica 30 dias (NEXOS_LIXEIRA_DIAS), depois a faxina morde.
 *
 * Desenho:
 *  - a hierarquia é METADADO. O arquivo no disco continua em
 *    `<arquivosDir>/<tenant>/<id>/<nome>` — mover de pasta NÃO copia byte nenhum, só troca
 *    `pasta_id`. É o que torna mover barato e impossível de corromper um arquivo grande;
 *  - lixeira é coluna, não pasta: `excluido_em`. Assim "esvaziar" e "restaurar" são um UPDATE
 *    e a lista nunca precisa adivinhar onde o arquivo estava;
 *  - restaurar devolve para a pasta de origem se ela ainda existir; se não, vai para a raiz e a
 *    resposta AVISA (sumir o arquivo de volta sem dizer é o pior erro possível aqui);
 *  - renomear mexe no disco (o nome é parte do caminho), então é feito dentro de uma função só,
 *    com o `nomeLimpo` da casa — nome de usuário nunca vira caminho.
 *
 * Regras que valem aqui:
 *  - O EXPLORADOR É PRIVADO DA CONTA: `?tenant=` não faz o operador enxergar arquivo alheio.
 *    É a decisão que o dono fixou para as máquinas na v3.79 ("o admin não vê nem alcança a de
 *    outra conta") — arquivo de usuário (print, backup, vídeo) é dado privado pelo mesmo motivo.
 *    O painel de gestão de outra conta continua mexendo em gaveta/conversa, não em arquivo.;
 *  - duas pastas irmãs não podem ter o mesmo nome (409) — sem isso a árvore fica ambígua;
 *  - mover pasta para dentro dela mesma (ou de uma filha) é bloqueado antes de escrever;
 *  - apagar pasta LEVA o conteúdo junto para a lixeira (é o que o usuário espera do Windows) e
 *    restaurar a pasta traz o conteúdo de volta;
 *  - nada é apagado do disco por pedido do usuário: pedido apaga = lixeira. O definitivo só
 *    vem de `?definitivo=1`, de "esvaziar" ou da faxina depois de 30 dias.
 */
import path from "node:path";
import { CONFIG } from "./config";
import type { Usuario } from "./config";
import { q } from "./db";
import { erro404, erro409, erro422 } from "./errors";
import { apagarAnexo, copiarAnexo, nomeLimpo, trocarNomeArquivo } from "./anexos";

const TABELA = "anexos_maquina";
const PASTAS = "pastas_arquivos";

export type Pasta = {
  id: number;
  nome: string;
  pai_id: number | null;
  arquivos: number;
  criada_em: string;
};

/** teto por conta: árvore infinita é bagunça, e a lista inteira entra na tela de uma vez */
export const MAX_PASTAS_POR_CONTA = 500;
const MAX_NOME = 180;

/** DDL idempotente no boot (nunca script que alguém roda na mão) */
export async function iniciarArquivos(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS ${PASTAS} (
       id            BIGSERIAL PRIMARY KEY,
       tenant        VARCHAR(64) NOT NULL,
       nome          VARCHAR(${MAX_NOME}) NOT NULL,
       pai_id        BIGINT,
       criada_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       excluida_em   TIMESTAMPTZ
     )`,
  );
  await q(`CREATE INDEX IF NOT EXISTS pastas_tenant ON ${PASTAS} (tenant, pai_id) WHERE excluida_em IS NULL`);
  /* o anexo ganha: pasta (NULL = raiz), lixeira (timestamp) e estrela da tela */
  await q(`ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS pasta_id BIGINT`);
  await q(`ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMPTZ`);
  await q(`ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS favorita BOOLEAN NOT NULL DEFAULT FALSE`);
  await q(`CREATE INDEX IF NOT EXISTS anexos_pasta ON ${TABELA} (tenant, pasta_id) WHERE excluido_em IS NULL`);
}

/* ------------------------------------------------------------------ util */

function nomeDe(nome: unknown): string {
  const n = nomeLimpo(String(nome ?? ""));
  if (!n || n === "arquivo") throw erro422("nome da pasta invalido");
  return n.slice(0, MAX_NOME);
}

/** id de pasta vindo do usuário: aceita "raiz"/0/vazio como raiz (NULL) */
function pastaAlvo(valor: unknown): number | null {
  if (valor === undefined || valor === null || valor === "" || valor === 0 || valor === "0" || valor === "raiz") return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw erro422("id de pasta invalido");
  return n;
}

/** a pasta existe, é desta conta e está viva? */
async function pastaViva(u: Usuario, id: number): Promise<Pasta> {
  const r = await q<{ id: string; nome: string; pai_id: string | null }>(
    `SELECT id, nome, pai_id FROM ${PASTAS} WHERE id = $1 AND tenant = $2 AND excluida_em IS NULL`,
    [id, u.tenant],
  );
  const p = r.rows[0];
  if (!p) throw erro404("pasta não encontrada");
  return { id: Number(p.id), nome: p.nome, pai_id: p.pai_id === null ? null : Number(p.pai_id), arquivos: 0, criada_em: "" };
}

/** sobe a cadeia de pais (com teto) para impedir pasta dentro de si mesma */
async function semCiclo(u: Usuario, id: number, novoPai: number): Promise<void> {
  let atual: number | null = novoPai;
  for (let i = 0; i < 100 && atual !== null; i++) {
    if (atual === id) throw erro422("não dá para mover uma pasta para dentro dela mesma");
    const r: { rows: Array<{ pai_id: string | null }> } = await q<{ pai_id: string | null }>(
      `SELECT pai_id FROM ${PASTAS} WHERE id = $1 AND tenant = $2`,
      [atual, u.tenant],
    );
    atual = !r.rows[0] || r.rows[0].pai_id === null ? null : Number(r.rows[0].pai_id);
  }
}

/* ------------------------------------------------------------------ pastas */

export async function listarPastas(u: Usuario, opts: { lixeira?: boolean } = {}): Promise<Pasta[]> {
  const r = await q<{ id: string; nome: string; pai_id: string | null; arquivos: string }>(
    `SELECT p.id, p.nome, p.pai_id,
            (SELECT count(*)::text FROM ${TABELA} a
              WHERE a.tenant = p.tenant AND a.pasta_id = p.id AND a.excluido_em IS NULL) AS arquivos
       FROM ${PASTAS} p
      WHERE p.tenant = $1 AND ${opts.lixeira ? "p.excluida_em IS NOT NULL" : "p.excluida_em IS NULL"}
      ORDER BY lower(p.nome)`,
    [u.tenant],
  );
  return r.rows.map((p) => ({ id: Number(p.id), nome: p.nome, pai_id: p.pai_id === null ? null : Number(p.pai_id), arquivos: Number(p.arquivos), criada_em: "" }));
}

export async function criarPasta(u: Usuario, body: Record<string, unknown>): Promise<Pasta> {
  const nome = nomeDe(body.nome);
  const pai = body.pai_id === undefined ? null : pastaAlvo(body.pai_id);
  if (pai !== null) await pastaViva(u, pai);
  const total = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${PASTAS} WHERE tenant = $1 AND excluida_em IS NULL`, [u.tenant]);
  if (Number(total.rows[0]?.n ?? 0) >= MAX_PASTAS_POR_CONTA) throw erro422(`limite de ${MAX_PASTAS_POR_CONTA} pastas por conta`);
  const existe = await q<{ id: string }>(
    `SELECT id FROM ${PASTAS} WHERE tenant = $1 AND excluida_em IS NULL
        AND coalesce(pai_id, 0) = coalesce($2::bigint, 0) AND lower(nome) = lower($3)`,
    [u.tenant, pai, nome],
  );
  if (existe.rowCount) throw erro409(`já existe uma pasta chamada "${nome}" aqui`);
  const r = await q<{ id: string }>(
    `INSERT INTO ${PASTAS} (tenant, nome, pai_id) VALUES ($1, $2, $3) RETURNING id`,
    [u.tenant, nome, pai],
  );
  return { id: Number(r.rows[0].id), nome, pai_id: pai, arquivos: 0, criada_em: "" };
}

/** renomear e/ou mover pasta (um PATCH só, como no Windows) */
export async function editarPasta(u: Usuario, id: number, body: Record<string, unknown>): Promise<Pasta> {
  const atual = await pastaViva(u, id);
  const nome = body.nome === undefined ? atual.nome : nomeDe(body.nome);
  const pai = body.pai_id === undefined ? atual.pai_id : pastaAlvo(body.pai_id);
  if (pai !== null && pai !== atual.pai_id) {
    await pastaViva(u, pai);
    await semCiclo(u, id, pai);
  }
  if (nome !== atual.nome || pai !== atual.pai_id) {
    const existe = await q<{ id: string }>(
      `SELECT id FROM ${PASTAS} WHERE tenant = $1 AND excluida_em IS NULL AND id <> $2
          AND coalesce(pai_id, 0) = coalesce($3::bigint, 0) AND lower(nome) = lower($4)`,
      [u.tenant, id, pai, nome],
    );
    if (existe.rowCount) throw erro409(`já existe uma pasta chamada "${nome}" aqui`);
  }
  await q(`UPDATE ${PASTAS} SET nome = $2, pai_id = $3, atualizado_em = now() WHERE id = $1 AND tenant = $4`, [id, nome, pai, u.tenant]);
  return { id, nome, pai_id: pai, arquivos: 0, criada_em: "" };
}

/** ids da pasta e de todas as filhas (BFS com teto — ciclo não entra, mas o teto é rede) */
async function subtree(u: Usuario, raiz: number): Promise<number[]> {
  const todos = await q<{ id: string; pai_id: string | null }>(
    `SELECT id, pai_id FROM ${PASTAS} WHERE tenant = $1`,
    [u.tenant],
  );
  const filhos = new Map<number, number[]>();
  for (const p of todos.rows) {
    const pai = p.pai_id === null ? 0 : Number(p.pai_id);
    filhos.set(pai, [...(filhos.get(pai) ?? []), Number(p.id)]);
  }
  const saida: number[] = [];
  const fila = [raiz];
  while (fila.length && saida.length < MAX_PASTAS_POR_CONTA) {
    const atual = fila.shift() as number;
    saida.push(atual);
    fila.push(...(filhos.get(atual) ?? []));
  }
  return saida;
}

/** excluir pasta = lixeira, LEVANDO o conteúdo (é o que o Windows faz) */
export async function excluirPasta(u: Usuario, id: number, definitivo = false): Promise<{ pastas: number; arquivos: number; lixeira: boolean }> {
  const ids = await subtree(u, id);
  if (!ids.length) throw erro404("pasta não encontrada");
  const dentro = await q<{ id: string }>(
    `SELECT id FROM ${TABELA} WHERE tenant = $1 AND pasta_id = ANY($2::bigint[])`,
    [u.tenant, ids],
  );
  if (definitivo) {
    for (const a of dentro.rows) await apagarAnexo(a.id).catch(() => undefined);
    await q(`DELETE FROM ${PASTAS} WHERE tenant = $1 AND id = ANY($2::bigint[])`, [u.tenant, ids]);
    return { pastas: ids.length, arquivos: dentro.rowCount ?? 0, lixeira: false };
  }
  await q(`UPDATE ${TABELA} SET excluido_em = now(), atualizado_em = now() WHERE tenant = $1 AND pasta_id = ANY($2::bigint[])`, [u.tenant, ids]);
  await q(`UPDATE ${PASTAS} SET excluida_em = now(), atualizado_em = now() WHERE tenant = $1 AND id = ANY($2::bigint[])`, [u.tenant, ids]);
  return { pastas: ids.length, arquivos: dentro.rowCount ?? 0, lixeira: true };
}

export async function restaurarPasta(u: Usuario, id: number): Promise<{ pasta: string; para: string; arquivos: number; aviso: string }> {
  const r = await q<{ nome: string; pai_id: string | null; excluida_em: string | null }>(
    `SELECT nome, pai_id::text, excluida_em FROM ${PASTAS} WHERE id = $1 AND tenant = $2`,
    [id, u.tenant],
  );
  const p = r.rows[0];
  if (!p) throw erro404("pasta não encontrada");
  if (!p.excluida_em) return { pasta: p.nome, para: "onde já estava", arquivos: 0, aviso: "" };
  let pai = p.pai_id === null ? null : Number(p.pai_id);
  let aviso = "";
  if (pai !== null) {
    const viva = await q<{ id: string }>(`SELECT id FROM ${PASTAS} WHERE id = $1 AND tenant = $2 AND excluida_em IS NULL`, [pai, u.tenant]);
    if (!viva.rowCount) {
      pai = null;
      aviso = "a pasta de origem também estava na lixeira — voltou para a raiz";
    }
  }
  const ids = await subtree(u, id);
  await q(`UPDATE ${PASTAS} SET excluida_em = NULL, pai_id = $2, atualizado_em = now() WHERE tenant = $1 AND id = ANY($3::bigint[])`, [u.tenant, pai, ids]);
  /* o arquivo volta junto, mas só se a pasta dele voltou também (pai NULL = raiz, sempre existe) */
  const dev = await q<{ id: string }>(
    `UPDATE ${TABELA} SET excluido_em = NULL, atualizado_em = now()
      WHERE tenant = $1 AND pasta_id = ANY($2::bigint[]) AND excluido_em IS NOT NULL RETURNING id`,
    [u.tenant, ids],
  );
  return { pasta: p.nome, para: pai === null ? "a raiz" : "a pasta de origem", arquivos: dev.rowCount ?? 0, aviso };
}

/* ------------------------------------------------------------------ arquivos */

export type ArquivoFicha = {
  id: string;
  nome: string;
  mime: string;
  bytes: number;
  host: string;
  pasta_id: number | null;
  favorita: boolean;
  completo: boolean;
  criado_em: string;
  excluido_em: string | null;
};

export async function listarArquivos(
  u: Usuario,
  opts: { pasta?: unknown; q?: string; lixeira?: boolean; favoritos?: boolean; recentes?: boolean; limit?: number; offset?: number } = {},
): Promise<{ total: number; bytes: number; arquivos: ArquivoFicha[] }> {
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const busca = String(opts.q ?? "").trim().slice(0, 120);
  const cond: string[] = ["a.tenant = $1", opts.lixeira ? "a.excluido_em IS NOT NULL" : "a.excluido_em IS NULL"];
  const psql: unknown[] = [u.tenant];
  if (!opts.lixeira && !opts.favoritos && !opts.recentes && opts.pasta !== undefined) {
    /* `pasta` ausente = conta inteira (é o que a busca da tela quer); `raiz`/0/vazio = sem pasta */
    const alvo = pastaAlvo(opts.pasta);
    cond.push(alvo === null ? "a.pasta_id IS NULL" : `a.pasta_id = $${psql.push(alvo)}`);
  }
  if (opts.favoritos) cond.push("a.favorita");
  if (busca) cond.push(`nexos_unaccent(a.nome) ILIKE '%' || nexos_unaccent($${psql.push(busca)}) || '%'`);
  const w = cond.join(" AND ");
  const ordem = opts.recentes ? "a.atualizado_em DESC" : opts.lixeira ? "a.excluido_em DESC" : "lower(a.nome)";
  const r = await q<ArquivoFicha & { pai: string | null }>(
    `SELECT a.id, a.nome, a.mime, a.bytes::text, a.host, a.pasta_id::text AS pai, a.favorita, a.completo,
            a.criado_em, a.excluido_em
       FROM ${TABELA} a WHERE ${w} ORDER BY ${ordem} LIMIT $${psql.push(limit)} OFFSET $${psql.push(offset)}`,
    psql,
  );
  const t = await q<{ n: string; s: string }>(`SELECT count(*)::text AS n, coalesce(sum(a.bytes), 0)::text AS s FROM ${TABELA} a WHERE ${w}`, psql.slice(0, -2));
  return {
    total: Number(t.rows[0]?.n ?? 0),
    bytes: Number(t.rows[0]?.s ?? 0),
    arquivos: r.rows.map((a) => ({
      id: a.id,
      nome: a.nome,
      mime: a.mime,
      bytes: Number(a.bytes),
      host: a.host,
      pasta_id: a.pai === null ? null : Number(a.pai),
      favorita: a.favorita,
      completo: a.completo,
      criado_em: a.criado_em,
      excluido_em: a.excluido_em,
    })),
  };
}

/** renomear, mover, favoritar — um PATCH só cobre os três gestos da tela */
export async function editarArquivo(u: Usuario, id: string, body: Record<string, unknown>): Promise<{ id: string; nome: string; pasta_id: number | null; favorita: boolean }> {
  const limpo = String(id ?? "").trim().slice(0, 64);
  const r = await q<{ nome: string; tenant: string; pasta_id: string | null; favorita: boolean; excluido_em: string | null }>(
    `SELECT nome, tenant, pasta_id::text, favorita, excluido_em FROM ${TABELA} WHERE id = $1`,
    [limpo],
  );
  const a = r.rows[0];
  if (!a) throw erro404("arquivo não encontrado");
  if (a.tenant !== u.tenant) throw erro404("arquivo não encontrado");
  if (a.excluido_em && body.nome !== undefined) throw erro422("restaure o arquivo da lixeira antes de renomear");

  let nome = a.nome;
  if (body.nome !== undefined) {
    nome = nomeDe(body.nome);
    if (nome !== a.nome) await trocarNomeArquivo(limpo, a.tenant, nome);
  }
  let pasta = a.pasta_id === null ? null : Number(a.pasta_id);
  if (body.pasta_id !== undefined) {
    pasta = pastaAlvo(body.pasta_id);
    if (pasta !== null) await pastaViva(u, pasta);
  }
  const favorita = body.favorita === undefined ? a.favorita : body.favorita === true || body.favorita === "true";
  await q(`UPDATE ${TABELA} SET nome = $2, pasta_id = $3, favorita = $4, atualizado_em = now() WHERE id = $1`, [limpo, nome, pasta, favorita]);
  return { id: limpo, nome, pasta_id: pasta, favorita };
}

/** excluir (lixeira) ou apagar de vez, em lote */
export async function excluirArquivos(u: Usuario, ids: unknown, definitivo = false): Promise<{ ids: string[]; excluidos: number; lixeira: boolean }> {
  const lista = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? "").trim().slice(0, 64)).filter(Boolean).slice(0, 500);
  if (!lista.length) throw erro422("nenhum arquivo informado");
  const r = await q<{ id: string; tenant: string }>(`SELECT id, tenant FROM ${TABELA} WHERE id = ANY($1::text[])`, [lista]);
  /* SEM exceção para operador: arquivo de conta alheia não existe aqui (v3.79 das máquinas) */
  const delas = r.rows.filter((x) => x.tenant === u.tenant).map((x) => x.id);
  if (!delas.length) throw erro404("nenhum desses arquivos é desta conta");
  if (definitivo) {
    for (const id of delas) await apagarAnexo(id);
    return { ids: delas, excluidos: delas.length, lixeira: false };
  }
  await q(`UPDATE ${TABELA} SET excluido_em = now(), atualizado_em = now() WHERE id = ANY($1::text[])`, [delas]);
  return { ids: delas, excluidos: delas.length, lixeira: true };
}

export async function restaurarArquivos(u: Usuario, ids: unknown): Promise<{ restaurados: number; para_raiz: number; aviso: string }> {
  const lista = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? "").trim().slice(0, 64)).filter(Boolean).slice(0, 500);
  if (!lista.length) throw erro422("nenhum arquivo informado");
  const r = await q<{ id: string }>(
    `SELECT id FROM ${TABELA} WHERE id = ANY($1::text[]) AND tenant = $2 AND excluido_em IS NOT NULL`,
    [lista, u.tenant],
  );
  if (!r.rowCount) throw erro404("nada para restaurar (só a lixeira devolve arquivo)");
  /* a pasta de origem pode ter sido apagada depois do arquivo: nesse caso o arquivo volta para a
     RAIZ e a resposta diz isso — devolvê-lo para uma pasta que não existe mais é sumi-lo de novo */
  const optou = await q<{ id: string }>(
    `UPDATE ${TABELA} SET pasta_id = NULL
      WHERE id = ANY($1::text[]) AND tenant = $2 AND excluido_em IS NOT NULL
        AND pasta_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${PASTAS} p WHERE p.id = ${TABELA}.pasta_id AND p.tenant = ${TABELA}.tenant AND p.excluida_em IS NULL)
      RETURNING id`,
    [lista, u.tenant],
  );
  const dev = await q(`UPDATE ${TABELA} SET excluido_em = NULL, atualizado_em = now() WHERE id = ANY($1::text[]) AND tenant = $2`, [lista, u.tenant]);
  const n = optou.rowCount ?? 0;
  return { restaurados: dev.rowCount ?? 0, para_raiz: n, aviso: n ? `${n} arquivo(s) voltaram para a raiz: a pasta de origem está na lixeira` : "" };
}

/** esvaziar a lixeira da conta (e só dela) */
export async function esvaziarLixeira(u: Usuario): Promise<{ arquivos: number; pastas: number }> {
  const r = await q<{ id: string }>(`SELECT id FROM ${TABELA} WHERE tenant = $1 AND excluido_em IS NOT NULL`, [u.tenant]);
  for (const a of r.rows) await apagarAnexo(a.id).catch(() => undefined);
  const p = await q(`DELETE FROM ${PASTAS} WHERE tenant = $1 AND excluida_em IS NOT NULL RETURNING id`, [u.tenant]);
  return { arquivos: r.rowCount ?? 0, pastas: p.rowCount ?? 0 };
}

/** números da barra de status da tela */
export async function usadosConta(u: Usuario): Promise<{ arquivos: number; bytes: number; lixeira_itens: number; lixeira_bytes: number; pastas: number }> {
  const vivo = await q<{ n: string; s: string }>(
    `SELECT count(*)::text AS n, coalesce(sum(bytes), 0)::text AS s FROM ${TABELA} WHERE tenant = $1 AND excluido_em IS NULL`,
    [u.tenant],
  );
  const lixo = await q<{ n: string; s: string }>(
    `SELECT count(*)::text AS n, coalesce(sum(bytes), 0)::text AS s FROM ${TABELA} WHERE tenant = $1 AND excluido_em IS NOT NULL`,
    [u.tenant],
  );
  const p = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${PASTAS} WHERE tenant = $1 AND excluida_em IS NULL`, [u.tenant]);
  return {
    arquivos: Number(vivo.rows[0]?.n ?? 0),
    bytes: Number(vivo.rows[0]?.s ?? 0),
    lixeira_itens: Number(lixo.rows[0]?.n ?? 0),
    lixeira_bytes: Number(lixo.rows[0]?.s ?? 0),
    pastas: Number(p.rows[0]?.n ?? 0),
  };
}

/** "Copiar para…" do menu: duplica cada arquivo para a pasta de destino (bytes novos, ficha nova) */
export async function copiarParaPasta(u: Usuario, ids: unknown, pasta: unknown): Promise<{ copiados: string[]; pasta: string }> {
  const lista = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? "").trim().slice(0, 64)).filter(Boolean).slice(0, 100);
  if (!lista.length) throw erro422("nenhum arquivo informado");
  const alvo = pastaAlvo(pasta);
  if (alvo !== null) await pastaViva(u, alvo);
  const copiados: string[] = [];
  for (const id of lista) {
    const novo = await copiarAnexo(id, u);
    await q(`UPDATE ${TABELA} SET pasta_id = $2, atualizado_em = now() WHERE id = $1`, [novo.id, alvo]);
    copiados.push(novo.id);
  }
  return { copiados, pasta: alvo === null ? "a raiz" : `a pasta ${alvo}` };
}

/** pasta de trabalho do zip: id → caminho no disco (a lista que a tela mandou, checada por dono) */
export async function arquivosParaZip(u: Usuario, ids: unknown): Promise<Array<{ id: string; nome: string; caminho: string }>> {
  const lista = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? "").trim().slice(0, 64)).filter(Boolean).slice(0, 200);
  if (!lista.length) throw erro422("nenhum arquivo informado");
  const r = await q<{ id: string; nome: string; tenant: string }>(`SELECT id, nome, tenant FROM ${TABELA} WHERE id = ANY($1::text[])`, [lista]);
  const delas = r.rows.filter((x) => x.tenant === u.tenant);
  if (!delas.length) throw erro404("nenhum desses arquivos é desta conta");
  return delas.map((x) => ({ id: x.id, nome: x.nome, caminho: path.join(CONFIG.arquivosDir, x.tenant, x.id, x.nome) }));
}

/** faxina (v3.85): o que está na lixeira há mais de N dias morre de verdade */
export async function expurgarLixeira(alvo: string | null, dias = CONFIG.lixeiraDias): Promise<{ arquivos: number; pastas: number }> {
  const escopo = alvo ? " AND tenant = $2" : "";
  const psql = alvo ? [dias, alvo] : [dias];
  const r = await q<{ id: string }>(`SELECT id FROM ${TABELA} WHERE excluido_em IS NOT NULL AND excluido_em < now() - make_interval(days => $1)${escopo}`, psql);
  for (const a of r.rows) await apagarAnexo(a.id).catch(() => undefined);
  const p = await q(
    `DELETE FROM ${PASTAS} WHERE excluida_em IS NOT NULL AND excluida_em < now() - make_interval(days => $1)${escopo} RETURNING id`,
    psql,
  );
  return { arquivos: r.rowCount ?? 0, pastas: p.rowCount ?? 0 };
}
