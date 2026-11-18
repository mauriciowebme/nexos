/**
 * v3.6 (dono, 22/10) — MÁQUINAS: o túnel absorvido pelo nexos.
 *
 * Cada usuário pode parear as SUAS máquinas com o nexos. Um cliente leve
 * (mesma linguagem do servidor) abre WebSocket de SAÍDA para `/maquina/ws` e
 * obedece comandos — só quem tem a chave do usuário manda nas máquinas dele.
 *
 * Wire herdado do agent-tunel, tags intocadas (cliente velho não pode quebrar):
 *   1ª frame do cliente: {"token","host","os","user"}  →  {"ack":"ok"|"negado", token?}
 *   servidor → cliente:  {"cmd","rotulo","espera"}
 *   cliente → servidor:  {"exit","stdout","stderr"}
 *
 * Pareamento (a adaptação multi-tenant que o túnel nunca teve):
 *   POST /maquinas cria um token de UMA vez (expira em ~15min); o primeiro `oi`
 *   com ele grava a máquina e devolve um token de máquina de longa duração, que o
 *   cliente guarda num arquivo-irmão e usa em toda reconexão. Máquinas ficam
 *   presas ao tenant do usuário que as criou.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { q } from "./db";
import { HttpError } from "./errors";
import { log, type Usuario } from "./config";
import { hashChave, validarNome } from "./usuarios";

const PAREAMENTO_SEG = Math.min(3600, Math.max(60, Number(process.env.NEXOS_PAREAMENTO_SEG ?? 900) || 900));
const TIMEOUT_PADRAO = 30;
/* v3.39: era 120 e cortava comando legítimo (carga de modelo, build, varredura).
   O teto agora é 900s (15 min); acima disso o certo é background=true. */
const TIMEOUT_MAX = 900;
const TIMEOUT_BG = 30; // bg responde o PID na hora; a espera é só o envio

type Ligacao = {
  ws: WebSocket;
  tenant: string;
  host: string;
  nome: string;
  so: string;
  user: string;
  httpBase: string; // host do upgrade que abriu o cano (canal de upload p/ ferramentas)
  desde: string; // ISO
  pendente: ((r: RespostaMaquina) => void) | null;
  cauda: Promise<unknown>;
};

/** o que o cliente devolve por comando; `truncado` avisa que a coleta bateu o teto */
export type RespostaMaquina = { exit: number; stdout: string; stderr: string; truncado?: boolean };

const ligacoes = new Map<string, Ligacao>(); // chave `tenant|host`
const chaveDe = (tenant: string, host: string) => `${tenant}|${host}`;

