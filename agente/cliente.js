#!/usr/bin/env node
/*
 * Cliente de máquina — nexos v3.6 (túnel absorvido)
 *
 * Um arquivo, sem instalação: conecta no hub do nexos, recebe comandos e
 * executa NA MÁQUINA onde roda. Wire herdado do agent-tunel, tags intactas:
 *   cliente → servidor: {"token","host","os","user"}  (oi)
 *   servidor → cliente: {"cmd","rotulo","espera","bg"?}   (bg ausente = comportamento antigo)
 *   cliente → servidor: {"exit","stdout","stderr"}
 *   servidor → cliente: {"ack":"ok","token":<maquina>} | {"ack":"negado","motivo":...}
 *
 * Cores do longo prazo (decisão do dono 22/10):
 *  - o token de pareamento é de uso único: ao receber o token de máquina no
 *    ack, o cliente ADOTA, persiste (~/.nexos-maquina.json) e reconecta com
 *    ele — a suíte pegou exatamente esse defeito no cliente falso da primeira vez;
 *  - reconexão com backoff (400ms → 30s), heartbeat por ping do protocolo
 *    (o WebSocket nativo do Node responde pong sozinho), kill de ÁRVORE em timeout;
 *  - auto-update: compara a versão embutida com o /maquina/atualizacao e reconsulta
 *    em TODA conexão; se o servidor fala versão maior, mostra o progresso na TELA,
 *    baixa, troca e reabre em janela própria minimizada (no Windows o exe velho vira
 *    .old porque não se apaga arquivo em execução);
 *  - UM log só (nexos-cliente.log), memória de 30 dias: faxina no boot apaga linhas
 *    mais velhas e corta o topo se estourar 2 MB — sem arquivo .old de log.
 *
 * Uso:
 *   nexos-cliente-win.exe --token <token-da-tela>
 *   nexos-cliente-linux   --token ... [--host nome] [--url nexos.techupsistemas.com]
 *   MINIRAG_MAQUINA_URL / MINIRAG_MAQUINA_CONF sobrepõem os padrões.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const { spawn, spawnSync } = require("node:child_process");

const EH_WIN = process.platform === "win32";
const VERSAO_CLIENTE = process.env.NEXOS_CLIENTE_VERSAO || process.env.MINIRAG_CLIENTE_VERSAO || "dev";

const argv = process.argv.slice(2);
function flag(nome, padrao) {
  const i = argv.indexOf("--" + nome);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : padrao;
}

/* ---------------- alvo ---------------- */
/* v3.47.2: a config oficial agora é .nexos-maquina.json. Quem já roda em campo tem
   .minirag-maquina.json com host/token — renomear sem migrar faria o cliente pedir
   pareamento de novo. Migra uma vez, no boot, antes de qualquer leitura. */
const CONF_NOVO = path.join(os.homedir(), ".nexos-maquina.json");
const CONF_ANTIGO = path.join(os.homedir(), ".minirag-maquina.json");
let confPath = flag("conf", process.env.NEXOS_MAQUINA_CONF || process.env.MINIRAG_MAQUINA_CONF || "");
if (!confPath) {
  if (!fs.existsSync(CONF_NOVO) && fs.existsSync(CONF_ANTIGO)) {
    try { fs.renameSync(CONF_ANTIGO, CONF_NOVO); } catch { try { fs.copyFileSync(CONF_ANTIGO, CONF_NOVO); } catch { /* segue com o antigo */ } }
  }
  confPath = CONF_NOVO;
}

/* v3.47.1: produção mora em nexos.techupsistemas.com. Quem já tem conf salva com o
   endereço antigo é migrado no boot — sem isso a máquina reconecta num host que não
   existe mais e fica offline sem dizer por quê. */
const URL_PADRAO = "https://nexos.techupsistemas.com";
const URL_ANTIGA = "minirag.techupsistemas.com";
const migrarUrl = (u) =>
  typeof u === "string" && u.includes(URL_ANTIGA) ? u.replace(URL_ANTIGA, "nexos.techupsistemas.com") : u;
const confSalva = lerConf();
let base = flag("url", process.env.NEXOS_MAQUINA_URL || process.env.MINIRAG_MAQUINA_URL || migrarUrl(confSalva.url) || URL_PADRAO);
if (!/^https?:/i.test(base)) base = "https://" + base;
if (confSalva.url && migrarUrl(confSalva.url) !== confSalva.url) {
  gravarConf({ ...confSalva, url: migrarUrl(confSalva.url) });
  log("conf: endereço antigo migrado para " + migrarUrl(confSalva.url));
}

const URL_WS = (() => {
  const u = new URL(base);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/maquina/ws";
  return u.toString();
})();
const host = flag("host", process.env.NEXOS_MAQUINA_HOST || process.env.MINIRAG_MAQUINA_HOST || os.hostname());

function lerConf() {
  try {
    return JSON.parse(fs.readFileSync(confPath, "utf8"));
  } catch {
    return {};
  }
}
function gravarConf(o) {
  try {
    fs.writeFileSync(confPath, JSON.stringify(o, null, 2));
  } catch (e) {
    log("aviso: não consegui guardar o token em " + confPath + " (" + e.message + ")");
  }
}

/* chave assada no proprio arquivo (v3.7): o painel cola {v:1,k:...}+len+MRQK no fim do exe */
function lerChaveEmbutida() {
  try {
    const fd = fs.openSync(process.execPath, "r");
    const st = fs.fstatSync(fd);
    const corte = Math.min(8192, st.size);
    const b = Buffer.alloc(corte);
    fs.readSync(fd, b, 0, corte, st.size - corte);
    fs.closeSync(fd);
    if (b.slice(-4).toString("ascii") !== "MRQK") return "";
    const len = b.readUInt32BE(b.length - 8);
    if (len <= 0 || len > corte - 8) return "";
    const o = JSON.parse(b.slice(b.length - 8 - len, b.length - 8).toString("utf8"));
    return o && o.v === 1 && typeof o.k === "string" ? o.k : "";
  } catch {
    return "";
  }
}

let chaveEmbutida = "";
let tokenDoConf = false;
let token = flag("token", "");
if (!token) {
  const doConf = lerConf().token || "";
  if (doConf) { token = doConf; tokenDoConf = true; } // token adotado numa conexão anterior
}
if (!token) { chaveEmbutida = lerChaveEmbutida(); token = chaveEmbutida; }
let tentouChaveDepoisDoErro = false;
let negadoPermanente = false;

/* ---------------- console + arquivo de log (ao lado do exe, como o túnel) ---- */
let LOG_DIR = path.dirname(process.execPath); // SEA: o log nasce do lado do .exe
try {
  const sea = require("node:sea");
  if (!sea.isSea()) LOG_DIR = __dirname;     // desenvolvimento (node cliente.js): no repo
} catch {
  LOG_DIR = __dirname;
}
const LOG_PATH = path.join(LOG_DIR, "nexos-cliente.log");
/* v3.47.2: herda o log antigo na primeira subida — o histórico de reconexão do dono
   não pode sumir só porque o arquivo trocou de nome. */
