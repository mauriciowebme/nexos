/** Boot: sobe o embedder (filho), prepara o banco, liga worker/decay e serve. */
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { CONFIG, log } from "./config";
import { initDb, limparTarefas, pool, waitDb } from "./db";
import { embedderDim, esperarEmbedder, marcarEmbedder } from "./embed";
import { detectarOcr } from "./ocr";
import { pararWorker, workerLoop } from "./ingest";
import { iniciarDecayLoop, pararDecayLoop } from "./decay";
import { iniciarAnexos } from "./anexos";
import { iniciarArquivos } from "./arquivos"; // v3.85: pastas + lixeira da tela Arquivos
import { criarApp } from "./app";
import { initUsuarios } from "./usuarios";
import { criarTabelaEsquecimento, lerEsquecimento } from "./esquecimento";
import { iniciarFaxinaLoop, pararFaxinaLoop } from "./faxina";
import { initProvider } from "./provider";
import { initProvedores } from "./provedores";
import { initFerramentas } from "./ferramentas";
import { initMetricas } from "./dashboard";
import { anexarHubMaquinas, initMaquinas } from "./maquinas";
import { initMcpAcesso } from "./mcp_acesso";

let filho: ChildProcess | null = null;
let encerrando = false;

function subirEmbedder(): void {
  if (CONFIG.embedderModo === "externo") return;
  const cwd = process.env.NEXOS_APP_DIR ?? path.resolve(__dirname, "..");
  const args = [
    "-m", "uvicorn", "embedder.embed_server:app",
    "--host", "127.0.0.1",
    "--port", String(CONFIG.embedderPort),
    "--log-level", "warning",
  ];
  log(`subindo embedder: ${CONFIG.pythonBin} ${args.join(" ")}`);
  filho = spawn(CONFIG.pythonBin, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  filho.on("exit", (code, sinal) => {
    log(`embedder saiu (code=${code} sinal=${sinal})`);
    if (encerrando) return;
    setTimeout(() => {
      if (!encerrando) subirEmbedder();
    }, 2000);
  });
  filho.on("error", (e) => log(`embedder erro: ${e.message}`));
}

function encerrarFilho(): void {
  if (!filho || filho.killed) return;
  try {
    filho.kill("SIGTERM");
  } catch {
    /* já morto */
  }
  setTimeout(() => {
    if (filho && !filho.killed) {
      try {
        filho.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, 5000).unref?.();
}

async function main(): Promise<void> {
  subirEmbedder();
  const ok = await esperarEmbedder();
  if (!ok) log("AVISO: embedder nao respondeu no boot; fila pausada ate ele subir");
  await detectarOcr();

  await waitDb();
  if (!embedderDim()) {
    throw new Error("dimensao do embedding desconhecida (embedder fora) — abortando boot");
  }
  await initDb(embedderDim());
  await limparTarefas(); // v3.3: rodando órfã vira falhou; terminadas antigas saem
  await initUsuarios(); // v2.7: env semeia, banco manda
  await criarTabelaEsquecimento(); // v3.5: números do esquecimento graváveis na tela
  await initProvider();
  await initProvedores(); // v3.19: provedores nomeados + colunas de escolha na tarefa
  await initFerramentas(); // v2.8: servidores MCP que dão ferramentas ao chat
  await initMetricas();
  await initMaquinas(); // v3.6: máquinas por usuário (túnel absorvido)
  await iniciarAnexos(); // v3.44: arquivos que a máquina manda para o chat
  await iniciarArquivos(); // v3.85: pastas_arquivos + colunas de lixeira no anexo
  await initMcpAcesso(); // v3.36: quem usa o nexos como servidor MCP e o que cada conta liberou
  const esq = await lerEsquecimento();
  log(
    `limites: content<=${CONFIG.maxContentChars} chars, query<=${CONFIG.maxQueryChars} chars, ` +
      `${CONFIG.maxChunksTenant} chunks/usuario; decay=${CONFIG.decayAtivo ? "ON" : "OFF"} ` +
      `(arquiva em ${esq.efetivos.dias_arquivar}d, mata arquivado em ${esq.efetivos.dias_excluir_arquivado}d, ` +
      `carência ${esq.efetivos.dias_carencia}d, a cada ${CONFIG.decayIntervaloMinutos} min)`,
  );

  if (CONFIG.workerAtivo) {
    void workerLoop();
    log("worker de ingestao ativo");
  }
  iniciarDecayLoop((n) => log(`decay arquivou ${n} chunk(s)`));
  iniciarFaxinaLoop((nomes) => log(`faxina apagou conta(s): ${nomes.join(", ")}`)); // v3.5

  // vigia do embedder: se ele cair depois do boot, a fila pausa e volta sozinha
  setInterval(async () => {
    try {
      const r = await fetch(`${CONFIG.embedderUrl}/health`, { signal: AbortSignal.timeout(3000) });
      await marcarEmbedder(r.ok);
    } catch {
      await marcarEmbedder(false);
    }
  }, 30_000).unref?.();

  const app = criarApp();
  anexarHubMaquinas(app.server as unknown as import("node:http").Server); // v3.6: /maquina/ws no MESMO servidor/porta
  await app.listen({ port: CONFIG.port, host: CONFIG.host });
  log(`servindo em http://${CONFIG.host}:${CONFIG.port} (v${CONFIG.versao})`);

  const desligar = async (sinal: string) => {
    if (encerrando) return;
    encerrando = true;
    log(`recebido ${sinal}; encerrando`);
    pararWorker();
    pararDecayLoop();
    pararFaxinaLoop();
    encerrarFilho();
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void desligar("SIGTERM"));
  process.on("SIGINT", () => void desligar("SIGINT"));
}

main().catch((e) => {
  process.stderr.write(`[nexos] boot falhou: ${(e as Error).stack ?? e}\n`);
  encerrarFilho();
  process.exit(1);
});