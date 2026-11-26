/** Usuários no BANCO (v2.7): criar/desativar pela tela, chave gerada e mostrada 1x.
 *
 *  O env (MINIRAG_USERS / MINIRAG_ADMIN; apelido antigo OPERADOR ainda vale) continua valendo como SEMENTE: no boot
 *  cada entrada é inserida se ainda não existir. Depois disso o banco é a verdade —
 *  desativar pela tela vale até para quem veio do env.
 *
 *  A chave NUNCA é gravada em claro: guardamos sha256 + os 4 últimos caracteres
 *  (só para o painel mostrar "sk-…4f2a"). Comparação em tempo constante.
 */
import crypto from "node:crypto";
import { OPERADOR, USERS, Usuario, log } from "./config";
import { erro409, erro422, erro404, erro403 } from "./errors";
import { q } from "./db";
import { dataCarencia, lerEsquecimento } from "./esquecimento";

export type Papel = "usuario" | "operador";

type Linha = {
  nome: string;
  chave_hash: string;
  chave_hint: string;
  papel: Papel;
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
  agendado_exclusao_em: string | null;
};

/** cache por hash da chave -> usuário (autenticação é O(1) e não bate no banco) */
const porHash = new Map<string, { nome: string; papel: Papel }>();
let ativos: string[] = [];
let operadores: string[] = [];

export function hashChave(chave: string): string {
  return crypto.createHash("sha256").update(chave, "utf8").digest("hex");
}

export function gerarChave(): string {
  // 24 bytes = 32 caracteres url-safe; comparável a uma chave de API comum
  return `mr_${crypto.randomBytes(24).toString("base64url")}`;
}

export function validarNome(nome: string): string {
  const n = (nome ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(n)) {
    throw erro422("nome deve ter 2-32 caracteres: letras sem acento, números, ponto, hífen ou _");
  }
  return n;
}

export async function initUsuarios(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS usuarios (
       nome TEXT PRIMARY KEY,
       chave_hash TEXT NOT NULL UNIQUE,
       chave_hint TEXT NOT NULL DEFAULT '',
       papel TEXT NOT NULL DEFAULT 'usuario',
       ativo BOOLEAN NOT NULL DEFAULT true,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  // v3.5: apagar usuário agora é AGENDAR a exclusão (carência configurável); a coluna
  // marca quando a faxina pode apagar conta + dados. NULL = conta viva normalmente.
  await q(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS agendado_exclusao_em TIMESTAMPTZ`);

  // semente do env: entra só uma vez (ON CONFLICT não mexe em quem já existe)
  const sementes: Array<[string, string, Papel]> = [
    ...OPERADOR.map(([n, k]) => [n, k, "operador"] as [string, string, Papel]),
    ...USERS.map(([n, k]) => [n, k, "usuario"] as [string, string, Papel]),
  ];
  let novas = 0;
  for (const [nome, chave, papel] of sementes) {
    const r = await q(
      // DO NOTHING sem alvo: se a MESMA chave já existe sob outro nome (rotação
      // feita pelo painel), o que conflita é chave_hash — e o boot quebrava nesse caso
      `INSERT INTO usuarios (nome, chave_hash, chave_hint, papel)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [nome, hashChave(chave), chave.slice(-4), papel],
    );
    novas += r.rowCount ?? 0;
  }
  if (novas) log(`usuarios: ${novas} semeado(s) do env`);
  await recarregarUsuarios();
}

/** Recarrega o cache em memória (chamado no boot e depois de cada mudança). */
export async function recarregarUsuarios(): Promise<void> {
  const r = await q<Linha>(`SELECT * FROM usuarios ORDER BY nome`);
  porHash.clear();
  ativos = [];
  operadores = [];
  for (const u of r.rows) {
    if (!u.ativo) continue;
    porHash.set(u.chave_hash, { nome: u.nome, papel: u.papel });
    ativos.push(u.nome);
    if (u.papel === "operador") operadores.push(u.nome);
  }
  log(`usuarios: ${ativos.length} ativo(s) (${operadores.length} operador)`);
}

/** Autentica pelo hash da chave. null = não é usuário ativo. */
export function usuarioPorChave(chave: string): Usuario | null {
  const token = chave.trim();
  if (!token) return null;
  const h = hashChave(token);
  const u = porHash.get(h);
  if (u) return { tenant: u.nome, operador: u.papel === "operador" };
  /* sem fallback para o env: desativar/trocar a chave pela tela tem de valer de imediato
     (initUsuarios sempre roda antes do servidor ouvir) */
  return null;
}