try {
  const LOG_ANTIGO = path.join(LOG_DIR, "minirag-cliente.log");
  if (!fs.existsSync(LOG_PATH) && fs.existsSync(LOG_ANTIGO)) fs.renameSync(LOG_ANTIGO, LOG_PATH);
} catch { /* log é acessório: nunca derruba o boot */ }
let nivelBackoff = 0;
let escritasLog = 0;
/* v3.12: o log gira por TAMANHO também. Um laço de recusa do servidor enchia o
 * arquivo em minutos ("log gigante"), e o dono acabou apagando para trabalhar. */
function girarLogSeGrande() {
  if (++escritasLog % 200 !== 0) return;
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < 2 * 1024 * 1024) return;
    try { fs.unlinkSync(LOG_PATH + ".1"); } catch { /* não existe */ }
    fs.renameSync(LOG_PATH, LOG_PATH + ".1");
  } catch { /* sem arquivo ainda */ }
}

function log(msg) {
  const linha = new Date().toISOString().slice(0, 19).replace("T", " ") + "  " + msg;
  console.log(linha);
  try {
    fs.appendFileSync(LOG_PATH, linha + "\n");
    girarLogSeGrande();
  } catch { /* sem disco de escrita? o console ainda salva a sessão */ }
  try { if (typeof ouvintes !== "undefined" && ouvintes.size) evocar({ tipo: "log", linha }); } catch { /* painel ainda nascendo */ }
}
function logTela(msg) {
  // só a tela: o log do arquivo é para o essencial (um arquivo só, cobrado 23/10)
  console.log(new Date().toISOString().slice(0, 19).replace("T", " ") + "  " + msg);
}
function faxinaLog() {
  // UM log apenas, 30 dias de memória: linhas mais velhas morrem no boot e, se o
  // arquivo estourar 2 MB, corta-se pelo começo (nunca renomeia para .old — o dono
  // vetou o segundo arquivo: "um log só para tomar conta de tudo"). Sem atalho por
  // tamanho: arquivo pequeno ainda pode guardar linha de 45 dias (pego pela sonda).
  try {
    try { fs.unlinkSync(LOG_PATH + ".old"); } catch { /* fósforo antigo sumiu do mapa */ }
    const corte = Date.now() - 30 * 864e5;
    const vivas = fs.readFileSync(LOG_PATH, "utf8").split("\n").filter((l) => {
      if (!l.trim()) return false;
      const t = Date.parse(l.slice(0, 19).replace(" ", "T") + "Z");
      return Number.isNaN(t) ? true : t >= corte; // linha sem data legível: fica
    });
    let texto = vivas.join("\n") + (vivas.length ? "\n" : "");
    if (Buffer.byteLength(texto) > 2_000_000) {
      const buf = Buffer.from(texto);
      let inicio = buf.length - 1_900_000;
      const nl = buf.indexOf(0x0a, inicio);
      if (nl > 0) inicio = nl + 1;
      texto = buf.subarray(inicio).toString("utf8");
    }
    fs.writeFileSync(LOG_PATH, texto);
  } catch { /* sem permissão: o log segue gravando sem faxina */ }
}
function esperarEnter() {
  // duplo clique no Windows: sem isto a janela fecha antes de a pessoa ler
  const rl = require("node:readline").createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question("\n[ENTER para fechar esta janela]\n", () => { rl.close(); res(); });
    rl.on("close", res); // stdin fechado (serviço/pipe): não pendura
  });
}

/* v3.54: saida de comando no Windows chega em cp850 (cmd.exe), nao UTF-8 — sem
   converter, "nao" vira "n\uFFFDo" e o texto mente. Tenta UTF-8 estrito primeiro
   (PowerShell moderno emite UTF-8) e so cai para cp850 quando os bytes nao formam
   UTF-8 valido. A tabela cobre 0x80..0xFF; 0x00..0x7F e ASCII. */
const TABELA_CP850 = [
  '\u00c7', '\u00fc', '\u00e9', '\u00e2', '\u00e4', '\u00e0', '\u00e5', '\u00e7', '\u00ea', '\u00eb', '\u00e8', '\u00ef', '\u00ee', '\u00ec', '\u00c4', '\u00c5',
  '\u00c9', '\u00e6', '\u00c6', '\u00f4', '\u00f6', '\u00f2', '\u00fb', '\u00f9', '\u00ff', '\u00d6', '\u00dc', '\u00f8', '\u00a3', '\u00d8', '\u00d7', '\u0192',
  '\u00e1', '\u00ed', '\u00f3', '\u00fa', '\u00f1', '\u00d1', '\u00aa', '\u00ba', '\u00bf', '\u00ae', '\u00ac', '\u00bd', '\u00bc', '\u00a1', '\u00ab', '\u00bb',
  '\u2591', '\u2592', '\u2593', '\u2502', '\u2524', '\u00c1', '\u00c2', '\u00c0', '\u00a9', '\u2563', '\u2551', '\u2557', '\u255d', '\u00a2', '\u00a5', '\u2510',
  '\u2514', '\u2534', '\u252c', '\u251c', '\u2500', '\u253c', '\u00e3', '\u00c3', '\u255a', '\u2554', '\u2569', '\u2566', '\u2560', '\u2550', '\u256c', '\u00a4',
  '\u00f0', '\u00d0', '\u00ca', '\u00cb', '\u00c8', '\u0131', '\u00cd', '\u00ce', '\u00cf', '\u2518', '\u250c', '\u2588', '\u2584', '\u00a6', '\u00cc', '\u2580',
  '\u00d3', '\u00df', '\u00d4', '\u00d2', '\u00f5', '\u00d5', '\u00b5', '\u00fe', '\u00de', '\u00da', '\u00db', '\u00d9', '\u00fd', '\u00dd', '\u00af', '\u00b4',
  '\u00ad', '\u00b1', '\u2017', '\u00be', '\u00b6', '\u00a7', '\u00f7', '\u00b8', '\u00b0', '\u00a8', '\u00b7', '\u00b9', '\u00b3', '\u00b2', '\u25a0', '\u00a0',
];
function textoWindows(buf) {
  if (!EH_WIN) return buf.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    let s = "";
    for (const byte of buf) s += byte < 0x80 ? String.fromCharCode(byte) : TABELA_CP850[byte - 0x80];
    return s;
  }
}

/* ---------------- execução de comando com kill de árvore ---------------- */
/* v3.39: `bg` — o processo nasce em grupo próprio com stdio ignorado e o cliente
   responde na hora com o PID. É o que permite subir servidor/modelo e o comando
   do servidor terminar sem matar o que estava rodando. */
