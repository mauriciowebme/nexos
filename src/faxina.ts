/**
 * v3.5 (dono, 21/10): a FAXINA — camada que apaga DE VERDADE, sempre depois de uma
 * janela configurável (nunca por decisão instantânea):
 *
 *  1. usuário com `agendado_exclusao_em` vencido → some a conta E todos os dados do
 *     tenant (chunks, fonte, arquivo original, gavetas, jobs, chats e tarefas — as
 *     chamadas de ferramenta morrem junto, vivem embutidas nelas — e provider dele).
 *     Dentro da janela, recriar o nome DEFAZ.
 *  2. documento ARQUIVADO há mais de `dias_excluir_arquivado` → vira exclusão
 *     definitiva. Arquivado é o "esquecimento" (volta ao ser usado); este é o teto:
 *     esquecido por um ano (configurável) morre. Chunks VIVOS do mesmo doc impedem
 *     o expurgo (bool_and), e o marco usado é o archived_at MAIS RECENTE do doc
 *     (revivals parciais renovaem o relógio).
 *
 * Nada aqui corre sozinho em request de leitura: só no loop periódico e no
 * POST /decay (que sempre foi "forçar agora").
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config";
import { q, tx } from "./db";
import { lerEsquecimento } from "./esquecimento";
import { recarregarUsuarios } from "./usuarios";
import { expurgarLixeira } from "./arquivos"; // v3.85: lixeira da tela Arquivos morre em 30 dias

export type FaxinaResultado = {
  usuarios_apagados: string[];
  docs_expurgados: number;
  chunks_expurgados: number;
  /* v3.85: o que a LIXEIRA da tela Arquivos perdeu (30 dias) */
  lixeira_arquivos: number;
  lixeira_pastas: number;
};