export function nomesUsuarios(): string[] {
  return [...ativos];
}

export function nomesOperadores(): string[] {
  return [...operadores];
}

export function estaAtivo(nome: string): boolean {
  return ativos.includes(nome);
}

export type UsuarioPublico = {
  nome: string;
  papel: Papel;
  ativo: boolean;
  chave_hint: string;
  criado_em: string;
  origem_env: boolean;
  gavetas: number;
  documentos: number;
  ultimo: string | null;
  /** v3.5: quando preenchido, a conta está desligada À ESPERA da faxina (recriar o nome desfaz) */
  agendado_exclusao_em: string | null;
};

export async function listarUsuarios(): Promise<UsuarioPublico[]> {
  const r = await q<Linha>(
    `SELECT * FROM usuarios ORDER BY (papel = 'operador') DESC, nome`,
  );
  const dados = await q<{ tenant: string; docs: string; gavetas: string; ultimo: string | null }>(
    `SELECT tenant, count(DISTINCT doc_id) AS docs, count(DISTINCT memoria) AS gavetas,
            max(ingested_at) AS ultimo
     FROM chunks GROUP BY tenant`,
  );
  const porTenant = new Map(dados.rows.map((d) => [d.tenant, d]));
  const doEnv = new Set([...USERS.map(([n]) => n), ...OPERADOR.map(([n]) => n)]);
  return r.rows.map((u) => {
    const d = porTenant.get(u.nome);
    return {
      nome: u.nome,
      papel: u.papel,
      ativo: u.ativo,
      chave_hint: u.chave_hint,
      criado_em: u.criado_em,
      origem_env: doEnv.has(u.nome),
      gavetas: Number(d?.gavetas ?? 0),
      documentos: Number(d?.docs ?? 0),
      ultimo: d?.ultimo ?? null,
      agendado_exclusao_em: u.agendado_exclusao_em ?? null,
    };
  });
}

export async function criarUsuario(
  nomeBruto: string,
  papelBruto: unknown,
): Promise<{ nome: string; papel: Papel; chave: string; aviso: string }> {
  const nome = validarNome(nomeBruto);
  const papel: Papel = papelBruto === "operador" ? "operador" : "usuario";
  const existe = await q<Linha>(`SELECT * FROM usuarios WHERE nome = $1`, [nome]);
  if (existe.rowCount) {
    const atual = existe.rows[0];
    // v3.5: recriar um nome AGENDADO desfaz a exclusão — a conta volta ativa, com
    // chave nova (a antiga não revalida: quem agenda um apagar não quer a chave vazando),
    // e o acervo inteiro continua onde estava porque a faxina ainda não tocou nele.
    if (!atual.agendado_exclusao_em) throw erro409(`usuario '${nome}' ja existe`);
    const chave = gerarChave();
    await q(
      `UPDATE usuarios SET chave_hash = $2, chave_hint = $3, papel = $4, ativo = true,
              agendado_exclusao_em = NULL, atualizado_em = now()
       WHERE nome = $1`,
      [nome, hashChave(chave), chave.slice(-4), papel],
    );
    await recarregarUsuarios();
    return {
      nome,
      papel,
      chave,
      aviso: `exclusao DESFEITA: '${nome}' voltou com todos os dados dele; chave nova (a anterior nao vale mais)`,
    };
  }
  const chave = gerarChave();
  await q(
    `INSERT INTO usuarios (nome, chave_hash, chave_hint, papel) VALUES ($1, $2, $3, $4)`,
    [nome, hashChave(chave), chave.slice(-4), papel],
  );
  await recarregarUsuarios();
  return {
    nome,
    papel,
    chave,
    aviso: "guarde esta chave agora: ela nao aparece de novo",
  };
}