function rodar(cmd, esperaSeg, bg) {
  if (bg) {
    return new Promise((resolve) => {
      try {
        const b = EH_WIN
          ? spawn("cmd.exe", ["/d", "/c", cmd], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
              windowsVerbatimArguments: true,
            })
          : spawn("/bin/sh", ["-c", cmd], { detached: true, stdio: "ignore" });
        b.unref();
        resolve({
          exit: 0,
          stdout: "INICIADO_PID=" + b.pid + "\n[background: solto do servidor, sem teto de tempo; a saida nao volta por aqui]",
          stderr: "",
        });
      } catch (e) {
        resolve({ exit: -1, stdout: "", stderr: "background: " + String((e && e.message) || e) });
      }
    });
  }
  return new Promise((resolve) => {
    /* Windows: `windowsVerbatimArguments` impede o Node de reescrever a linha.
       Sem ele o argumento com espaço era embrulhado em aspas e as aspas internas
       viravam \" — o cmd tratava `"echo oi"` como nome de programa (v3.39.1). */
    const filho = EH_WIN
      ? spawn("cmd.exe", ["/d", "/c", cmd], { windowsHide: true, windowsVerbatimArguments: true })
      : spawn("/bin/sh", ["-c", cmd], { detached: true }); // detached = grupo próprio; matamos o grupo
    /* v3.54: guarda BYTES e decodifica no fim (cp850 no Windows) — concatenar
       direto em string fazia o Buffer virar UTF-8 e "não" sair como "n\uFFFDo". */
    const partesOut = [];
    const partesErr = [];
    let bytesOut = 0;
    let bytesErr = 0;
    let stderr = "";
    let morto = false;
    let truncado = false;
    /* v3.43: teto de COLETA do cliente. Antes era 40.000 e matava a árvore sem
       resolver a Promise — o servidor via silêncio e culpava o timeout (leitura
       binária do print do dono morria em 53 s). Base64 de 6 MB cabe aqui. */
    const TETO_STDOUT = 8 * 1024 * 1024;
    const TETO_STDERR = 64 * 1024;
    const matarArvore = () => {
      morto = true;
      try {
        if (EH_WIN) spawn("taskkill", ["/T", "/F", "/PID", String(filho.pid)], { windowsHide: true });
        else process.kill(-filho.pid, "SIGKILL");
      } catch {
        try { filho.kill("SIGKILL"); } catch { /* já morreu */ }
      }
    };
    const teto = Math.max(1, Math.min(3600, Number(esperaSeg) || 30)) + 2; // servidor dá -124 em espera+8; aqui é a última barreira
    const rel = setTimeout(() => {
      matarArvore();
      stderr += "\n[cliente: mata-árvore após " + teto + "s]";
      resolve({
        exit: -124,
        stdout: textoWindows(Buffer.concat(partesOut)).slice(0, TETO_STDOUT),
        stderr: (textoWindows(Buffer.concat(partesErr)) + stderr).slice(0, TETO_STDERR),
        truncado,
      });
    }, teto * 1000);
    /* v3.43: o teto de coleta TRUNCA, não mata. Até a 3.42.1 passar de 40.000 chars
       chamava matarArvore(), que marcava morto=true e fazia o `close` retornar SEM
       resolver a Promise: o servidor esperava até estourar (-124) e lia como máquina
       muda. Era esse o "teto de ~39 KB do túnel" — nada a ver com o WebSocket.
       Agora coleta até 8 MB (base64 de ~6 MB), marca truncado=true e responde. */
    filho.stdout && filho.stdout.on("data", (b) => {
      if (bytesOut >= TETO_STDOUT) { truncado = true; return; }
      partesOut.push(b);
      bytesOut += b.length;
    });
    filho.stderr && filho.stderr.on("data", (b) => {
      if (bytesErr >= TETO_STDERR) return;
      partesErr.push(b);
      bytesErr += b.length;
    });
    filho.on("error", (e) => {
      clearTimeout(rel);
      resolve({ exit: -1, stdout: "", stderr: String(e.message || e) });
    });
    filho.on("close", (code) => {
      clearTimeout(rel);
      if (morto) return; // o timeout já resolveu com -124
      resolve({
        exit: code == null ? -9 : code,
        stdout: textoWindows(Buffer.concat(partesOut)).slice(0, TETO_STDOUT),
        stderr: (textoWindows(Buffer.concat(partesErr)) + stderr).slice(0, TETO_STDERR),
        truncado,
      });
    });
  });
}

/* ---------------- painel local do dono (só 127.0.0.1) ----------------
 * Interface amigável no navegador do próprio computador (pedido 23/10: "parece um
 * terminal; queria ver status e logs"). Nada de segredo na tela: o token nunca aparece. */