export async function initMaquinas(): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS maquinas (
       tenant      VARCHAR(64) NOT NULL,
       host        VARCHAR(128) NOT NULL,
       nome        VARCHAR(64) NOT NULL DEFAULT '',
       so          TEXT NOT NULL DEFAULT '',
       usuario_win TEXT NOT NULL DEFAULT '',
       token_hash  CHAR(64) NOT NULL UNIQUE,
       ativo       BOOLEAN NOT NULL DEFAULT true,
       visto_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
       criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (tenant, host)
     )`,
  );
  /* v3.75: `visto_em` é o APERTO DE MÃO — só a conexão grava (linha abaixo, no `oi`).
     Uma máquina que mantém o cano aberto por dias fica com `visto_em` velho enquanto
     executa centenas de comandos, e o painel parecia dizer "vista há 6 dias" para uma
     máquina trabalhando agora. `ultimo_comando_em` é a atividade real, carimbada por
     todo comando despachado. ALTER no boot: as máquinas criadas antes da 3.75 não têm
     a coluna, e sem ela o SELECT da lista quebra. */
  await q(`ALTER TABLE maquinas ADD COLUMN IF NOT EXISTS ultimo_comando_em TIMESTAMPTZ`);
  /* v3.12: apagar a máquina é definitivo — o cliente que já está instalado só volta
   * com um cliente baixado DEPOIS da remoção (regra do dono: apagar exige chave nova).
   * A marca fica registrada aqui para o servidor conferir na ativação. */
  await q(
    `CREATE TABLE IF NOT EXISTS maquinas_revogadas (
       tenant      VARCHAR(64) NOT NULL,
       host        VARCHAR(128) NOT NULL,
       revogado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (tenant, host)
     )`,
  );
  await q(
    `CREATE TABLE IF NOT EXISTS pareamentos (
       id         SERIAL PRIMARY KEY,
       tenant     VARCHAR(64) NOT NULL,
       nome       VARCHAR(64) NOT NULL,
       token_hash CHAR(64) NOT NULL UNIQUE,
       expira_em  TIMESTAMPTZ NOT NULL,
       usado      BOOLEAN NOT NULL DEFAULT false,
       criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await q(
    `CREATE TABLE IF NOT EXISTS comandos_log (
       id        SERIAL PRIMARY KEY,
       tenant    VARCHAR(64) NOT NULL,
       host      VARCHAR(128) NOT NULL,
       cmd       TEXT NOT NULL,
       exit      BIGINT,
       stdout    TEXT NOT NULL DEFAULT '',
       stderr    TEXT NOT NULL DEFAULT '',
       ms        INT NOT NULL DEFAULT 0,
       origem    VARCHAR(16) NOT NULL DEFAULT 'rest',
       criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await q(`ALTER TABLE comandos_log ALTER COLUMN origem TYPE VARCHAR(64)`);
  /* v3.43: exit de processo nativo do Windows pode vir sem sinal (0x8004100C =
     2147749900) e não cabe em INT — a auditoria inteira era perdida com
     "value ... is out of range for type integer". BIGINT cobre qualquer exit. */
  await q(`ALTER TABLE comandos_log ALTER COLUMN exit TYPE BIGINT`);
  await q(
    `CREATE TABLE IF NOT EXISTS chaves_cliente (
       token_hash   CHAR(64) PRIMARY KEY,
       tenant       VARCHAR(64) NOT NULL,
       nome         VARCHAR(64) NOT NULL DEFAULT '',
       expira_em    TIMESTAMPTZ NOT NULL,
       usada        BOOLEAN NOT NULL DEFAULT false,
       host_ativado VARCHAR(128),
       criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  /* v3.10: uma chave pode ativar VÁRIAS máquinas — o contador alimenta a tela */
  await q(`ALTER TABLE chaves_cliente ADD COLUMN IF NOT EXISTS ativacoes INTEGER NOT NULL DEFAULT 0`);
  await q(
    `CREATE TABLE IF NOT EXISTS maquinas_cfg (
       chave         TEXT PRIMARY KEY,
       valor         TEXT NOT NULL,
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const cfg = await q<{ valor: string }>(`SELECT valor FROM maquinas_cfg WHERE chave = 'controle_ativo'`);
  controleCache = cfg.rows[0]?.valor !== "0";
}

/* Interruptor GLOBAL de controle (Configurações → Ferramentas (MCP)): desligado,
   NINGUÉM executa — nem chat, nem MCP externo, nem REST — porque o gate mora no
   `rodar`, que é o funil único dos três. A cache é lida em boot e toda escrita;
   o tools/list e o pacote do chat filtram a tool `rodar_comando` para o modelo
   nem sonhar que ela existe. */
let controleCache = true;

export function controleDeMaquinaAtivo(): boolean {
  return controleCache;
}

export async function gravarControleDeMaquina(v: boolean): Promise<void> {
  await q(
    `INSERT INTO maquinas_cfg (chave, valor, atualizado_em) VALUES ('controle_ativo', $1, now())
     ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = now()`,
    [v ? "1" : "0"],
  );
  controleCache = v;
}

/* ------------------------------------------------------------------ REST ---- */

export function criarPareamento(u: Usuario, alvo: string, nomeBruto: string) {
  const nome = validarNome(nomeBruto);
  const token = randomBytes(20).toString("hex"); // mesmo formato de chave: sem segredo em log
  void alvo;
  return q(
    `INSERT INTO pareamentos (tenant, nome, token_hash, expira_em)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [alvo, nome, hashChave(token), PAREAMENTO_SEG],
  ).then(() => ({
    tenant: alvo,
    nome,
    token,
    expira_em: new Date(Date.now() + PAREAMENTO_SEG * 1000).toISOString(),
    segundos: PAREAMENTO_SEG,
  }));
}

export async function listarMaquinas(alvo: string | null) {
  const r = alvo
    ? await q<any>(
        `SELECT tenant, host, nome, so, usuario_win, ativo, visto_em, ultimo_comando_em, criado_em
         FROM maquinas WHERE tenant = $1 ORDER BY host`,
        [alvo],
      )
    : await q<any>(
        `SELECT tenant, host, nome, so, usuario_win, ativo, visto_em, ultimo_comando_em, criado_em
         FROM maquinas ORDER BY tenant, host`,
      );
  return {
    maquinas: r.rows.map((m: any) => ({
      ...m,
      online: ligacoes.has(chaveDe(m.tenant, m.host)),
      desde: ligacoes.get(chaveDe(m.tenant, m.host))?.desde ?? null,
    })),
    chaves: await listarChaves(alvo),
  };
}

export async function mudarMaquina(u: Usuario, alvo: string, host: string, corpo: Record<string, any>) {
  if (typeof corpo.ativo !== "boolean") throw new HttpError(422, "ativo deve ser booleano");
  const r = await q(
    `UPDATE maquinas SET ativo = $3 WHERE tenant = $1 AND host = $2 RETURNING tenant, host, nome, ativo`,
    [alvo, host, corpo.ativo],
  );
  if (!r.rowCount) throw new HttpError(404, "máquina não encontrada");
  if (!corpo.ativo) {
    const l = ligacoes.get(chaveDe(alvo, host));
    if (l) {
      try { l.ws.terminate(); } catch { /* ignore */ }
      ligacoes.delete(chaveDe(alvo, host));
      log(`maquinas: ${alvo}|${host} DESATIVADA → conexão derrubada`);
    }
  }
  void u;
  return r.rows[0];
}

export async function apagarMaquina(alvo: string, host: string) {
  const r = await q(`DELETE FROM maquinas WHERE tenant = $1 AND host = $2 RETURNING tenant, host`, [alvo, host]);
  const l = ligacoes.get(chaveDe(alvo, host));
  if (l) {
    try { l.ws.terminate(); } catch { /* ignore */ }
    ligacoes.delete(chaveDe(alvo, host));
  }
  if (!r.rowCount) throw new HttpError(404, "máquina não encontrada");
  await q(
    `INSERT INTO maquinas_revogadas (tenant, host, revogado_em) VALUES ($1, $2, now())
     ON CONFLICT (tenant, host) DO UPDATE SET revogado_em = now()`,
    [alvo, host],
  );
  return { removida: r.rows[0] };
}

export async function listarLog(alvo: string | null, host: string | null, limite: number) {
  const r = await q<any>(
    `SELECT tenant, host, cmd, exit, stdout, stderr, ms, origem, criado_em
     FROM comandos_log WHERE ($1::text IS NULL OR tenant = $1) AND ($2::text IS NULL OR host = $2)
     ORDER BY id DESC LIMIT $3`,
    [alvo, host, Math.min(500, Math.max(1, limite))],
  );
  return { log: r.rows };
}

/* ----------------------------------------------------------------- RUN ------ */

export async function rodar(
  u: Usuario,
  alvo: string,
  host: string,
  cmd: string,
  timeoutSeg: number | undefined,
  origem: string,
  stdoutMax = 20000,
  background = false,
): Promise<{ exit: number; stdout: string; stderr: string; truncado: boolean; ms: number; host: string }> {
  if (typeof cmd !== "string" || !cmd.trim()) throw new HttpError(422, "cmd é obrigatório");
  /* T044: comandos montados pelo servidor (lote/sessão/env) chegam codificados em base64
     UTF-16LE e inflam ~11x — o teto tem de ser o do envelope, não o do texto do usuário. */
  /* v3.49.3 — o teto de 4000 é para o TEXTO do usuário; todo comando montado por uma tool
     (origem no formato `<origem>:<tool>`) já vem em base64 UTF-16 e infla ~11x. Antes só
     três tools eram reconhecidas: capturar_tela (script grande) batia em "cmd longo demais:
     4022 chars" e a ferramenta parava de funcionar. */
  const envelope = origem.startsWith("tool ") || origem.includes(":");
  const teto = envelope ? 60000 : 4000;
  if (cmd.length > teto) throw new HttpError(422, `cmd longo demais: ${cmd.length} chars (teto ${teto})`);
  if (!controleCache) throw new HttpError(409, "controle das maquinas DESLIGADO (Configuracoes > Ferramentas (MCP)) — nenhuma execucao aceita: chat, MCP ou REST");
  const espera = background
    ? TIMEOUT_BG
    : Math.min(TIMEOUT_MAX, Math.max(1, Number(timeoutSeg ?? TIMEOUT_PADRAO) || TIMEOUT_PADRAO));
  const chave = chaveDe(alvo, host);
  const l = ligacoes.get(chave);
  if (!l) throw new HttpError(404, "máquina fora do ar (nenhum cliente conectado com esse nome)");

  const t0 = Date.now();
  const resultado = await fila(l, espera, cmd, background);
  const ms = Date.now() - t0;
  const stdout = (resultado.stdout ?? "").slice(0, stdoutMax);
  const stderr = (resultado.stderr ?? "").slice(0, 8000);
  await q(
    `INSERT INTO comandos_log (tenant, host, cmd, exit, stdout, stderr, ms, origem)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [alvo, host, cmd, resultado.exit, stdout.slice(0, 20000), stderr, ms, origem],
  ).catch((e) => log(`maquinas: auditoria falhou: ${(e as Error).message}`));
  /* v3.75: atividade não é conexão. Todo comando despachado carimba a máquina — inclusive
     o que estoura o prazo (-124) e o que o cliente derruba (-1), pois o INSERT acima já
     rodou antes do throw. É a coluna que o painel mostra ao lado do aperto de mão. */
  await q(`UPDATE maquinas SET ultimo_comando_em = now() WHERE tenant = $1 AND host = $2`, [
    alvo,
    host,
  ]).catch((e) => log(`maquinas: ultimo_comando_em falhou: ${(e as Error).message}`));
  /* T043: exit -1 = o cliente caiu entre o envio e a resposta; antes virava 502
     "máquina caiu no meio do comando", que parece defeito da máquina. É reconexão: 503. */
  if (resultado.exit === -1)
    throw new HttpError(503, `maquina reconectando (${stderr || "cliente caiu no meio do comando"}) — a chamada nao foi executada; tente de novo`);
  void u;
  return { exit: resultado.exit, stdout, stderr, truncado: resultado.truncado === true, ms, host };
}

/** Serial por máquina (regra herdada do túnel: fila no mesmo host) + teto de tempo. */
function fila(l: Ligacao, espera: number, cmd: string, bg = false) {
  const proximo = l.cauda.then(
    () =>
      new Promise<RespostaMaquina>((resolve) => {
        let feito = false;
        const terminar = (r: RespostaMaquina) => {
          if (feito) return;
          feito = true;
          l.pendente = null;
          clearTimeout(religio);
          resolve(r);
        };
        l.pendente = terminar;
        const religio = setTimeout(() => {
          const dica = bg
            ? ""
            : espera >= TIMEOUT_MAX
              ? ` — teto do servidor (${TIMEOUT_MAX}s); para processo longo use background=true`
              : ` — aumente timeout (max ${TIMEOUT_MAX}s)`;
          terminar({ exit: -124, stdout: "", stderr: `sem resposta em ${espera + 8}s (espera=${espera}s)${dica}` });
        }, (espera + 8) * 1000);
        try {
          l.ws.send(JSON.stringify({ cmd, rotulo: cmd.slice(0, 60), espera, bg }));
        } catch {
          terminar({ exit: -1, stdout: "", stderr: "cano quebrado no envio" });
        }
      }),
  );
  l.cauda = proximo.catch(() => undefined);
  return proximo;
}

/* ------------------------------------------- chave assada no cliente (v3.7) --
   O painel gera um exe com a chave UNICA colada no fim do arquivo (trailer
   JSON + tamanho + magic). A chave: (a) pertence ao usuario que gerou;
   (b) so abre o cano de maquina — jamais REST/chat/painel; (c) queima no
   primeiro "oi" bem-sucedido e a maquina recebe entao a chave definitiva;
   (d) morre em 24h se o arquivo nao for levado a nenhuma maquina; (e)
   remover no painel corta na hora, ativada ou nao (depois de ativada =
   apaga a maquina inteira). NADA de autostart no boot: conecta quando o
   dono roda, reconecta enquanto aberto. */

const MAGIC_CLIENTE = "MRQK";
const CHAVE_CLIENTE_SEG = 365 * 24 * 3600; // v3.10.2: sem tela de chave, o arquivo baixado vale por um ano
const BIN_CLI = process.env.NEXOS_CLIENTE_DIR ?? path.join(process.cwd(), "agente", "bin");

export async function gerarClienteBinario(alvo: string, plataforma: "win" | "linux", nomeBruto: string) {
  const token = randomBytes(20).toString("hex");
  const nome = String(nomeBruto ?? "").trim().slice(0, 64);
  await q(
    `INSERT INTO chaves_cliente (tenant, nome, token_hash, expira_em) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [alvo, nome, hashChave(token), CHAVE_CLIENTE_SEG],
  );
  const arqBase = plataforma === "win" ? "nexos-cliente-win.exe" : "nexos-cliente-linux";
  const bin = fs.readFileSync(path.join(BIN_CLI, arqBase));
  const payload = Buffer.from(JSON.stringify({ v: 1, k: token }), "utf8");
  const rodape = Buffer.alloc(8);
  rodape.writeUInt32BE(payload.length, 0);
  rodape.write(MAGIC_CLIENTE, 4, "ascii");
  const arquivo = plataforma === "win" ? `nexos-cliente-${alvo}.exe` : `nexos-cliente-${alvo}`;
  log(`maquinas: CLIENTE GERADO para ${alvo} (${plataforma}, nome="${nome}")`);
  return { buf: Buffer.concat([bin, payload, rodape]), arquivo };
}

/* v3.10.1: a tela baixava por fetch+blob e o Edge/Chrome passou a bloquear os
 * downloads seguintes ("Precisa de autorização para transferir"). O bilhete é a
 * autorização de UM download por navegação comum: curto (2 min), uso único e
 * preso ao tenant — o endereço não carrega a chave do painel. */
const bilhetes = new Map<string, { tenant: string; plat: string; exp: number }>();
const BILHETE_MS = 120_000;

export function emitirBilheteCliente(alvo: string, plataforma: string) {
  const agora = Date.now();
  for (const [k, v] of bilhetes) if (v.exp < agora) bilhetes.delete(k);
  const t = randomBytes(18).toString("hex");
  bilhetes.set(t, { tenant: alvo, plat: plataforma, exp: agora + BILHETE_MS });
  return { bilhete: t, segundos: Math.floor(BILHETE_MS / 1000) };
}

export function resgatarBilheteCliente(t: string): { tenant: string; plat: string } | null {
  const v = bilhetes.get(String(t ?? ""));
  if (!v) return null;
  bilhetes.delete(String(t)); // uso único, mesmo se o download falhar depois
  if (v.exp < Date.now()) return null;
  return { tenant: v.tenant, plat: v.plat };
}

export async function listarChaves(alvo: string | null) {
  const r = alvo
    ? await q<any>(
        `SELECT token_hash, tenant, nome, usada, host_ativado, ativacoes, criado_em, expira_em
         FROM chaves_cliente WHERE tenant = $1 ORDER BY criado_em DESC`,
        [alvo],
      )
    : await q<any>(
        `SELECT token_hash, tenant, nome, usada, host_ativado, ativacoes, criado_em, expira_em
         FROM chaves_cliente ORDER BY criado_em DESC`,
      );
  return r.rows.map((c: any) => ({ ...c, id: String(c.token_hash).slice(0, 16) }));
}

export async function revogarChaveCliente(u: Usuario, id: string) {
  const r = await q<any>(
    `SELECT token_hash, tenant, usada, host_ativado FROM chaves_cliente WHERE token_hash LIKE $1 || '%'`,
    [id],
  );
  if (!r.rowCount) throw new HttpError(404, "chave nao encontrada");
  const ch = r.rows[0];
  if (!u.operador && ch.tenant !== u.tenant) throw new HttpError(404, "chave nao encontrada");
  /* v3.10: cortar a chave para NOVAS ativações; as máquinas já ativadas ficam com o
     token próprio delas — bloquear ou apagar continua sendo ação POR MÁQUINA. */
  const rCont = await q<any>(`SELECT ativacoes FROM chaves_cliente WHERE token_hash = $1`, [ch.token_hash]);
  const mantidas = Number(rCont.rows[0]?.ativacoes ?? 0);
  await q(`DELETE FROM chaves_cliente WHERE token_hash = $1`, [ch.token_hash]);
  log(`maquinas: CHAVE REVOGADA ${ch.tenant} (ativacoes=${mantidas} — máquinas mantidas)`);
  return { cortada: true, maquinas_mantidas: mantidas };
}

/* ------------------------------------------------------------------ HUB ----- */

type OiFrame = { token?: string; host?: string; os?: string; user?: string; v?: string };

async function receberOi(ws: WebSocket, oi: OiFrame, httpBase = ""): Promise<void> {
  const host = String(oi.host ?? "").trim().slice(0, 128);
  const token = String(oi.token ?? "").trim();
  if (!host || !token) {
    ws.send(JSON.stringify({ ack: "negado", motivo: "oi sem host/token" }));
    log(`maquinas: RECUSA oi incompleto (host="${host}" token=${token ? "sim" : "nao"})`);
    ws.close();
    return;
  }
  const hash = hashChave(token);

  // 1) token de máquina (reconexão) — o host declarado DEVE bater com o dono do token
  const m = await q<any>(
    `SELECT tenant, host, nome, ativo FROM maquinas WHERE token_hash = $1 AND host = $2`,
    [hash, host],
  );
  let registro: { tenant: string; host: string; nome: string } | null = null;
  let tokenNovo: string | null = null;
  if (m.rowCount) {
    if (!m.rows[0].ativo) {
      ws.send(JSON.stringify({ ack: "negado", motivo: "máquina desativada" }));
      log(`maquinas: REJEITADO ${m.rows[0].tenant}|${host} (desativada)`);
      ws.close();
      return;
    }
    const lin = m.rows[0] as { tenant: string; host: string; nome: string };
    registro = lin;
    await q(`UPDATE maquinas SET visto_em = now(), so = $3, usuario_win = $4 WHERE tenant = $1 AND host = $2`, [
      lin.tenant, lin.host, String(oi.os ?? "").slice(0, 40), String(oi.user ?? "").slice(0, 64),
    ]);
  } else {
    const c = await q<any>(`SELECT tenant, nome, usada, expira_em, criado_em FROM chaves_cliente WHERE token_hash = $1`, [hash]);
    if (c.rowCount) {
      // 1b) chave assada no cliente baixado do painel: ativa na primeira maquina e queima
      const ch = c.rows[0];
      /* v3.10: o cliente baixado serve para VÁRIAS máquinas. A validade da chave é a
       * janela de ATIVAÇÃO; cada máquina recebe token próprio na primeira conexão,
       * então bloquear/apagar uma não mexe nas outras. Cortar a chave só impede
       * ativações novas — quem já ativou continua com o token dele. */
      if (new Date(ch.expira_em).getTime() < Date.now()) {
        ws.send(JSON.stringify({ ack: "negado", motivo: "chave do cliente expirada — gere um cliente novo" }));
        log(`maquinas: TENTATIVA com chave vencida host=${host}`);
        ws.close();
        return;
      }
      /* v3.12: máquina apagada no painel não volta com o MESMO cliente baixado */
      const rev = await q<any>(
        `SELECT revogado_em FROM maquinas_revogadas WHERE tenant = $1 AND host = $2`,
        [ch.tenant, host],
      );
      if (rev.rowCount && new Date(ch.criado_em).getTime() <= new Date(rev.rows[0].revogado_em).getTime()) {
        ws.send(JSON.stringify({ ack: "negado", motivo: "máquina removida do painel — baixe um cliente novo" }));
        log(`maquinas: REJEITADO ${ch.tenant}|${host} (máquina revogada; chave anterior à remoção)`);
        ws.close();
        return;
      }
      tokenNovo = randomBytes(20).toString("hex");
      const rMaq = await q<any>(
        `INSERT INTO maquinas (tenant, host, nome, so, usuario_win, token_hash)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant, host) DO UPDATE SET so = EXCLUDED.so,
           usuario_win = EXCLUDED.usuario_win, token_hash = EXCLUDED.token_hash, visto_em = now()
         RETURNING (xmax = 0) AS nova`,
        [ch.tenant, host, host, String(oi.os ?? "").slice(0, 40), String(oi.user ?? "").slice(0, 64), hashChave(tokenNovo)],
      );
      const nova = rMaq.rows[0]?.nova === true;
      await q(
        `UPDATE chaves_cliente SET usada = true, host_ativado = COALESCE(host_ativado, $2),
           ativacoes = ativacoes + $3 WHERE token_hash = $1`,
        [hash, host, nova ? 1 : 0],
      );
      registro = { tenant: ch.tenant, host, nome: host };
      log(`maquinas: CLIENTE ATIVADO ${ch.tenant}|${host}${nova ? "" : " (reinstalação da mesma máquina)"}`);
    } else {
    // 2) token de pareamento (primeira vez): usa e cria a máquina
    const p = await q<any>(
      `SELECT tenant, nome, expira_em, usado FROM pareamentos WHERE token_hash = $1`,
      [hash],
    );
    if (!p.rowCount) {
      ws.send(JSON.stringify({ ack: "negado", motivo: "token desconhecido" }));
      log(`maquinas: REJEITADO host=${host} token invalido`);
      ws.close();
      return;
    }
    const par = p.rows[0];
    if (par.usado || new Date(par.expira_em).getTime() < Date.now()) {
      ws.send(JSON.stringify({ ack: "negado", motivo: "pareamento vencido ou já usado" }));
      log(`maquinas: REJEITADO host=${host} pareamento velho`);
      ws.close();
      return;
    }
    tokenNovo = randomBytes(20).toString("hex");
    await q(
      `INSERT INTO maquinas (tenant, host, nome, so, usuario_win, token_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant, host) DO UPDATE SET nome = EXCLUDED.nome, so = EXCLUDED.so,
         usuario_win = EXCLUDED.usuario_win, token_hash = EXCLUDED.token_hash, visto_em = now()`,
      [par.tenant, host, par.nome, String(oi.os ?? "").slice(0, 40), String(oi.user ?? "").slice(0, 64), hashChave(tokenNovo)],
    );
    await q(`UPDATE pareamentos SET usado = true WHERE token_hash = $1`, [hash]);
    registro = { tenant: par.tenant, host, nome: par.nome };
    log(`maquinas: PAREADA ${par.tenant}|${host}`);
    }
  }

  const reg = registro; // estreitamento final (todos os caminhos acima já garantem; TS não prova com await no meio)
  if (!reg) {
    ws.send(JSON.stringify({ ack: "negado", motivo: "interno" }));
    ws.close();
    return;
  }
  const chave = chaveDe(reg.tenant, reg.host);
  const antiga = ligacoes.get(chave);
  if (antiga && antiga.ws !== ws) {
    try { antiga.ws.terminate(); } catch { /* ignore */ }
    ligacoes.delete(chave);
    log(`maquinas: SUBSTITUIDO ${chave}`);
  }
  const lig: Ligacao = {
    httpBase,
    ws,
    tenant: reg.tenant,
    host: reg.host,
    nome: reg.nome,
    so: String(oi.os ?? ""),
    user: String(oi.user ?? ""),
    desde: new Date().toISOString(),
    pendente: null,
    cauda: Promise.resolve(),
  };
  ligacoes.set(chave, lig);
  ws.send(JSON.stringify(tokenNovo ? { ack: "ok", token: tokenNovo } : { ack: "ok" }));
  log(`maquinas: ONLINE ${chave} (so=${lig.so || "?"} user=${lig.user || "?"} vers=${String(oi.v ?? "?")})`);

  ws.on("message", (bytes) => {
    let r: any;
    try {
      r = JSON.parse(String(bytes));
    } catch {
      return;
    }
    if (r && typeof r.exit === "number" && lig.pendente) {
      lig.pendente({ exit: r.exit, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), truncado: r.truncado === true });
    }
  });
  ws.on("close", (codigo, motivoDaRede) => {
    if (ligacoes.get(chave) === lig) {
      ligacoes.delete(chave);
      if (lig.pendente) lig.pendente({ exit: -1, stdout: "", stderr: "máquina caiu no meio do comando" });
      /* v3.13.1: o código do fechamento é o que faltava para distinguir "o cliente
       * saiu por fora" (1006/sem código = processo morto) de recusa de protocolo
       * (1002/1008) ou cano parado no meio (1001). Sem isto o log ficava mudo. */
      const porque = String(motivoDaRede || "").slice(0, 80);
      log(`maquinas: OFFLINE ${chave} (código ${codigo || "?"}${porque ? ` — ${porque}` : ""}, vivo ${Math.round((Date.now() - new Date(lig.desde).getTime()) / 1000)}s)`);
    }
  });
  ws.on("error", () => { /* close cuida da limpeza */ });
}

export function anexarHubMaquinas(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    let path = "";
    try {
      path = new URL(req.url ?? "", "http://int").pathname;
    } catch {
      path = "";
    }
    if (path !== "/maquina/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let aguardandoOi = true;
      ws.once("message", (bytes) => {
        aguardandoOi = false;
        let oi: OiFrame = {};
        try {
          oi = JSON.parse(String(bytes));
        } catch {
          /* nega embaixo */
        }
        void receberOi(ws, oi, (() => {
          const proto = String(req.headers["x-forwarded-proto"] ?? (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
          const h = String(req.headers.host ?? "");
          return h ? `${proto}://${h}` : "";
        })());
      });
      setTimeout(() => {
        if (aguardandoOi) {
          try { ws.close(); } catch { /* ignore */ }
        }
      }, 10_000).unref?.();
    });
  });
  // heartbeat: Traefik fecha cano ocioso; Ping 25s é a receita provada no túnel
  setInterval(() => {
    for (const [, l] of ligacoes) {
      try { l.ws.ping(); } catch { /* ignore */ }
    }
  }, 25_000).unref?.();
}

