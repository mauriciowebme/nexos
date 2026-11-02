/* v3.19 — providers múltiplos. O `provider_config` (escopo único) continua sendo o
 * "padrão" da casa; aqui mora a LISTA de provedores nomeados que o usuário pode
 * cadastrar e escolher na hora da conversa. Descoberta de modelos segue o padrão
 * medido no Hermes (catálogo com refresh) e no Open WebUI (conexões + /v1/models):
 * batemos em `<base>/models`; se não houver, tentamos `<base>/v1/models`; por
 * último `<base>/api/tags` (Ollama nativo). A lista volta com a resposta `fim`
 * e fica em cache na linha (o painel mostra "cacheado em ..."). */

import { erro409, erro422 } from "./errors";
import { q } from "./db";
import { tenantFor, type Usuario } from "./config";
import { mascararChave } from "./provider";

const GLOBAL = "*";
type Linha = Record<string, any>;

export type ProvedorPub = {
  id: number;
  nome: string;
  tipo: string;
  base_url: string;
  modelo: string;
  chave_mascarada: string;
  ativo: boolean;
  padrao: boolean;
  /** v3.60: público = todo mundo vê; privado (false) = só o dono do escopo vê */
  publico: boolean;
  escopo: string;
  modelos: string[];
  modelos_em: string | null;
};

/* v3.60 — um provedor pertence ao escopo em que nasceu: `*` (do operador, global) ou o
 * tenant. "Publico" decide se os outros veem. Regra pedida pelo dono:
 *   - público: todo mundo vê (qualquer conta);
 *   - privado: só quem é do escopo dono vê; o operador vê tudo;
 *   - nenhum provedor visível => sem chat (não existe mais "padrão da casa" escondido). */
export function podeVerProvedor(user: Usuario, l: Record<string, any>): boolean {
  if (user.operador) return true;
  if (Boolean(l.publico)) return true;
  /* privado: só a conta dona do escopo. Escopo global (`*`) é a conta do operador — privado ali
     é do operador e de mais ninguém (antes disto, `*` vazava como "público" sem o dono marcar). */
  return user.tenant !== GLOBAL && String(l.escopo) === user.tenant;
}

export async function initProvedores(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS provedores (
       id BIGSERIAL PRIMARY KEY,
       escopo TEXT NOT NULL,
       nome TEXT NOT NULL,
       tipo TEXT NOT NULL DEFAULT 'litellm',
       base_url TEXT NOT NULL,
       chave TEXT NOT NULL DEFAULT '',
       modelo TEXT NOT NULL DEFAULT '',
       temperatura DOUBLE PRECISION NOT NULL DEFAULT 0.2,
       system_prompt TEXT NOT NULL DEFAULT '',
       mcp_interno BOOLEAN NOT NULL DEFAULT true,
       max_rodadas INT NOT NULL DEFAULT 5,
       ativo BOOLEAN NOT NULL DEFAULT true,
       padrao BOOLEAN NOT NULL DEFAULT false,
       modelos JSONB NOT NULL DEFAULT '[]'::jsonb,
       modelos_em TIMESTAMPTZ,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (escopo, nome))`,
  );
  await q(`CREATE INDEX IF NOT EXISTS provedores_escopo_idx ON provedores (escopo, padrao, ativo)`);
  /* memória/orçamento do provedor nomeado: mesma prateleira do provider_config */
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS memoria_turnos INT NOT NULL DEFAULT 12`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS verbatim_turnos INT NOT NULL DEFAULT 4`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS reserva_tokens INT NOT NULL DEFAULT 1024`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS contexto_tokens INT`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS contexto_detectado INT`);
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS silencio_s INT NOT NULL DEFAULT 0`);
  /* v3.60 — visibilidade: público (todos) x privado (só o dono do escopo). */
  await q(`ALTER TABLE provedores ADD COLUMN IF NOT EXISTS publico BOOLEAN NOT NULL DEFAULT true`);
  /* migração única do "padrão da casa" (provider_config da conta do operador) para a lista,
     para que o Clauricio apareça na tela como qualquer outro provedor. Idempotente: só entra
     se a lista ainda não tem um provedor com a mesma URL e o mesmo modelo. */
  for (const escopo of [GLOBAL, "admin"]) {
    await q(
      `INSERT INTO provedores (escopo, nome, tipo, base_url, chave, modelo, temperatura, system_prompt,
          mcp_interno, max_rodadas, ativo, padrao, publico, memoria_turnos, verbatim_turnos, reserva_tokens,
          contexto_tokens, silencio_s, modelos, atualizado_em)
       SELECT p.escopo, upper(left(p.modelo, 1)) || substr(p.modelo, 2), p.tipo, p.base_url, p.chave, p.modelo,
              p.temperatura, '', p.mcp_interno, p.max_rodadas, p.ativo, $2::boolean, $2::boolean,
              p.memoria_turnos, p.verbatim_turnos, p.reserva_tokens, p.contexto_tokens, p.silencio_s, '[]'::jsonb, now()
         FROM provider_config p
        WHERE p.escopo = $1 AND p.base_url <> '' AND p.modelo <> ''
          AND NOT EXISTS (SELECT 1 FROM provedores v
                           WHERE v.escopo IN (p.escopo, '*') AND v.base_url = p.base_url AND v.modelo = p.modelo)
          AND NOT EXISTS (SELECT 1 FROM provedores v
                           WHERE v.escopo IN (p.escopo, '*') AND v.nome = upper(left(p.modelo, 1)) || substr(p.modelo, 2))
       ON CONFLICT (escopo, nome) DO NOTHING`,
      [escopo, escopo === GLOBAL],
    );
  }
  /* a tarefa em curso precisa lembrar qual provedor/modelo o usuário escolheu */
  await q(`ALTER TABLE chat_tarefas ADD COLUMN IF NOT EXISTS provedor TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE chat_tarefas ADD COLUMN IF NOT EXISTS modelo TEXT NOT NULL DEFAULT ''`);
  /* v3.19: a resposta guarda quem respondeu — o "via X" sobrevive ao reabrir a conversa */
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS provedor TEXT`);
  await q(`ALTER TABLE chat_mensagens ADD COLUMN IF NOT EXISTS modelo TEXT NOT NULL DEFAULT ''`);
}