const PAINEL_PORTA = 48123;
let painelPorta = 0;
const estado = {
  host,
  usuario: (() => { try { return os.userInfo().username; } catch { return "?"; } })(),
  so: process.platform + " " + os.release(),
  servidor: base,
  versao: VERSAO_CLIENTE,
  online: false,
  conectou_em: null,
  ultima_tentativa: null, // v3.13.1: quando o laço tentou por último (a tela mostra)
  negado: null,
  atualizacao: null,
  comandos: [],
};
const ouvintes = new Set();
function evocar(ev) {
  const t = "data: " + JSON.stringify(ev) + "\n\n";
  for (const r of ouvintes) { try { r.write(t); } catch { ouvintes.delete(r); } }
}
function setOnline(v) {
  estado.online = v;
  estado.conectou_em = v ? new Date().toISOString() : null;
  if (!v) estado.negado = null;
  evocar({ tipo: "status", online: v, conectou_em: estado.conectou_em, negado: estado.negado });
}
function setAtualizacao(patch) {
  estado.atualizacao = { de: VERSAO_CLIENTE, ...(estado.atualizacao || {}), ...patch };
  evocar({ tipo: "atualizacao", atualizacao: estado.atualizacao });
}
function registrarComando(rotulo, exit, bytes) {
  estado.comandos.unshift({ ts: new Date().toISOString(), rotulo, exit, bytes });
  if (estado.comandos.length > 50) estado.comandos.length = 50;
  evocar({ tipo: "comando", comando: estado.comandos[0] });
}
function tailLog(n) {
  try {
    return fs.readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean).slice(-n).join("\n");
  } catch { return ""; }
}
function iniciarPainel() {
  const semJanela = argv.includes("--sem-janela");
  const servidor = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/api/estado") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ...estado, porta: painelPorta, conf: confPath, log: tailLog(80) }));
      return;
    }
    if (u.pathname === "/api/sair" && req.method === "POST") {
      // v3.13.1: porta de assunto. Só a própria máquina reacha isto (o painel escuta
      // em 127.0.0.1); é o cliente novo pedindo ao velho travado que desocupe a porta.
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ saindo: true }));
      log("outro cliente desta máquina pediu para eu sair — ele vai assumir; adeus");
      morrendo = true;
      fecharJanelasNexos();
      try { if (ws) ws.close(); } catch { /* ignore */ }
      setTimeout(() => process.exit(0), 300);
      return;
    }
    if (u.pathname === "/evento") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("data: " + JSON.stringify({ tipo: "oi", estado: { ...estado, log: undefined } }) + "\n\n");
      ouvintes.add(res);
      const ka = setInterval(() => { try { res.write(":ka\n\n"); } catch { /* fecha junto */ } }, 25000);
      res.on("close", () => { clearInterval(ka); ouvintes.delete(res); });
      return;
    }
    if (u.pathname === "/") {
      // v3.12.1: sem cache — o navegador abriu a página ANTIGA e ela ficava em "carregando…"
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        pragma: "no-cache",
        expires: "0",
      });
      res.end(PAINEL_HTML);
      return;
    }
    res.writeHead(404); res.end("nao tem isso aqui");
  });
  const estadoNaPorta = (porta) => new Promise((ok) => {
    // v3.12: se já existe um cliente nesta porta, abrir OUTRA instância só confunde.
    // v3.13.1: mas "existe" ≠ "está vivo" — o zumbi do bug segurava a porta e fazia
    // o cliente novo se matar. Aqui eu PERGUNTO se aquele aí está conectado.
    const t = http.get({ host: "127.0.0.1", port: porta, path: "/api/estado", timeout: 1500 }, (r) => {
      let d = "";
      r.on("data", (c) => { d += c; });
      r.on("end", () => {
        /* só é "a mesma instalação" se o painel de lá usa o MESMO arquivo de config —
         * dois clientes apontando para configs diferentes são instâncias legítimas */
        try {
          const j = JSON.parse(d);
          ok(Boolean(j && j.versao && "online" in j && j.conf === confPath) ? j : null);
        } catch { ok(null); }
      });
    });
    t.on("timeout", () => { t.destroy(); ok(null); });
    t.on("error", () => ok(null));
  });
  // pede educadamente ao outro cliente (vivo, mas sem conexão) para ele sair e
  // liberar a porta. Nada de taskkill: é o próprio programa se desligando.
  const pedirParaSair = (porta) => new Promise((ok) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: "/api/sair", method: "POST", timeout: 1500 }, (r) => {
      r.resume(); r.on("end", () => ok(true));
    });
    req.on("timeout", () => { req.destroy(); ok(false); });
    req.on("error", () => ok(false));
    req.end();
  });
  const tenta = (porta, podeAssumir) => {
    servidor.once("error", async (e) => {
      if (e.code !== "EADDRINUSE") { log("painel local: " + e.code); return; }
      const vizinho = await estadoNaPorta(porta);
      if (vizinho && vizinho.online) {
        const url = "http://127.0.0.1:" + porta + "/?v=" + Date.now();
        log("já existe um cliente CONECTADO nesta máquina — abro a janela dele (http://127.0.0.1:" + porta + "/) e saio");
        if (!semJanela) { abrirJanela(url); setTimeout(() => process.exit(0), 1500); } else { setTimeout(() => process.exit(0), 200); }
        return;
      }
      if (vizinho && podeAssumir) {
        log("o cliente desta porta está VIVO, mas sem conexão (v" + vizinho.versao + ") — peço que ele saia e eu assumo");
        await pedirParaSair(porta);
        await new Promise((r) => setTimeout(r, 1200));
        servidor.removeAllListeners("error");
        tenta(porta, false); // uma vez só: se não liberar, sigo na próxima porta
        return;
      }
      if (porta < PAINEL_PORTA + 6) { log("painel: porta " + porta + " ocupada, tentando a próxima"); tenta(porta + 1, podeAssumir); }
      else log("painel: sem porta livre (até " + porta + ") — sigo só com a conexão, sem janela local");
    });
    servidor.listen(porta, "127.0.0.1", () => {
      painelPorta = porta;
      const url = "http://127.0.0.1:" + porta + "/?v=" + Date.now(); // endereço novo: o navegador não reaproveita a página velha
      log("painel local em http://127.0.0.1:" + porta + "/");
      if (!semJanela) abrirJanela(url);
    });
  };
  tenta(PAINEL_PORTA, true);
}
/* v3.11: UMA janela só. O programa deixou de ser "console + aba de navegador":
 * no Windows ele abre a página em MODO APLICATIVO (janela própria, sem abas, sem
 * barra de endereço) e o executável é compilado sem console. */
function acharNavegadorApp() {
  const pf = process.env.PROGRAMFILES || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const la = process.env.LOCALAPPDATA || "";
  return [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    la ? path.join(la, "Microsoft", "Edge", "Application", "msedge.exe") : "",
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean).find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || "";
}

function abrirJanela(url) {
  if (!EH_WIN) {
    try { spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref(); } catch { /* sem navegador */ }
    return;
  }
  const navegador = acharNavegadorApp();
  if (navegador) {
    try {
      const perfil = path.join(path.dirname(confPath), ".nexos-janela");
      if (EH_WIN) fecharJanelasNexosSync();
      // v3.16.5: --disable-gpu — seguro e de graça para esta tela de texto/botões.
      // v3.16.6: windowsHide FORA daqui — A/B medido 24/10 na Noot: janela nascida com
      // SW_HIDE (windowsHide) fica preta (compositor sem primeiro paint); o MESMO
      // browser, nascido visível, vive. O exe é GUI (subsistema 2), não há console a esconder.
      const f = spawn(navegador, ["--app=" + url, "--window-size=700,560", "--disable-gpu", "--user-data-dir=" + perfil], { detached: true, stdio: "ignore" });
      f.on("error", () => abrirNavegadorPadrao(url));
      if (f.unref) f.unref();
      return;
    } catch { /* cai no padrão */ }
  }
  abrirNavegadorPadrao(url);
}

function abrirNavegadorPadrao(url) {
  // última alternativa: navegador do sistema (a página é a mesma)
  try {
    const f = EH_WIN
      ? spawn("cmd.exe", ["/d", "/c", "start", "", url], { windowsHide: true })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    f.on("error", () => log("não consegui abrir a janela sozinho — abra " + url));
    if (!EH_WIN) f.unref();
  } catch { /* silencioso: o log já diz tudo */ }
}
/* v3.16.3: quando EU (cliente velho) saio — troca de update ou assumir de um novo —
 * fecho as janelas do painel que abre. A janela do Edge/Chrome --app é processo SEPARADO
 * de mim: se ficar viva, o dono vê DUAS telas depois da troca (a página congelada do
 * processo morto + a nova) — medido 24/10 na Noot. Mato só os processos com o MEU perfil
 * (.nexos-janela) na linha de comando; janelas normais do dono não são tocadas.
 * Fire-and-forget detached: o powershell termina o serviço mesmo depois do meu exit. */