/** Alvo de escopo: comum = sempre o próprio; operador = ?tenant ou o próprio. */
/** plataforma da máquina ENQUANTO conectada (as ferramentas precisam para escolher o builder PS/sh) */
export function soConectado(alvo: string, host: string): string | null {
  return ligacoes.get(chaveDe(alvo, host))?.so ?? null;
}

/** URL de retorno que a máquina viu no handshake (canal one-time p/ escrever_arquivo) */
export function httpBaseDaMaquina(alvo: string, host: string): string | null {
  return ligacoes.get(chaveDe(alvo, host))?.httpBase || null;
}

export function alvoMaquina(u: Usuario, arg?: string | null): string {
  return u.operador ? String(arg ?? "").trim() || u.tenant : u.tenant;
}

/* ------------------------------- canal de VOLTA (máquina -> servidor) -------
   O upload de ida (`criarUpload` + `GET /maquina/u`) leva arquivo do servidor
   para a máquina. Este é o sentido contrário: a máquina faz POST do arquivo e
   o servidor guarda como ANEXO (print, imagem, log) — sem base64 no WebSocket
   e sem o teto de resposta. Chave one-time, presa à máquina, TTL de 5 min. */

export type Recebimento = { tenant: string; host: string; nome: string; mime: string; expira: number };
const recebimentos = new Map<string, Recebimento>();

export function criarRecebimento(tenant: string, host: string, nome: string, mime: string): string {
  const chave = randomBytes(16).toString("hex");
  recebimentos.set(chave, { tenant, host, nome, mime, expira: Date.now() + 5 * 60_000 });
  if (recebimentos.size > 64) {
    const agora = Date.now();
    for (const [k, r] of recebimentos) if (r.expira < agora || recebimentos.size > 64) recebimentos.delete(k);
  }
  return chave;
}

export function consumirRecebimento(chave: string, host: string): Recebimento | null {
  const r = recebimentos.get(chave);
  if (!r || r.expira < Date.now() || r.host !== host) return null;
  recebimentos.delete(chave);
  return r;
}