function limpaTipo(v: unknown): string {
  return v === "openai" ? "openai" : v === "ollama" ? "ollama" : "litellm";
}

function validaBase(v: unknown): string {
  const base = String(v ?? "").trim().replace(/\/+$/, "");
  if (!base) throw erro422("base_url é obrigatória");
  if (!/^https?:\/\//i.test(base)) throw erro422("base_url deve começar com http:// ou https://");
  return base;
}

function paraPub(l: Linha): ProvedorPub {
  return {
    id: Number(l.id),
    nome: String(l.nome),
    tipo: String(l.tipo),
    base_url: String(l.base_url),
    modelo: String(l.modelo),
    chave_mascarada: mascararChave(String(l.chave ?? "")),
    ativo: Boolean(l.ativo),
    padrao: Boolean(l.padrao),
    publico: l.publico === undefined || l.publico === null ? true : Boolean(l.publico),
    escopo: String(l.escopo),
    modelos: Array.isArray(l.modelos) ? (l.modelos as string[]).map(String) : [],
    modelos_em: l.modelos_em ? new Date(l.modelos_em).toISOString() : null,
  };
}

/** O que o usuário pode ver: públicos + os do próprio escopo; chave sempre mascarada.
 *  v3.60: a visibilidade é a regra do dono (público x privado), não o escopo sozinho. */
export async function listarProvedores(user: Usuario, tenantArg?: string | null): Promise<ProvedorPub[]> {
  const escopo = tenantFor(user, tenantArg ?? null);
  const r = await q<Linha>(`SELECT * FROM provedores ORDER BY padrao DESC, nome`);
  return r.rows
    .filter((l) => {
      /* o operador olhando outro cliente vê o que aquele cliente vê (a tela mostra ?tenant=) */
      const alvo: Usuario = user.operador && tenantArg ? { tenant: String(tenantArg), operador: false } : user;
      return podeVerProvedor(alvo, l);
    })
    .map(paraPub);
}

type CorpoProvedor = {
  nome?: unknown;
  tipo?: unknown;
  base_url?: unknown;
  chave?: unknown;
  modelo?: unknown;
  temperatura?: unknown;
  system_prompt?: unknown;
  global?: unknown;
  mcp_interno?: unknown;
  max_rodadas?: unknown;
  ativo?: unknown;
  padrao?: unknown;
  publico?: unknown;
  tenant?: unknown;
};

/** Cria ou substitui um provedor nomeado. Só o operador escreve (mesma regra do provider). */
export async function salvarProvedor(user: Usuario, corpo: CorpoProvedor): Promise<ProvedorPub> {
  if (!user.operador) throw erro409("só o operador cadastra provedores");
  /* escopo como no provider da casa: tenant:"global" = "*" (visível a todos);
   * tenant:"<nome>" = linha daquele tenant; sem tenant = linha do próprio operador. */
  const alvo = String(corpo.tenant ?? "").trim();
  const escopo = alvo === "global" || corpo.global === true ? GLOBAL : user.operador ? tenantFor(user, alvo) : user.tenant;
  const nome = String(corpo.nome ?? "").trim();
  if (!nome || nome.length > 60) throw erro422("nome do provedor é obrigatório (até 60 caracteres)");
  const base = validaBase(corpo.base_url);
  const modelo = String(corpo.modelo ?? "").trim();
  const temperatura = corpo.temperatura === undefined ? 0.2 : Number(corpo.temperatura);
  if (!Number.isFinite(temperatura) || temperatura < 0 || temperatura > 1) throw erro422("temperatura deve estar entre 0 e 1");
  const anterior = await q<Linha>(`SELECT * FROM provedores WHERE escopo = $1 AND nome = $2`, [escopo, nome]);
  const l = anterior.rows[0];
  /* v3.69: omitir max_rodadas ao EDITAR preserva a linha (antes resetava para 5 em silêncio,
     igual ao defeito do prompt que a v3.34 consertou). O CHAT nem lê mais este campo:
     rodadas/memória/intactas são da CONTA (tela Comportamento) e valem para todo provedor. */
  const maxRodadas = corpo.max_rodadas === undefined ? Number(l?.max_rodadas ?? 5) : Number(corpo.max_rodadas);
  if (!Number.isInteger(maxRodadas) || maxRodadas < 0 || maxRodadas > 60) throw erro422("max_rodadas deve ser 0–60");
  /* v3.34: omitir as instruções ao EDITAR preserva as que já estavam (antes zerava sem avisar);
     provedor novo sem instruções nasce vazio — `""` explícito também é conversa pura. */
  const prompt = corpo.system_prompt === undefined ? String(l?.system_prompt ?? "") : String(corpo.system_prompt);
  if (prompt.length > 8000) throw erro422("instruções com no máximo 8000 caracteres");
  const chave =
    corpo.chave === undefined || corpo.chave === null || corpo.chave === "***" ? String(l?.chave ?? "") : String(corpo.chave);
  const padraoDesejado = corpo.padrao === undefined ? Boolean(l?.padrao) : Boolean(corpo.padrao);
  /* v3.60 — público nasce marcado (padrão do dono: provedor novo já atende todos);
     "privado" = só o dono do escopo vê. */
  const publico = corpo.publico === undefined ? (l ? Boolean(l.publico) : true) : Boolean(corpo.publico);
  if (ativoDe(corpo, l) && !l && !modelo) {
    // o primeiro provedor ativo precisa de modelo (senão o chat não tem para quem falar)
    throw erro422("modelo é obrigatório");
  }
  void padraoDesejado; // aplicado adiante

  const r = await q<Linha>(
    `INSERT INTO provedores (escopo, nome, tipo, base_url, chave, modelo, temperatura, system_prompt, mcp_interno, max_rodadas, ativo, padrao, publico, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (escopo, nome) DO UPDATE SET
       tipo=$3, base_url=$4, chave=$5, modelo=$6, temperatura=$7, system_prompt=$8,
       mcp_interno=$9, max_rodadas=$10, ativo=$11, padrao=$12, publico=$13, atualizado_em=now()
     RETURNING *`,
    [
      escopo,
      nome,
      limpaTipo(corpo.tipo),
      base,
      chave,
      modelo,
      temperatura,
      prompt,
      corpo.mcp_interno === undefined ? (l ? Boolean(l.mcp_interno) : true) : Boolean(corpo.mcp_interno),
      maxRodadas,
      corpo.ativo === undefined ? true : Boolean(corpo.ativo),
      false, // "padrão" é um por escopo: movido por definirPadrao
      publico,
    ],
  );
  if (corpo.padrao === true) await definirPadraoNoEscopo(escopo, Number(r.rows[0].id));
  else if (corpo.padrao === undefined && l?.padrao) await q(`UPDATE provedores SET padrao = true WHERE id = $1`, [Number(l.id)]);
  const volta = await q<Linha>(`SELECT * FROM provedores WHERE id = $1`, [Number(r.rows[0].id)]);
  return paraPub(volta.rows[0]);
}

function ativoDe(corpo: CorpoProvedor, l: Linha | undefined): boolean {
  return corpo.ativo === undefined ? (l ? Boolean(l.ativo) : true) : Boolean(corpo.ativo);
}

async function definirPadraoNoEscopo(escopo: string, id: number): Promise<void> {
  await q(`UPDATE provedores SET padrao = false WHERE escopo = $1 AND id <> $2`, [escopo, id]);
  await q(`UPDATE provedores SET padrao = true WHERE id = $2 AND escopo = $1`, [escopo, id]);
}

/** Marca como padrão do escopo (um por escopo). A escolha do chat não depende disso. */
export async function definirPadrao(user: Usuario, id: number, tenantArg?: string | null): Promise<ProvedorPub> {
  if (!user.operador) throw erro409("só o operador define o padrão");
  const escopo = tenantFor(user, tenantArg ?? null);
  const r = await q<Linha>(`SELECT * FROM provedores WHERE id = $1 AND escopo = ANY($2)`, [
    id,
    user.operador ? [escopo, GLOBAL] : [escopo],
  ]);
  const l = r.rows[0];
  if (!l) throw erro409("provedor não encontrado");
  await definirPadraoNoEscopo(String(l.escopo), id);
  /* v3.60.1: a resposta devolve a linha RELIDA — `l` foi lida antes do update e voltava
     com `padrao: false` (a tela mostrava o provedor recém-marcado como não-padrão). */
  const atual = await q<Linha>(`SELECT * FROM provedores WHERE id = $1`, [id]);
  return paraPub(atual.rows[0] ?? l);
}

export async function apagarProvedor(user: Usuario, id: number): Promise<{ ok: boolean }> {
  if (!user.operador) throw erro409("só o operador apaga provedores");
  const r = await q<Linha>(
    `DELETE FROM provedores WHERE id = $1 AND escopo = ANY($2) RETURNING id`,
    [id, [user.tenant, GLOBAL]],
  );
  if (!r.rows[0]) throw erro409("provedor não encontrado");
  return { ok: true };
}

/** Descoberta: `GET <base>/models` → `GET <base>/v1/models` → `GET <base>/api/tags`.
 *  8s de teto; erros viram resposta honesta, nunca queda do painel. */
export async function descobrirModelos(base: string, chave: string, tipo?: string): Promise<string[]> {
  const limpo = base.replace(/\/+$/, "");
  const alvos: Array<{ url: string; Extrai: (j: any) => string[] }> =
    tipo === "ollama"
      ? [
          { url: `${limpo}/api/tags`, Extrai: (j) => (Array.isArray(j?.models) ? j.models.map((m: any) => String(m?.name ?? "")) : []) },
          { url: `${limpo}/models`, Extrai: extraiOpenAI },
          { url: `${limpo}/v1/models`, Extrai: extraiOpenAI },
        ]
      : [
          { url: `${limpo}/models`, Extrai: extraiOpenAI },
          { url: `${limpo}/v1/models`, Extrai: extraiOpenAI },
        ];
  for (const alvo of alvos) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(alvo.url, {
        headers: chave ? { authorization: `Bearer ${chave}` } : {},
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!resp.ok) continue;
      const j = await resp.json();
      const lista = [...new Set(alvo.Extrai(j).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      if (lista.length) return lista;
    } catch {
      /* tenta o próximo alvo */
    }
  }
  return [];
}

function extraiOpenAI(j: any): string[] {
  const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return arr.map((m: any) => String(m?.id ?? m?.name ?? "")).filter(Boolean);
}

/** Descobrir e gravar o cache na linha. Sem id = descoberta avulsa (formulário antes de salvar). */
export async function provarModelos(
  user: Usuario,
  corpo: { id?: unknown; base_url?: unknown; chave?: unknown; tipo?: unknown },
): Promise<{ modelos: string[]; em: string; id: number | null; janela_detectada?: number | null }> {
  if (!user.operador) throw erro409("só o operador descobre modelos");
  const id = corpo.id === undefined || corpo.id === null || corpo.id === "" ? null : Number(corpo.id);
  let base = "";
  let chave = "";
  let tipo: string | undefined;
  if (id !== null) {
    const r = await q<Linha>(`SELECT * FROM provedores WHERE id = $1 AND escopo = ANY($2)`, [id, [user.tenant, GLOBAL]]);
    const l = r.rows[0];
    if (!l) throw erro409("provedor não encontrado");
    base = String(l.base_url);
    chave = corpo.chave === undefined || corpo.chave === "***" || corpo.chave === "" ? String(l.chave ?? "") : String(corpo.chave);
    tipo = String(l.tipo);
  } else {
    base = validaBase(corpo.base_url);
    chave = String(corpo.chave ?? "");
    tipo = corpo.tipo ? limpaTipo(corpo.tipo) : undefined;
  }
  const modelos = await descobrirModelos(base, chave, tipo);
  const em = new Date().toISOString();
  if (id !== null) await q(`UPDATE provedores SET modelos = $2::jsonb, modelos_em = now() WHERE id = $1`, [id, JSON.stringify(modelos)]);
  return { modelos, em, id };
}