function fecharJanelasNexosSync() {
  // v3.16.4: abrir janela SEMPRE em browser novo. Medido 24/10 na Noot: reabrir o exe
  // entrava no browser órfão do perfil (mesmo user-data-dir = um browser só) e herdava
  // o compositor quebrado dele — tela preta que reboot nenhum curava, porque a janela
  // nova nascia dentro do doente. Mato os browsers do MEU perfil e só então abro.
  // v3.16.9: guarda de idade — só mato processos com mais de 5 s de vida. O expurgo
  // atrasado do cliente VELHO (kill assíncrono na saída) alcançava o browser RECÉM-nascido
  // do cliente novo e matava só os render dele: quadro de janela vivo, corpo preto
  // (print np13 da Noot, 24/10). Browser recém-nascido é intocável; fantasma velho morre.
  try {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'nexos-janela' -and $_.CreationDate -lt (Get-Date).AddSeconds(-5) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 5000, stdio: "ignore" });
  } catch { /* mudo: abrir sem expurgo > nao abrir */ }
}
function fecharJanelasNexos() {
  if (!EH_WIN) return;
  // v3.16.9: era fire-and-forget — o powershell continuava vivo DEPOIS do meu exit e o
  // CIM lento mordia o browser novo do sucessor (tela preta intermitente na troca e no
  // dois-cliques). Agora é SYNC: ninguém sai daqui com matador solto na praça.
  try {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'nexos-janela' -and $_.CreationDate -lt (Get-Date).AddSeconds(-5) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 5000, stdio: "ignore" });
  } catch { /* mudo: melhor janela sobrando do que cliente travado */ }
}
/* A página é estática de propósito: os dados chegam por /api/estado e /evento.
 * Sem segredo algum na tela — o token nunca é exibido. */
const PAINEL_HTML = "<!doctype html><html lang=pt-br><head><meta charset=utf-8>" +
"<meta name=viewport content='width=device-width,initial-scale=1'>" +
"<title>nexos · cliente</title><style>" +
":root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif;background:radial-gradient(1200px 600px at 70% -10%,#123 0,#0b1020 55%,#090d18 100%);color:#dbe4f3;min-height:100vh}" +
"header{display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid #1c2740}" +
"header .logo{font-size:22px}h1{font-size:16px;margin:0;font-weight:600}header .dir{margin-left:auto;font-size:12px;color:#8fa1c0;text-align:right}" +
"main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;padding:18px 22px;max-width:1100px}" +
"section{background:#10182bcc;border:1px solid #1e2a47;border-radius:14px;padding:14px 16px}" +
"h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8fa1c0;margin:0 0 10px}" +
".dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:#666}" +
".dot.on{background:#3ddc84;box-shadow:0 0 10px #3ddc8480}.dot.off{background:#ff5d5d;box-shadow:0 0 10px #ff5d5d80}.dot.meio{background:#f0b429}" +
".linha{display:flex;align-items:center;gap:8px;font-size:15px}" +
".sub{color:#8fa1c0;font-size:12px;margin-top:6px}" +
".grade{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:13px}.k{color:#8fa1c0}.v{font-weight:600;word-break:break-all}" +
".bar{height:10px;background:#1c2740;border-radius:6px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;width:0%;background:linear-gradient(90deg,#4f8cff,#3ddc84);transition:width .3s}" +
"table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:4px 6px;text-align:left;border-bottom:1px solid #1c2740}th{color:#8fa1c0;font-weight:500;font-size:12px}" +
".ok{color:#3ddc84}.ruim{color:#ff5d5d}pre{margin:0;max-height:260px;overflow:auto;background:#0a0f1e;border-radius:8px;padding:10px;font-size:11.5px;color:#aebcd8;white-space:pre-wrap;word-break:break-word}" +
"footer{padding:10px 22px 18px;font-size:11px;color:#5f6f90}" +
"</style></head><body>" +
"<header><span class=logo>🛰️</span><h1>nexos — cliente da máquina</h1><div class=dir id=dir></div></header>" +
"<main>" +
"<section><h2>Conexão</h2><div class=linha><i class='dot off' id=dot></i><b id=ctxt>carregando…</b></div><div class=sub id=quando></div><div class=sub id=negado style='color:#ff8d8d'></div></section>" +
"<section><h2>Máquina</h2><div class=grade id=mach></div></section>" +
"<section><h2>Atualização</h2><div id=up>—</div><div class=bar id=wrapbar style=display:none><i id=fill></i></div></section>" +
"<section style=grid-column:1/-1><h2>Últimos comandos recebidos</h2><table><thead><tr><th>hora</th><th>rótulo</th><th>exit</th><th>bytes</th></tr></thead><tbody id=cms><tr><td colspan=4 style=color:#5f6f90>nada ainda</td></tr></tbody></table></section>" +
"<section style=grid-column:1/-1><h2>Log — um arquivo, últimos 30 dias</h2><pre id=lg></pre></section>" +
"</main><footer>Página local deste cliente (só este computador a enxerga). A janela de terminal continua funcionando por baixo.</footer>" +
"<script>" +
"function hora(s){return s? new Date(s).toLocaleTimeString('pt-BR'):''}" +
"function tempoDaUltima(e){if(!ultimo.host||!e.ultima_tentativa)return'';var s=Math.max(0,Math.round((Date.now()-new Date(e.ultima_tentativa))/1000));return 'última tentativa há '+s+'s — o programa continua tentando sozinho'}" +
"function apply(e){" +
"var d=document.getElementById('dot');d.className='dot '+(e.online?'on':'off');" +
"document.getElementById('ctxt').textContent=e.online?'ONLINE no nexos':'desconectado — reconecta sozinho';" +
"document.getElementById('quando').textContent=e.online?'conectado desde '+new Date(e.conectou_em).toLocaleString('pt-BR'):tempoDaUltima(e);" +
"document.getElementById('negado').textContent=e.negado?'servidor negou: '+e.negado:'';" +
"document.getElementById('dir').textContent='v'+e.versao+(e.porta?' · porta '+e.porta:'');" +
"var m='';m+='<span class=k>nome da máquina</span><span class=v>'+e.host+'</span>';" +
"m+='<span class=k>usuário</span><span class=v>'+e.usuario+'</span>';" +
"m+='<span class=k>sistema</span><span class=v>'+e.so+'</span>';" +
"m+='<span class=k>servidor</span><span class=v>'+e.servidor+'</span>';" +
"document.getElementById('mach').innerHTML=m;" +
"var a=e.atualizacao,u=document.getElementById('up'),w=document.getElementById('wrapbar'),f=document.getElementById('fill');" +
"if(a&&a.fase==='baixando'){u.textContent=a.de+' → '+a.para+' · '+a.mb+' MB de '+a.total_mb+' MB ('+a.pct+'%) · '+a.velocidade+' MB/s';w.style.display='block';f.style.width=a.pct+'%';}" +
"else if(a&&a.fase==='trocando'){u.textContent=a.de+' → '+a.para+' · download pronto, trocando o programa';w.style.display='block';f.style.width='100%';}" +
"else if(a&&a.fase==='reiniciando'){u.textContent='reabrindo na versão '+a.para;}" +
"else u.textContent='versão em uso: '+e.versao+' (o servidor manda novidade sozinha)';" +
"var t=document.getElementById('cms'),L=(e.comandos||[]).slice(0,15);" +
"if(L.length){t.innerHTML='';for(var i=0;i<L.length;i++){var c=L[i],tr=document.createElement('tr');" +
"tr.innerHTML='<td>'+hora(c.ts)+'</td><td>'+c.rotulo+'</td><td class=\"'+(c.exit===0?'ok':'ruim')+'\">'+c.exit+'</td><td>'+c.bytes+'</td>';t.appendChild(tr);}}}" +
"function logAppend(l){var lg=document.getElementById('lg');var e=lg.textContent?lg.textContent.split(String.fromCharCode(10)):[];e.push(l);if(e.length>200)e.splice(0,e.length-200);lg.textContent=e.join(String.fromCharCode(10));lg.scrollTop=lg.scrollHeight;}" +
"var es,ultimo={};" +
"setInterval(function(){if(!ultimo.host||ultimo.online)return;document.getElementById('quando').textContent=tempoDaUltima(ultimo);},1000);" +
"function liga(){es=new EventSource('/evento');es.onmessage=function(x){try{var o=JSON.parse(x.data);" +
"if(o.estado){ultimo=o.estado;apply(ultimo);}" +
"else if(o.tipo==='status'&&ultimo.host){ultimo.online=o.online;ultimo.conectou_em=o.conectou_em;ultimo.negado=o.negado;apply(ultimo);}" +
"else if(o.tipo==='tentativa'&&ultimo.host){ultimo.ultima_tentativa=o.ultima_tentativa;if(!ultimo.online)document.getElementById('quando').textContent=tempoDaUltima(ultimo);}" +
"else if(o.tipo==='atualizacao'&&ultimo.host){ultimo.atualizacao=o.atualizacao;apply(ultimo);}" +
"else if(o.tipo==='comando'&&o.comando&&ultimo.host){ultimo.comandos=[o.comando].concat(ultimo.comandos||[]).slice(0,15);apply(ultimo);}" +
"if(o.tipo==='log')logAppend(o.linha);}catch(e3){}};es.onerror=function(){try{es.close();}catch(e2){};setTimeout(liga,3000);};}liga();" +
"var lg0=document.getElementById('lg'),tent=0;" +
"function puxar(){fetch('/api/estado',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){tent=0;apply(j);lg0.textContent=j.log||'';}).catch(function(){tent++;if(tent>2)document.getElementById('ctxt').textContent='sem resposta do programa local — tentando de novo…';setTimeout(puxar,2000);});}puxar();" +
"</script></body></html>";
/* ---------------- websocket (nativo do Node — SEA sem dependência) ---------------- */
let ws = null;
let morrendo = false;
let atualizando = false;
let destinoVersao = null;
let tmpArq = null; // arquivo .novo da tentativa em curso (apagado se falhar)
let falhouPara = null; // versão cujo update já falhou neste processo (não rebaixa em loop)
let ultimaTentativa = 0; // epoch do último "conectando" (medida do vigia)
let proximaJanela = 0; // epoch em que o backoff marcou a próxima tentativa
let vigiaSoquete = () => null; // devolve o soquete ABERTO atual, ou null