/** Expurgo físico do tenant inteiro. Tx única: ou sai tudo, não sai nada. */
async function apagarTenant(nome: string): Promise<void> {
  /* v3.85 (achei ao ligar a lixeira): a conta apagada deixava para TRÁS os arquivos que a
     máquina dela mandou — a tabela `anexos_maquina` não estava nesta lista, então a ficha e os
     bytes sobreviviam na pasta do volume depois de a conta morrer. Dados de uma conta que não
     existe mais não podem ficar no disco de outra. `pastas_arquivos` idem. */
  const fichas = await q<{ id: string; nome: string }>(
    `SELECT id, nome FROM anexos_maquina WHERE tenant = $1`,
    [nome],
  ).catch(() => null);
  await tx(async (c) => {
    for (const tabela of [
      "chunks", "documents", "arquivos", "gavetas", "ingest_jobs",
      "chat_mensagens", "chat_tarefas",
      // v3.6: apagar o usuário leva as máquinas dele junto (pareamentos pendentes e rastro)
      "maquinas", "pareamentos", "comandos_log",
      // v3.85: arquivos do explorador e as pastas da conta
      "anexos_maquina", "pastas_arquivos",
    ]) {
      /* só o que EXISTE nesta base: uma tabela de versão antiga ausente não pode abortar a
         transação inteira (e abortar a tx deixaria a conta apagada com dados sobrando) */
      const tem = await c.query(`SELECT to_regclass($1) AS r`, [tabela]);
      if (!tem.rows[0]?.r) continue;
      await c.query(`DELETE FROM ${tabela} WHERE tenant = $1`, [nome]);
    }
    await c.query(`DELETE FROM provider_config WHERE escopo = $1`, [nome]);
    await c.query(`DELETE FROM usuarios WHERE nome = $1`, [nome]);
  });
  /* o disco sai DEPOIS do commit: se a transação falhar nenhuma ficha existirá apontando para
     um caminho apagado (o contrário deixaria arquivo órfão sem dono) */
  const pastaDe = String(nome).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "_";
  for (const a of fichas?.rows ?? []) {
    await fsp.rm(path.join(CONFIG.arquivosDir, pastaDe, a.id), { recursive: true, force: true }).catch(() => undefined);
  }
  await fsp.rm(path.join(CONFIG.arquivosDir, pastaDe), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Roda as duas frentes. `tenant` limita o alcance (rota /decay de usuário comum só
 * mexe no próprio); null = global (loop e operador).
 */
export async function faxina(tenant?: string | null): Promise<FaxinaResultado> {
  const { efetivos } = await lerEsquecimento();
  const alvo = tenant !== null && tenant !== undefined ? tenant : null;
  const resultado: FaxinaResultado = { usuarios_apagados: [], docs_expurgados: 0, chunks_expurgados: 0, lixeira_arquivos: 0, lixeira_pastas: 0 };

  // 1) contas agendadas vencidas
  const venc = await q<{ nome: string }>(
    `SELECT nome FROM usuarios
     WHERE agendado_exclusao_em IS NOT NULL AND agendado_exclusao_em <= now()
       ${alvo ? "AND nome = $1" : ""}`,
    alvo ? [alvo] : [],
  );
  for (const { nome } of venc.rows) {
    await apagarTenant(nome);
    resultado.usuarios_apagados.push(nome);
  }
  if (resultado.usuarios_apagados.length) await recarregarUsuarios();

  // 2) arquivados além da janela de morte — por DOCUMENTO inteiro
  const dias = efetivos.dias_excluir_arquivado;
  const escopoChunk = alvo ? " AND tenant = $2" : "";
  const psql = alvo ? [dias, alvo] : [dias];
  const docs = await q<{ tenant: string; memoria: string; doc_id: string }>(
    `SELECT tenant, memoria, doc_id FROM chunks
     GROUP BY tenant, memoria, doc_id
     HAVING bool_and(archived_at IS NOT NULL)
        AND max(archived_at) < now() - make_interval(days => $1)${escopoChunk}`,
    psql,
  );
  if (docs.rows.length) {
    for (const d of docs.rows) {
      // tx por doc: só apaga se NO MOMENTO de apagar o doc ainda está 100% arquivado
      // (um acesso no meio do caminho revive tudo — nunca destrói documento vivo).
      const feitas = await tx(async (c) => {
        const vivo = await c.query(
          `SELECT 1 FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3 AND archived_at IS NULL LIMIT 1`,
          [d.tenant, d.memoria, d.doc_id],
        );
        if (vivo.rowCount) return 0;
        const ch = await c.query(`DELETE FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`, [d.tenant, d.memoria, d.doc_id]);
        await c.query(`DELETE FROM documents WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`, [d.tenant, d.memoria, d.doc_id]);
        await c.query(`DELETE FROM arquivos WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`, [d.tenant, d.memoria, d.doc_id]);
        return ch.rowCount ?? 0;
      });
      if (feitas > 0) {
        resultado.docs_expurgados += 1;
        resultado.chunks_expurgados += feitas;
      }
    }
    // gavetas que ficaram sem documento algum perdem o registro (a linha "padrão" não é
    // registrada, então só somem as criadas de verdade e agora esvaziadas)
    await q(
      `DELETE FROM gavetas g
       WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.tenant = g.tenant AND c.memoria = g.memoria)
         AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.tenant = g.tenant AND d.memoria = g.memoria)
         AND NOT EXISTS (SELECT 1 FROM ingest_jobs j WHERE j.tenant = g.tenant AND j.memoria = g.memoria AND j.status IN ('na_fila','processando'))`,
    );
  }

  // 3) v3.85 — LIXEIRA da tela Arquivos: o que está lá há mais de NEXOS_LIXEIRA_DIAS (30) morre
  //    de verdade (disco + ficha). Roda no MESMO loop: faxina de lixeira solta em script é exatamente
  //    o que a regra da casa proíbe — a rotina tem que viver no sistema.
  const lixo = await expurgarLixeira(alvo);
  resultado.lixeira_arquivos = lixo.arquivos;
  resultado.lixeira_pastas = lixo.pastas;

  void CONFIG; // (defaults já entram via lerEsquecimento; mantém o import útil se a política mudar)
  return resultado;
}

let timer: NodeJS.Timeout | null = null;

/** Loop periódico: mesmo intervalo do decay. Falha nunca derruba o servidor. */
export function iniciarFaxinaLoop(onUsuarioApagou: (nomes: string[]) => void): void {
  if (!CONFIG.decayAtivo) return;
  timer = setInterval(async () => {
    try {
      const r = await faxina();
      if (r.usuarios_apagados.length || r.docs_expurgados || r.lixeira_arquivos || r.lixeira_pastas) {
        if (r.usuarios_apagados.length) onUsuarioApagou(r.usuarios_apagados);
        process.stdout.write(
          `[nexos] faxina: ${r.usuarios_apagados.length} conta(s), ${r.docs_expurgados} doc(s) arquivado(s) apagado(s)` +
            `${r.lixeira_arquivos || r.lixeira_pastas ? `, lixeira: ${r.lixeira_arquivos} arquivo(s)/${r.lixeira_pastas} pasta(s)` : ""}\n`,
        );
      }
    } catch (e) {
      process.stdout.write(`[nexos] faxina falhou: ${(e as Error).message}\n`);
    }
  }, CONFIG.decayIntervaloMinutos * 60 * 1000);
  timer.unref?.();
}

export function pararFaxinaLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
