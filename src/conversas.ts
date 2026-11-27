/**
 * v3.81 — CONVERSAS.
 *
 * Antes, "conversa" era o par (conta, gaveta): cada conta tinha UMA conversa por gaveta e
 * "nova conversa" APAGAVA o histórico. Agora a conversa é um objeto com id, título e data:
 * a gaveta continua sendo pasta de documentos, mas o chat pode ter quantas conversas quiser.
 *
 * Regras:
 *  - tudo é escopado por tenant (o dono do sistema vê só as conversas da conta que está usando);
 *  - nada é apagado: "apagar" na tela = `arquivada = true`;
 *  - a mensagem guarda `conversa_id`; a conversa guarda `compactado_ate` (última mensagem que
 *    entrou no resumo) para a tela desenhar a marca de compactação.
 */
import { q } from "./db.js";
import { erro404, erro422 } from "./errors.js";
import { tenantFor } from "./config.js";
import type { Usuario } from "./config.js";

export type Conversa = {
  id: number;
  titulo: string;
  memoria: string;
  arquivada: boolean;
  compactado_ate: number | null;
  criado_em: string;
  atualizado_em: string;
  mensagens: number;
  previa: string;
};

const LIMITE_TITULO = 80;

/** título que a conversa ganha sozinha: o começo da primeira pergunta, numa linha. */
export function tituloDe(pergunta: string): string {
  const t = String(pergunta ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "nova conversa";
  return t.length > LIMITE_TITULO ? `${t.slice(0, LIMITE_TITULO - 1).trimEnd()}…` : t;
}

export async function criarConversa(tenant: string, memoria: string, titulo = ""): Promise<number> {
  const r = await q<{ id: string }>(
    `INSERT INTO conversas (tenant, memoria, titulo) VALUES ($1, $2, $3) RETURNING id`,
    [tenant, memoria, titulo.slice(0, LIMITE_TITULO)],
  );
  return Number(r.rows[0]?.id);
}

/** a conversa do turno: a informada (validando dono) ou uma nova, já com título da pergunta. */
export async function conversaDoTurno(
  tenant: string,
  memoria: string,
  idInformado: unknown,
  pergunta: string,
): Promise<number> {
  const n = Number(idInformado ?? 0);
  if (Number.isFinite(n) && n > 0) {
    const r = await q(`SELECT id FROM conversas WHERE id = $1 AND tenant = $2`, [n, tenant]);
    if (r.rows.length) return n;
    /* id de outra conta ou inexistente: erro claro, não silêncio */
    throw erro404("conversa não encontrada");
  }
  /* Sem id (chamada antiga, script, curl): o turno entra na conversa mais recente da gaveta —
     é o comportamento de antes da v3.81 (uma conversa por gaveta). A tela nova sempre manda id. */
  const r = await q(
    `SELECT id FROM conversas WHERE tenant = $1 AND memoria = $2 AND arquivada = false
      ORDER BY atualizado_em DESC LIMIT 1`,
    [tenant, memoria],
  );
  if (r.rows.length) return Number(r.rows[0].id);
  return criarConversa(tenant, memoria, tituloDe(pergunta));
}

const SELECAO = `
  SELECT c.id, c.memoria, c.titulo, c.arquivada, c.compactado_ate, c.criado_em, c.atualizado_em,
         (SELECT count(*) FROM chat_mensagens m WHERE m.conversa_id = c.id) AS mensagens,
         (SELECT m.texto FROM chat_mensagens m WHERE m.conversa_id = c.id ORDER BY m.id DESC LIMIT 1) AS previa
    FROM conversas c`;

function linha(r: any): Conversa {
  return {
    id: Number(r.id),
    titulo: String(r.titulo ?? "") || "nova conversa",
    memoria: String(r.memoria ?? ""),
    arquivada: Boolean(r.arquivada),
    compactado_ate: r.compactado_ate === null || r.compactado_ate === undefined ? null : Number(r.compactado_ate),
    criado_em: r.criado_em,
    atualizado_em: r.atualizado_em,
    mensagens: Number(r.mensagens ?? 0),
    previa: String(r.previa ?? "").replace(/\s+/g, " ").slice(0, 160),
  };
}

/** lista lateral: mais recentes primeiro, opcionalmente por gaveta e/ou termo. */
export async function listarConversas(
  user: Usuario,
  opts: { memoria?: string; busca?: string; incluirArquivadas?: boolean; limite?: number; tenant?: string | null } = {},
) {
  const tenant = tenantFor(user, opts.tenant ?? null);
  const limite = Math.min(Math.max(Number(opts.limite ?? 60), 1), 200);
  const memoria = String(opts.memoria ?? "").trim();
  const busca = String(opts.busca ?? "").trim();
  const args: unknown[] = [tenant];
  let sql = `${SELECAO} WHERE c.tenant = $1`;
  if (!opts.incluirArquivadas) sql += ` AND c.arquivada = false`;
  if (memoria) {
    args.push(memoria);
    sql += ` AND c.memoria = $${args.length}`;
  }
  if (busca) {
    args.push(`%${busca}%`);
    sql += ` AND (c.titulo ILIKE $${args.length} OR EXISTS (
       SELECT 1 FROM chat_mensagens m WHERE m.conversa_id = c.id AND m.texto ILIKE $${args.length}))`;
  }
  args.push(limite);
  sql += ` ORDER BY c.atualizado_em DESC LIMIT $${args.length}`;
  const r = await q(sql, args);
  return { tenant, conversas: r.rows.map(linha) };
}

/** abre uma conversa: metadados + mensagens (mais novas por padrão). */
export async function verConversa(
  user: Usuario,
  id: number,
  opts: { limite?: number; tenant?: string | null } = {},
) {
  const tenant = tenantFor(user, opts.tenant ?? null);
  const limite = Math.min(Math.max(Number(opts.limite ?? 200), 1), 500);
  const c = await q(`${SELECAO} WHERE c.id = $1 AND c.tenant = $2`, [id, tenant]);
  if (!c.rows.length) throw erro404("conversa não encontrada");
  const meta = linha(c.rows[0]);
  const r = await q(
    `SELECT id, papel, texto, ferramentas, falas, raciocinio, rastro, fontes, custo, provedor, modelo, telas, anexos, criado_em
       FROM chat_mensagens WHERE conversa_id = $1 ORDER BY id DESC LIMIT $2`,
    [id, limite],
  );
  const mensagens = r.rows.reverse().map((m: any) => ({
    id: Number(m.id),
    papel: m.papel,
    texto: m.texto,
    ferramentas: m.ferramentas ?? [],
    falas: m.falas ?? [],
    raciocinio: m.raciocinio ?? "",
    rastro: m.rastro ?? [],
    fontes: m.fontes ?? [],
    custo: m.custo ?? null,
    provedor: m.provedor ?? "",
    modelo: m.modelo ?? "",
    telas: m.telas ?? [],
    anexos: m.anexos ?? [],
    quando: m.criado_em,
  }));
  return { tenant, conversa: meta, mensagens };
}

export async function renomearConversa(user: Usuario, id: number, titulo: string, tenantArg?: string | null) {
  const tenant = tenantFor(user, tenantArg ?? null);
  const t = String(titulo ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITE_TITULO);
  if (!t) throw erro422("título vazio");
  const r = await q(`UPDATE conversas SET titulo = $3 WHERE id = $1 AND tenant = $2 RETURNING id`, [id, tenant, t]);
  if (!r.rows.length) throw erro404("conversa não encontrada");
  return { ok: true, id, titulo: t };
}

export async function arquivarConversa(user: Usuario, id: number, arquivada: boolean, tenantArg?: string | null) {
  const tenant = tenantFor(user, tenantArg ?? null);
  const r = await q(
    `UPDATE conversas SET arquivada = $3 WHERE id = $1 AND tenant = $2 RETURNING id`,
    [id, tenant, Boolean(arquivada)],
  );
  if (!r.rows.length) throw erro404("conversa não encontrada");
  return { ok: true, id, arquivada: Boolean(arquivada) };
}

/** o turno terminou: data sobe; se a conversa ainda não tinha título, ganha o da pergunta. */
export async function tocarConversa(tenant: string, id: number, pergunta: string): Promise<void> {
  await q(
    `UPDATE conversas SET atualizado_em = now(),
            titulo = CASE WHEN btrim(titulo) = '' THEN $3 ELSE titulo END
      WHERE id = $1 AND tenant = $2`,
    [id, tenant, tituloDe(pergunta)],
  );
}

/** a compactação agiu neste turno: grava até onde o resumo cobriu (a tela usa para a marca). */
export async function marcarCompactacao(tenant: string, id: number, ate: number | null): Promise<void> {
  if (!ate) return;
  await q(`UPDATE conversas SET compactado_ate = GREATEST(COALESCE(compactado_ate, 0), $3) WHERE id = $1 AND tenant = $2`, [
    id,
    tenant,
    ate,
  ]);
}

/** busca em TODAS as conversas da conta (v3.83): título + texto, com relevância.
 *
 *  Antes era só `ILIKE` no texto e ordenado por mensagem mais nova — achava, mas não
 *  achava por ideia nem pelo título, e o trecho certo podia ficar fora do limite.
 *  Agora: (1) o TÍTULO entra na busca (a conversa aparece mesmo que nenhuma mensagem
 *  repita o termo); (2) o texto usa o dicionário `portuguese` do Postgres com
 *  `ts_rank` (radical: "notas" acha "nota"), mantendo o `ILIKE` como rede para
 *  termo curto/sem radical (stopword, número, código com hífen); (3) a ordem é
 *  relevância → mais recente. Compactação NÃO é filtro: as mensagens antigas
 *  continuam no banco e continuam sendo achadas (é o que o dono pediu, 27/11).
 */
export async function buscarConversas(
  user: Usuario,
  opts: { termo: string; limite?: number; desde?: string | null; tenant?: string | null },
) {
  const tenant = tenantFor(user, opts.tenant ?? null);
  const termo = String(opts.termo ?? "").trim();
  if (termo.length < 2) throw erro422("termo muito curto (mínimo 2 caracteres)");
  const limite = Math.min(Math.max(Number(opts.limite ?? 20), 1), 100);
  const gosto = `%${termo}%`;

  /* 1) conversas cujo TÍTULO casa com o termo (o trecho vem da última mensagem) */
  const argsTitulo: unknown[] = [tenant, gosto, limite];
  let filtroTitulo = "";
  if (opts.desde) {
    argsTitulo.push(opts.desde);
    filtroTitulo = ` AND c.atualizado_em >= $${argsTitulo.length}`;
  }
  const titulos = await q(
    `SELECT c.id AS conversa_id, c.titulo, c.memoria, c.atualizado_em,
            u.id AS mensagem_id, u.papel, u.texto, u.criado_em
       FROM conversas c
       LEFT JOIN LATERAL (
         SELECT m.id, m.papel, m.texto, m.criado_em FROM chat_mensagens m
          WHERE m.conversa_id = c.id ORDER BY m.id DESC LIMIT 1
       ) u ON true
      WHERE c.tenant = $1 AND nexos_unaccent(c.titulo) ILIKE nexos_unaccent($2)${filtroTitulo}
      ORDER BY c.atualizado_em DESC LIMIT $3`,
    argsTitulo,
  );

  /* 2) mensagens: relevância (português) OR literal, do mais relevante para o mais antigo */
  const args: unknown[] = [tenant, termo, gosto, limite];
  let filtroData = "";
  if (opts.desde) {
    args.push(opts.desde);
    filtroData = ` AND m.criado_em >= $${args.length}`;
  }
  const mensagens = await q(
    `SELECT c.id AS conversa_id, c.titulo, c.memoria, c.atualizado_em,
            m.id AS mensagem_id, m.papel, m.texto, m.criado_em,
            ts_rank(to_tsvector('portuguese', nexos_unaccent(coalesce(m.texto, ''))),
                    websearch_to_tsquery('portuguese', nexos_unaccent($2))) AS relevancia
       FROM chat_mensagens m JOIN conversas c ON c.id = m.conversa_id
      WHERE c.tenant = $1${filtroData}
        AND (nexos_unaccent(m.texto) ILIKE nexos_unaccent($3)
             OR to_tsvector('portuguese', nexos_unaccent(coalesce(m.texto, '')))
                @@ websearch_to_tsquery('portuguese', nexos_unaccent($2)))
      ORDER BY relevancia DESC, m.id DESC LIMIT $4`,
    args,
  );

  const limpo = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").slice(0, 400);
  const achados: Array<Record<string, unknown>> = [];
  const vistos = new Set<string>();
  const põe = (x: any, onde: "titulo" | "mensagem", rel: number) => {
    const chave = `${Number(x.conversa_id)}#${onde === "titulo" ? "t" : Number(x.mensagem_id)}`;
    if (vistos.has(chave)) return;
    vistos.add(chave);
    achados.push({
      conversa_id: Number(x.conversa_id),
      titulo: String(x.titulo ?? "") || "conversa sem título",
      onde,
      mensagem_id: x.mensagem_id == null ? null : Number(x.mensagem_id),
      papel: x.papel ?? null,
      trecho: limpo(x.texto),
      quando: x.criado_em ?? x.atualizado_em,
      // título é o casamento mais forte que existe: fica acima de qualquer rank de texto
      relevancia: onde === "titulo" ? 1 : Number(x.relevancia ?? 0),
    });
  };
  for (const x of titulos.rows) põe(x, "titulo", 1);
  for (const x of mensagens.rows) põe(x, "mensagem", Number(x.relevancia ?? 0));

  const cortados = achados.slice(0, limite);
  return {
    tenant,
    termo,
    /* quantos voltaram × quantos vieram de título × de texto (o modelo e o teste sabem o que pesou) */
    resumo: {
      achados: cortados.length,
      por_titulo: Math.min(titulos.rows.length, cortados.length),
      por_texto: mensagens.rows.length,
      limite,
    },
    achados: cortados,
  };
}

/** contagem para o cabeçalho da lista (e para o teste de contrato). */
export async function contarConversas(user: Usuario, tenantArg?: string | null) {
  const tenant = tenantFor(user, tenantArg ?? null);
  const r = await q(
    `SELECT count(*) FILTER (WHERE arquivada = false) AS ativas,
            count(*) FILTER (WHERE arquivada = true) AS arquivadas
       FROM conversas WHERE tenant = $1`,
    [tenant],
  );
  return { ativas: Number(r.rows[0]?.ativas ?? 0), arquivadas: Number(r.rows[0]?.arquivadas ?? 0) };
}