/* v3.13.1 — O BURACO QUE PAROU A MÁQUINA DO DONO (23/10, medido no log dele).
 * O laço de reconexão estava pendurado SÓ no evento 'close'. No Node 22 (o node
 * assado dentro do .exe), fechar um soquete que ainda está em CONNECTING — o caso
 * do deploy, quando o servidor reinicia no meio do handshake — dispara 'error' e
 * NUNCA dispara 'close'. Prova medida aqui: node 22 fechando soquete em CONNECTING
 * dá "ERROR EVENT" e o readyState fica 2 (CLOSING) para sempre; no node 26 o close
 * chega, e por isso o ambiente de desenvolvimento nunca pegou o defeito.
 * Consequência: o programa ficava vivo, de janela aberta, SEM jamais tentar de novo,
 * e ainda segurava a porta do painel, bloqueando o cliente seguinte.
 * De hoje NENHUMA saída do laço depende de evento: quem decide reconectar é o
 * reagendar(), chamado por close, por error, pelo relogio dos 15 s e pelo vigia.
 * A trava jaReagendou garante um unico agendamento por soquete. */
function conectar() {
  if (morrendo) return;
  ultimaTentativa = Date.now();
  proximaJanela = 0; // até o soquete morrer de novo, não há janela marcada
  estado.ultima_tentativa = new Date(ultimaTentativa).toISOString();
  evocar({ tipo: "tentativa", ultima_tentativa: estado.ultima_tentativa });
  log("conectando em " + URL_WS + " como " + host + " (v" + VERSAO_CLIENTE + ")");
  ws = new WebSocket(URL_WS);
  const meuWs = ws;
  let jaReagendou = false;
  // programar: ÚNICA porta de saída do laço. A trava é por soquete, então close,
  // error, relógio e negado não podem gerar duas reconexões paralelas; e um soquete
  // que já foi substituído por outro (vigia forçou tentativa nova) não marca mais.
  const programar = (ms, deOnde) => {
    if (jaReagendou || morrendo || atualizando || meuWs !== ws) return;
    jaReagendou = true;
    setOnline(false);
    log("desconectado (" + deOnde + ") — reconecto em " + ms + "ms");
    proximaJanela = Date.now() + ms; // o vigia respeita esta hora: só acorda se ela falhar
    setTimeout(conectar, ms);
  };
  const reagendar = (deOnde) => {
    const atrasos = negadoPermanente ? [300000] : [400, 800, 1500, 3000, 8000, 15000, 30000];
    const ms = atrasos[Math.min(nivelBackoff++, atrasos.length - 1)];
    programar(ms, deOnde);
  };
  /* v3.12.2: no deploy o pedido de conexão pode ficar pendurado — antes o programa
   * esperava para sempre e a janela ficava "desconectado" até reiniciar à mão.
   * v3.13.1: o relógio não confia mais no close que ele mesmo provoca. */
  const relogioConexao = setTimeout(() => {
    if (meuWs.readyState === WebSocket.OPEN || jaReagendou || meuWs !== ws) return;
    log("conexão sem resposta em 15 s — largo este soquete e tento de novo");
    try { meuWs.close(); } catch { /* ignored */ }
    reagendar("relógio dos 15 s");
  }, 15000);
  meuWs.addEventListener("open", () => {
    clearTimeout(relogioConexao);
    if (meuWs !== ws) return; // outro soquete já assumiu esta conexão
    nivelBackoff = 0;
    meuWs.send(JSON.stringify({ token, host, os: process.platform + " " + os.release(), user: os.userInfo().username, v: VERSAO_CLIENTE }));
    // herança do Go v1.11: a novidade é reconsultada em TODA conexão (primeira e reconexões)
    verificarAtualizacao().catch(() => {});
  });
  meuWs.addEventListener("message", async (ev) => {
    let m;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.ack) {
      if (m.ack === "ok") {
        negadoPermanente = false;
        log("ONLINE no nexos");
        setOnline(true);
        if (m.token && m.token !== token) {
          token = m.token; // PAREAMENTO → token de máquina: adota e persiste (reconexão não pode usar o pareamento queimado)
          gravarConf({ ...lerConf(), token, host, url: base, desde: new Date().toISOString() });
          log("token de máquina adotado e guardado em " + confPath);
        }
      } else if (m.ack === "negado") {
        const motivo = m.motivo || "?";
        setOnline(false); estado.negado = motivo;
        evocar({ tipo: "status", online: false, conectou_em: null, negado: estado.negado });
        /* v3.12: o token guardado pode ter morrido (máquina apagada). Nesse caso o
         * cliente esquece o token e tenta a chave embutida UMA vez — antes ficava
         * repetindo "token desconhecido" a cada 15s para sempre. */
        if (/desconhec/i.test(motivo) && tokenDoConf && !tentouChaveDepoisDoErro) {
          tentouChaveDepoisDoErro = true;
          chaveEmbutida = chaveEmbutida || lerChaveEmbutida();
          if (chaveEmbutida) {
            gravarConf({ ...lerConf(), token: "", host, url: base });
            token = chaveEmbutida;
            tokenDoConf = false;
            nivelBackoff = 0;
            log("o token guardado não existe mais no servidor — tentando de novo com a chave do arquivo");
            programar(1500, "chave do arquivo"); // único agendamento deste soquete
            try { meuWs.close(); } catch { /* ignore */ }
            return;
          }
        }
        negadoPermanente = /desconhec|removid|expirad/i.test(motivo);
        nivelBackoff = 5; // 30s
        log("NEGADO pelo servidor: " + motivo + (negadoPermanente ? " — vou insistir a cada 5 min, sem te incomodar" : " — tentando de novo em 30s"));
        try { meuWs.close(); } catch { /* ignore */ }
        reagendar("recusa do servidor");
      }
      return;
    }
    if (typeof m.cmd === "string") {
      log("cmd (" + (m.rotulo || "?") + "): " + m.cmd.slice(0, 120));
      estado.ultimo_rotulo = m.rotulo || "?";
      const r = await rodar(m.cmd, m.espera, m.bg === true);
      registrarComando(m.rotulo || "?", r.exit, r.stdout.length + r.stderr.length);
      log("resposta: exit " + r.exit + " (" + r.stdout.length + "+" + r.stderr.length + " bytes)");
      try {
        meuWs.send(JSON.stringify(r));
      } catch {
        log("caiu antes de responder — o servidor vai marcar sem resposta");
      }
    }
  });
  // v3.13.1: 'error' trata sozinho. Confiar no close que "vem em seguida" foi o
  // defeito que deixou a máquina do dono muda depois do deploy de 23/10.
  meuWs.addEventListener("error", () => { clearTimeout(relogioConexao); reagendar("erro de rede"); });
  meuWs.addEventListener("close", () => { clearTimeout(relogioConexao); reagendar("fechou"); });

  // Ajusta a mira do relógio: este soquete é o "atual" enquanto for o último criado.
  vigiaSoquete = () => (meuWs.readyState === WebSocket.OPEN ? meuWs : null);
}