/** Só operador. Não deixa desativar/rebaixar o último operador ativo. */
export async function atualizarUsuario(
  nomeBruto: string,
  body: { ativo?: unknown; papel?: unknown },
): Promise<{ nome: string; ativo: boolean; papel: Papel }> {
  const nome = nomeBruto.trim().toLowerCase();
  const atual = await q<Linha>(`SELECT * FROM usuarios WHERE nome = $1`, [nome]);
  if (!atual.rowCount) throw erro404(`usuario '${nome}' nao existe`);
  const u = atual.rows[0];

  if (body.ativo !== undefined && typeof body.ativo !== "boolean") {
    throw erro422("ativo deve ser true ou false");
  }
  const ativo = body.ativo === undefined ? u.ativo : body.ativo;
  const papel: Papel =
    body.papel === "operador" ? "operador" : body.papel === "usuario" ? "usuario" : u.papel;

  const perdeOperador = u.papel === "operador" && (papel !== "operador" || !ativo);
  if (perdeOperador && operadores.filter((o) => o !== nome).length === 0) {
    throw erro409("este e o ultimo administrador ativo: crie outro antes de rebaixar ou desativar");
  }

  // v3.5: reativar pela tela DEFAZ um agendamento de exclusão (mesmo efeito de recriar
  // o nome); desligar sozinho NÃO agenda nada — são botões diferentes com sentidos diferentes.
  const desfazAgenda = ativo === true;
  await q(
    `UPDATE usuarios SET ativo = $2, papel = $3, atualizado_em = now(),
            agendado_exclusao_em = CASE WHEN $4::boolean THEN NULL ELSE agendado_exclusao_em END
     WHERE nome = $1`,
    [nome, ativo, papel, desfazAgenda],
  );
  await recarregarUsuarios();
  return { nome, ativo, papel };
}

/** Gera chave nova e devolve em claro UMA vez (o painel mostra e descarta). */
export async function novaChaveUsuario(nomeBruto: string): Promise<{ nome: string; chave: string; aviso: string }> {
  const nome = nomeBruto.trim().toLowerCase();
  const existe = await q(`SELECT 1 FROM usuarios WHERE nome = $1`, [nome]);
  if (!existe.rowCount) throw erro404(`usuario '${nome}' nao existe`);
  const chave = gerarChave();
  await q(
    `UPDATE usuarios SET chave_hash = $2, chave_hint = $3, atualizado_em = now() WHERE nome = $1`,
    [nome, hashChave(chave), chave.slice(-4)],
  );
  await recarregarUsuarios();
  return { nome, chave, aviso: "chave nova: a anterior parou de funcionar agora" };
}

/** Apaga só usuário sem documento (senão o acervo fica órfão). */
// ^ REESCRITO na v3.5 (dono, 21/10): "apagar" agora AGENDA a exclusão — a conta
// desliga na hora e os dados morrem de verdade daqui à carência configurável.
// Dentro da janela, recriar o MESMO nome (ou PATCH ativo=true) desfaz tudo, com o
// acervo intacto. O último operador ativo segue irremovível (guarda da v3.2.3).
export async function removerUsuario(
  nomeBruto: string,
): Promise<{ nome: string; removido: boolean; agendado: boolean; expira_em: string | null; carencia_dias: number; aviso: string }> {
  const nome = nomeBruto.trim().toLowerCase();
  const linha = await q<{ papel: Papel; ativo: boolean; agendado_exclusao_em: string | null }>(
    `SELECT papel, ativo, agendado_exclusao_em FROM usuarios WHERE nome = $1`,
    [nome],
  );
  if (!linha.rowCount) throw erro404(`usuario '${nome}' nao existe`);
  const alvo = linha.rows[0];
  // v3.2.3: mesma guarda do PATCH. Sem isto, apagar o último operador deixava a
  // plataforma sem admin — e como a política passou a ser "só o admin vem do env",
  // não haveria mais semente para recriá-lo no próximo boot.
  if (alvo.papel === "operador" && alvo.ativo && operadores.filter((o) => o !== nome).length === 0) {
    throw erro409("este e o ultimo administrador ativo: crie outro antes de apagar");
  }

  const { efetivos } = await lerEsquecimento();
  const carencia = efetivos.dias_carencia;

  // já agendado: idempotente — devolve a janela em curso, não empurra a data
  if (alvo.agendado_exclusao_em) {
    return {
      nome,
      removido: false,
      agendado: true,
      expira_em: alvo.agendado_exclusao_em,
      carencia_dias: carencia,
      aviso: "ja estava agendado; recriar o nome dentro da janela desfaz",
    };
  }

  await q(
    `UPDATE usuarios
     SET ativo = false,
         agendado_exclusao_em = now() + make_interval(days => $2),
         atualizado_em = now()
     WHERE nome = $1`,
    [nome, carencia],
  );
  await recarregarUsuarios(); // desliga o login imediatamente (cache só tem ativos)
  return {
    nome,
    removido: false,
    agendado: true,
    expira_em: dataCarencia(carencia),
    carencia_dias: carencia,
    aviso: `login desligado; os dados dele serao apagados em ${carencia} dia(s). Recriar o nome dentro da janela desfaz`,
  };
}

/** Guarda de rota: usuário comum não mexe em contas. */
export function exigirOperador(u: Usuario): void {
  if (!u.operador) throw erro403("somente o operador pode gerenciar usuarios");
}

