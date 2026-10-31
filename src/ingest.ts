/** Fila de ingestão: enfileirar (202), worker serial e processamento. */
import { CONFIG, log } from "./config";
import { q } from "./db";
import { chunkText } from "./chunk";
import { embedUm } from "./embed";
import { erro400, erro413, iso } from "./errors";

export type IngestBody = {
  doc_id: string;
  title?: string | null;
  content: string;
  memoria?: string;
  tenant?: string | null;
};

export type JobRow = {
  id: number;
  tenant: string;
  memoria: string;
  doc_id: string;
  title: string | null;
  content: string;
  chunks_total: number;
};

/** Valida e ENFILEIRA (não gera embedding aqui). */
export async function enqueueIngest(body: IngestBody, tenant: string) {
  const memoria = (body.memoria ?? "").trim();
  const chunks = chunkText(body.content, CONFIG.maxChunkWords, CONFIG.chunkOverlap);
  if (!chunks.length) throw erro400("nada para ingerir");

  const totalRes = await q<{ n: string }>(
    "SELECT count(*) AS n FROM chunks WHERE tenant = $1",
    [tenant],
  );
  const total = Number(totalRes.rows[0]?.n ?? 0);
  if (total + chunks.length > CONFIG.maxChunksTenant) {
    throw erro413(
      `limite de ${CONFIG.maxChunksTenant} chunks por usuario atingido ` +
        `(voce tem ${total}; este arquivo precisaria de ${chunks.length})`,
    );
  }
  const ins = await q<{ id: string }>(
    `INSERT INTO ingest_jobs (tenant, memoria, doc_id, title, content, chunks_total)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tenant, memoria, body.doc_id, body.title ?? null, body.content, chunks.length],
  );
  const jobId = Number(ins.rows[0].id);
  return {
    job_id: jobId,
    status: "na_fila",
    chunks_total: chunks.length,
    mensagem: `na fila; acompanhe em GET /ingest/${jobId}`,
  };
}

export async function jobStatus(jobId: number, tenant: string | null) {
  const filtro = tenant !== null ? " AND tenant = $2" : "";
  const params: unknown[] = [jobId];
  if (tenant !== null) params.push(tenant);
  const r = await q(
    `SELECT id, doc_id, coalesce(title,'') AS title, memoria, status, chunks_total,
            chunks_feitos, erro, criado_em, finalizado_em
     FROM ingest_jobs WHERE id = $1${filtro}`,
    params,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    job_id: Number(row.id),
    doc_id: row.doc_id,
    title: row.title,
    memoria: row.memoria,
    status: row.status,
    chunks_total: Number(row.chunks_total),
    chunks_feitos: Number(row.chunks_feitos),
    erro: row.erro,
    criado_em: iso(row.criado_em),
    finalizado_em: iso(row.finalizado_em),
  };
}

/** Pega o próximo job (1 claim atômico). */
async function claimNextJob(): Promise<JobRow | null> {
  const r = await q<JobRow>(
    `UPDATE ingest_jobs SET status='processando'
     WHERE id = (SELECT id FROM ingest_jobs WHERE status='na_fila' ORDER BY id LIMIT 1)
     RETURNING id, tenant, memoria, doc_id, title, content, chunks_total`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return { ...row, id: Number(row.id), chunks_total: Number(row.chunks_total) };
}

/** Processa um job: insere chunks, troca o índice antigo só no fim. */
export async function processJob(job: JobRow): Promise<string> {
  let primeiroNovoId: number | null = null;
  try {
    const chunks = chunkText(job.content, CONFIG.maxChunkWords, CONFIG.chunkOverlap);
    /* v3.54: reindexar NÃO pode desarquivar. O chunk novo nascia com
       archived_at NULL e o documento arquivado voltava à busca comum. */
    const arqAtual = await q<{ arquivado: boolean }>(
      `SELECT (max(archived_at) IS NOT NULL) AS arquivado
         FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3`,
      [job.tenant, job.memoria, job.doc_id],
    );
    const nasceArquivado = arqAtual.rows[0]?.arquivado === true;
    for (let i = 0; i < chunks.length; i++) {
      const vetor = await embedUm(chunks[i]);
      const ins = await q<{ id: string }>(
        `INSERT INTO chunks (tenant, memoria, doc_id, title, body, embedding, archived_at)
         VALUES ($1,$2,$3,$4,$5,$6::vector, CASE WHEN $7::boolean THEN now() ELSE NULL END) RETURNING id`,
        [job.tenant, job.memoria, job.doc_id, job.title, chunks[i], vetor, nasceArquivado],
      );
      const rid = Number(ins.rows[0].id);
      if (primeiroNovoId === null) primeiroNovoId = rid;
      await q("UPDATE ingest_jobs SET chunks_feitos = $1 WHERE id = $2", [i + 1, job.id]);
    }
    // só agora o doc antigo sai
    if (primeiroNovoId !== null) {
      await q(
        `DELETE FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3 AND id < $4`,
        [job.tenant, job.memoria, job.doc_id, primeiroNovoId],
      );
    }
    /* a gaveta passa a existir oficialmente no primeiro documento */
    await q(
      `INSERT INTO gavetas (tenant, memoria) VALUES ($1, $2)
       ON CONFLICT (tenant, memoria) DO NOTHING`,
      [job.tenant, job.memoria],
    );
    await q(
      `INSERT INTO documents (tenant, memoria, doc_id, title, content, size_bytes, origem)
       VALUES ($1,$2,$3,$4,$5,$6,'direto')
       ON CONFLICT (tenant, memoria, doc_id) DO UPDATE SET
         title = EXCLUDED.title, content = EXCLUDED.content,
         size_bytes = EXCLUDED.size_bytes, origem = 'direto', atualizado_em = now()`,
      [job.tenant, job.memoria, job.doc_id, job.title, job.content,
        Buffer.byteLength(job.content, "utf8")],
    );
    await q(
      `UPDATE ingest_jobs SET status='concluido', finalizado_em=now() WHERE id = $1`,
      [job.id],
    );
    return `${chunks.length} chunks`;
  } catch (e) {
    if (primeiroNovoId !== null) {
      try {
        await q(
          `DELETE FROM chunks WHERE tenant=$1 AND memoria=$2 AND doc_id=$3 AND id >= $4`,
          [job.tenant, job.memoria, job.doc_id, primeiroNovoId],
        );
      } catch (e2) {
        log(`limpeza parcial falhou (job ${job.id}): ${(e2 as Error).message}`);
      }
    }
    await q(
      `UPDATE ingest_jobs SET status='erro', erro=$1, finalizado_em=now() WHERE id = $2`,
      [String((e as Error).message).slice(0, 500), job.id],
    );
    throw e;
  }
}

let rodando = true;

export function pararWorker(): void {
  rodando = false;
}

/** Consome a fila 1 por 1. Se o embedder estiver fora, espera. */
export async function workerLoop(): Promise<void> {
  while (rodando) {
    try {
      const job = await claimNextJob();
      if (!job) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const resumo = await processJob(job);
      log(`job ${job.id} concluido: ${resumo}`);
    } catch (e) {
      log(`worker erro: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}