/* ---------------- auto-update ---------------- */
function baixar(para, urlBaixa) {
  return new Promise((res, rej) => {
    const mod = urlBaixa.startsWith("http:") ? http : https;
    const arq = fs.createWriteStream(para);
    mod
      .get(urlBaixa, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          return baixar(para, new URL(r.headers.location, urlBaixa).toString()).then(res, rej);
        }
        if (r.statusCode !== 200) {
          r.resume();
          return rej(new Error("http " + r.statusCode));
        }
        // progresso visível (janela do duplo clique + log): % a cada 5%, MB e velocidade
        const total = Number(r.headers["content-length"] || 0);
        const t0 = Date.now();
        let feito = 0;
        let ultimo = 0; // último valor publicado (pct, ou bytes se não houver total)
        r.on("data", (chunk) => {
          feito += chunk.length;
          const passo = total ? Math.floor((feito * 100) / total) >= ultimo + 5 : feito - ultimo >= 2_000_000;
          if (!passo) return;
          ultimo = total ? Math.floor((feito * 100) / total) : feito;
          const s = Math.max(0.5, (Date.now() - t0) / 1000);
          const mb = (feito / 1048576).toFixed(1);
          const de = total ? " de " + (total / 1048576).toFixed(1) + " MB (" + ultimo + "%)" : "";
          logTela("download: " + mb + " MB" + de + " · " + (feito / 1048576 / s).toFixed(1) + " MB/s");
          setAtualizacao({ para: destinoVersao || "?", fase: "baixando", pct: ultimo, mb, total_mb: total ? (total / 1048576).toFixed(1) : "?", velocidade: (feito / 1048576 / s).toFixed(1) });
        });
        r.pipe(arq);
        arq.on("finish", () => {
          arq.close(() => {
            log("download concluído: " + (feito / 1048576).toFixed(1) + " MB em " + ((Date.now() - t0) / 1000).toFixed(1) + " s — trocando arquivo");
            res();
          });
        });
      })
      .on("error", rej);
    arq.on("error", rej);
  });
}

/* carência de update: versão que já falhou nesta máquina não é tentada de novo por
 * 30 min — sem isso, cada reconexão rebaixava 83 MB (loop visto em campo 23/10). */
const CARENCIA_MS = 30 * 60 * 1000;
function podeTentar(versao) {
  if (falhouPara === versao) return false;
  const t = lerConf().tentou;
  return !(t && t.para === versao && Date.now() - Number(t.ts || 0) < CARENCIA_MS);
}
function registrarFalha(versao) {
  falhouPara = versao;
  gravarConf({ ...lerConf(), tentou: { para: versao, ts: Date.now() } });
}

/* trocaExe: põe o exe novo no lugar devolvendo o caminho que deve ser reaberto.
 * Windows não deixa SOBRESCREVER o exe em uso: o jeito limpo é renomear o vivo
 * (para .old, com o fóssil da tentativa anterior removido antes) e mover o .novo
 * para o nome canônico. Se o sistema travar mesmo a renomeada (antivírus/Explorer
 * segurando o handle), NADA é sobrescrito: a versão nova roda com nome versionado
 * ao lado — o cliente atualiza de qualquer jeito e o nome velho fica intacto. */
function trocarExe(eu, tmp, para) {
  const velho = eu + ".old";
  try {
    try { fs.unlinkSync(velho); } catch { /* não existia */ }
    fs.renameSync(eu, velho);
    try {
      fs.renameSync(tmp, eu);
      if (!EH_WIN) fs.chmodSync(eu, 0o755);
      return eu;
    } catch (e) {
      try { fs.renameSync(velho, eu); } catch { /* devolveu o nome ao vivo */ }
      throw e;
    }
  } catch (e) {
    const alt = eu.replace(/\.exe$/i, "") + "-v" + para + (EH_WIN ? ".exe" : "");
    fs.renameSync(tmp, alt);
    if (!EH_WIN) fs.chmodSync(alt, 0o755);
    log("troca no mesmo nome negada pelo sistema (" + (e.code || e.message) + ") — a versão nova roda como " + alt.split(/[\\/]/).pop());
    return alt;
  }
}

async function verificarAtualizacao() {
  if (VERSAO_CLIENTE === "dev" || atualizando) return; // dev não se auto-atualiza; sem reentrância
  atualizando = true;
  try {
    const r = await fetch(new URL("/maquina/atualizacao", base).toString(), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return;
    const j = await r.json();
    const meuPlat = EH_WIN ? "win" : "linux";
    if (!j.cliente || !j.cliente[meuPlat] || !j.versao) return;
    const maisNovo = (a, b) => {
      const pa = String(a).split(".").map(Number);
      const pb = String(b).split(".").map(Number);
      for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
      return false;
    };
    if (!maisNovo(j.versao, VERSAO_CLIENTE)) { if (estado.atualizacao && estado.atualizacao.fase !== "reiniciando") estado.atualizacao = null; return; }
    if (!podeTentar(j.versao)) { log("atualização para " + j.versao + " já falhou há pouco — não repito o download por 30 min"); return; }
    destinoVersao = j.versao;
    setAtualizacao({ para: j.versao, fase: "baixando", pct: 0, mb: "0", total_mb: "?", velocidade: "0" });
    log("atualizando cliente: " + VERSAO_CLIENTE + " → " + j.versao);
    const eu = process.execPath;
    const tmp = eu + ".novo";
    tmpArq = tmp;
    await baixar(tmp, new URL("/maquina/cliente/" + meuPlat, base).toString());
    setAtualizacao({ fase: "trocando", pct: 100 });
    const novoExe = trocarExe(eu, tmp, j.versao);
    log("exe novo no lugar (" + novoExe.split(/[\\/]/).pop() + ") — reabrindo em janela própria (minimizada, sem roubar tua tela)");
    fecharJanelasNexos(); // v3.16.3: não deixo minha janela velha viva atrás de mim (duas telas na Noot, 24/10)
    const semToken = (() => { const i = argv.indexOf("--token"); return i < 0 ? argv : [...argv.slice(0, i), ...argv.slice(i + 2)]; })();
    const err = await relancar(novoExe, semToken);
    if (err) log("update aplicado mas relancar falhou: " + err.message + " (reabra o exe; esta janela segue funcionando)");
    morrendo = true;
    process.exit(0);
  } catch (e) {
    if (tmpArq) { try { fs.unlinkSync(tmpArq); } catch { /* já foi */ } }
    if (destinoVersao) registrarFalha(destinoVersao);
    log("atualização: " + e.message + (destinoVersao ? " — não repito por 30 min" : "") + " (sigo na versão atual)");
  } finally {
    atualizando = false;
  }
}

/* relancar: herança exata do agente Go (regra do dono 15/10): o sucessor nasce em
 * janela NOVA, já minimizada (start /min = não rouba o foreground), e sobrevive à
 * saída deste processo. O wrapper cmd fica invisível (windowsHide = CREATE_NO_WINDOW).
 * Antes: spawn com stdio inherit — o filho morava NO console do pai; o pai saía e a
 * janela fechava com o agente vivo por trás ("fechou e não reabriu", cobrado 23/10). */
function relancar(caminho, args) {
  if (EH_WIN) {
    const w = spawn("cmd.exe", ["/d", "/c", "start", "", "/min", caminho, ...args], { windowsHide: true });
    return new Promise((res) => {
      w.on("error", res);
      w.on("exit", (code) => res(code ? new Error("start saiu com código " + code) : null));
    });
  }
  try {
    const filho = spawn(caminho, args, { detached: true, stdio: "ignore" });
    filho.unref();
    return Promise.resolve(null);
  } catch (e) {
    return Promise.resolve(e);
  }
}

/* ---------------- entrada ---------------- */
process.on("uncaughtException", (e) => log("erro interno (sigo vivo): " + (e && e.stack ? e.stack.split("\n")[0] : e)));
process.on("unhandledRejection", (e) => log("promessa rejeitada (sigo vivo): " + e));
process.on("SIGINT", () => {
  morrendo = true;
  try { ws && ws.close(); } catch { /* ignore */ }
  process.exit(0);
});

(async function principal() {
  faxinaLog();
  if (!token) {
    log("sem token ainda — assim funciona:");
    log("  1) painel " + base.replace(/\/$/, "") + "/painel/  → aba Máquinas → 'gerar token' (aparece 1 vez)");
    log("  2) ou baixe o seu cliente pronto direto do painel (botão gerar cliente) e dê dois cliques nele");
    log("  depois da primeira vez o arquivo " + confPath + " guarda o token definitivo");
    log("  (tudo o que acontecer fica escrito em " + LOG_PATH + ")");
    await esperarEnter();
    process.exit(2);
  }
  log("log do cliente em " + LOG_PATH);
  iniciarPainel();
  /* v3.13.1 — VIGIA: a última linha de defesa, e a que faltava. Cada volta do laço
   * marca a hora da próxima tentativa; se essa hora passou, não há soquete aberto e
   * ninguém agendou nada, o laço morreu por um caminho que eu não previ — acorda e
   * recomeça. É o fim da era "janela aberta, máquina muda" (23/10, produção). */
  setInterval(() => {
    if (morrendo || atualizando) return;
    if (vigiaSoquete()) return; // há soquete ABERTO: nada a fazer
    const deveTerAcordado = Math.max(ultimaTentativa, proximaJanela);
    if (Date.now() - deveTerAcordado < 90_000) return; // a janela ainda não venceu
    log("vigia: " + Math.round((Date.now() - deveTerAcordado) / 1000) + " s sem conexão e sem tentativa marcada — recomeçando o laço");
    ws = null; // solta o soquete pendurado (os callbacks dele se reconhecem e não marcam mais)
    conectar();
  }, 30_000).unref?.();
  await verificarAtualizacao();
  gravarConf({ ...lerConf(), token, host, url: base, desde: lerConf().desde || new Date().toISOString() });
  conectar();
})();
