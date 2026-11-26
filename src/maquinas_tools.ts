/**
 * Ferramentas de máquina PORTADAS do túnel (servidor_py/mcp.py) — mesma cara, mesmos
 * builders de comando comprovados em rua (JPPC/JNOOT/SrvIAGO). Nada roda aqui: cada
 * tool monta UM script (PowerShell -EncodedCommand no Windows; /bin/sh na Linux) e
 * passa pelo funil único `rodar()` (interruptor geral, dono da máquina, fila, timeout,
 * auditoria). Nomes idênticos aos do túnel: quem usava o túnel usa igual.
 *
 * Fase 2 (ficam no túnel por enquanto): capturar_tela, gui, gui_uia, processo_longo,
 * baixar_arquivo, navegador — dependem de recursos do agente Go que o cliente Node
 * ainda não tem.
 */
import { randomBytes } from "node:crypto";
import { HttpError } from "./errors";
import type { Usuario } from "./config";
import { rodar, alvoMaquina, soConectado, httpBaseDaMaquina, criarRecebimento, consumirRecebimento } from "./maquinas";
import { abrirAnexo, chaveDoEnvio, criarAnexo, idDoEnvio, mimePorNome, MAX_ANEXO, type AnexoMeta } from "./anexos";
import { q } from "./db";

/* ------------------------------------------------------------------ chassis */

/** aspas simples de literal PowerShell: ' -> '' */
const pq = (s: string): string => String(s).replaceAll("'", "''");

/** aspas simples de literal sh (shlex.quote): tudo entre ', com ' -> '\''  */
const sq = (s: string): string => {
  const t = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(t) && t.length > 0) return t;
  return `'${t.replaceAll("'", `'\\''`)}'`;
};

const b64 = (buf: Buffer): string => buf.toString("base64");

/** powershell -NoProfile -EncodedCommand <b64 utf-16le> (roundtrip garantido: utf16le nunca falha) */
export function psEncoded(script: string): string {
  /* v3.49.2 — o Add-Type escreve progresso em stderr (CLIXML) na primeira execução de cada
     processo, e isso sujava a leitura do resultado (o upload "parava em 0%"). Progresso
     silenciado em TODO script: stdout volta limpo. */
  const corpo = "$ProgressPreference='SilentlyContinue'\n" + script;
  const enc = Buffer.from(corpo, "utf16le").toString("base64");
  return `powershell -NoProfile -EncodedCommand ${enc}`;
}

/** corpo PS define $out; stdout volta base64-UTF8 (cmd cp850 corromperia acento) */
function psOut(corpo: string): string {
  return psEncoded(
    "$ErrorActionPreference='Stop'\n" + corpo +
      "\n$texto = ($out | Out-String).TrimEnd()\n" +
      "Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($texto)))\n",
  );
}

/** linha crua para /bin/sh -c (máquina Linux) */
const shCmd = (corpo: string): string => `/bin/sh -c ${sq(corpo)}`;

/** decodifica stdout que o script PS envolveu em base64; texto cru passa intacto */
function b64Out(saida: string): string {
  const bruto = String(saida ?? "");
  const limpo = bruto.replace(/\s+/g, "");
  if (!limpo || limpo.length % 4 !== 0 || !/^[A-Za-z0-9+/=]+$/.test(limpo)) return bruto.trim();
  try {
    const txt = Buffer.from(limpo, "base64").toString("utf8").trim();
    return !txt.includes("\uFFFD") && txt ? txt : bruto.trim();
  } catch {
    return bruto.trim();
  }
}

const saida = (so: string, res: { stdout: string }): string => {
  const txt = so === "windows" ? b64Out(res.stdout) : String(res.stdout ?? "").trim();
  /* T043: o PowerShell devolve CRLF (e `Out-String` às vezes CR solto). Sem normalizar,
     `listar_arquivos` entregava "C:\Windows\r" — valor quebrado para quem fosse abrir. */
  return txt.replace(/\r\n/g, "\n").replace(/\r/g, "");
};

/** T043: o PS 5.1 despeja a moldura do erro nativo (No linha:/CategoryInfo) no stderr.
 *  Ele vem colado numa linha só quando o erro atravessa o `2>&1` — então corta no marcador
 *  antes de filtrar linha a linha, senão o ruído sobrevive inteiro. */
function semRuidoPs(txt: string): string {
  let s = String(txt).replace(/\r/g, "");
  const corte = s.search(/(No linha:|At line:|CategoryInfo|FullyQualifiedErrorId)/i);
  if (corte > 0) s = s.slice(0, corte);
  return s
    .split("\n")
    .filter((l) => !/^\s*(\+|No linha:|At line:|CategoryInfo|FullyQualifiedErrorId|RemoteException)/i.test(l))
    .filter((l) => !/^\s*[~^]+\s*$/.test(l))
    .join("\n")
    .trim();
}

/** PowerShell -EncodedCommand cospe throw em CLIXML no stderr: fica só o texto do erro */
function stderrLimpo(res: { stderr?: string }, limite = 300): string {
  const s = semRuidoPs(String(res.stderr ?? ""));
  if (s.includes("#< CLIXML")) {
    const msgs = s.match(/<S S="Error">([\s\S]*?)<\/S>/g) ?? [];
    if (msgs.length) {
      let txt = msgs.map((m) => m.replace(/<[^>]*>/g, "")).join(" ");
      txt = txt.replaceAll("_x000D__x000A_", " ").replaceAll("_x000A_", " ");
      txt = txt.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (txt) return txt.slice(0, limite);
    }
  }
  return s.trim().slice(0, limite);
}

/** `powershell -Command "..."` vira -EncodedCommand (aspas do cmd.exe destruíam o script) */
export function psAutoencode(c: string): string {
  const baixo = c.toLowerCase();
  if (baixo.includes("encodedcommand") || !baixo.includes("-command")) return c;
  const t = baixo.replace(/^\s+/, "");
  if (!t.startsWith("powershell") && !t.startsWith("pwsh")) return c;
  const i = baixo.indexOf("-command");
  const resto = c.slice(i + "-command".length).replace(/^\s+/, "");
  if (resto.length < 2 || (resto[0] !== '"' && resto[0] !== "'") || !resto.endsWith(resto[0])) return c;
  let interior = resto.slice(1, -1);
  if (!interior) return c;
  interior = interior.replaceAll('\\"', '"').replaceAll("\\'", "'");
  return c.slice(0, i).replace(/\s+$/, "") + " -EncodedCommand " + Buffer.from(interior, "utf16le").toString("base64");
}

const NOME_ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
function validaEnv(env: unknown): Record<string, string> {
  if (!env) return {};
  if (typeof env !== "object" || Array.isArray(env)) throw new HttpError(422, "env deve ser objeto {CHAVE: valor}");
  const limpo: Record<string, string> = {};
  for (const [k0, v0] of Object.entries(env as Record<string, unknown>)) {
    const k = String(k0);
    const v = String(v0 ?? "");
    if (!NOME_ENV.test(k)) throw new HttpError(422, `nome de variavel invalido: ${k}`);
    if (/[\n\r]/.test(v)) throw new HttpError(422, `valor de ${k} nao pode conter nova-linha`);
    limpo[k] = v;
  }
  return limpo;
}
const envPsLinhas = (env: Record<string, string>): string =>
  Object.entries(env).map(([k, v]) => `$env:${k}='${pq(v)}'\n`).join("");
const envDentro = (env: Record<string, string>): string =>
  Object.entries(env).map(([k, v]) => `export ${k}=${sq(v)} && `).join("");

/* ------------------------------------------------------- uploads (canal HTTP p/ escrita) */

interface Upload {
  dados: Buffer;
  host: string;
  expira: number;
}
const uploads = new Map<string, Upload>();
/** v3.45: upload de arquivo GRANDE — a chave aponta para o arquivo no disco */
type UploadDisco = { caminho: string; nome: string; bytes: number; host: string; expira: number };
const uploadsDisco = new Map<string, UploadDisco>();

export function criarUploadDeArquivo(caminho: string, nome: string, bytes: number, host: string): string {
  const chave = randomBytes(16).toString("hex");
  uploadsDisco.set(chave, { caminho, nome, bytes, host, expira: Date.now() + 30 * 60_000 });
  if (uploadsDisco.size > 32) {
    const agora = Date.now();
    for (const [k, u] of uploadsDisco) if (u.expira < agora || uploadsDisco.size > 32) uploadsDisco.delete(k);
  }
  return chave;
}

/** v3.46: NÃO consome no primeiro GET — o destino pode ter caído no meio e pedir
 *  `Range` de novo. Cada chave vale até 5 acessos e expira em 30 min. */
export function consumirUploadDeArquivo(chave: string, host: string): UploadDisco | null {
  const u = uploadsDisco.get(chave) as (UploadDisco & { usos?: number }) | undefined;
  if (!u || u.expira < Date.now() || u.host !== host) return null;
  u.usos = (u.usos ?? 0) + 1;
  if (u.usos >= 5) uploadsDisco.delete(chave);
  return u;
}

/** o servidor guarda os bytes; a máquina-alvo BAIXA por curl com chave one-time (TTL 5min) */
export function criarUpload(dados: Buffer, host: string): string {
  const chave = randomBytes(16).toString("hex");
  uploads.set(chave, { dados, host, expira: Date.now() + 5 * 60_000 });
  if (uploads.size > 64) {
    const agora = Date.now();
    for (const [k, u] of uploads) if (u.expira < agora || uploads.size > 64) uploads.delete(k);
  }
  return chave;
}

export function consumirUpload(chave: string, host: string): Buffer | null {
  const u = uploads.get(chave);
  if (!u || u.expira < Date.now() || u.host !== host) return null;
  return u.dados;
}

/* ------------------------------------------------------------- sessões de pasta */

const sessoes = new Map<string, Map<string, string>>();
const nomeSeguro = (n: string): boolean => /^[A-Za-z0-9._-]{1,40}$/.test(n);

/* ------------------------------------------------------------------ execução */

type Ctx = { u: Usuario; alvo: string; host: string; so: string; origem: string; tool: string; httpBase: () => string | null };

async function exec(
  ctx: Ctx,
  cmd: string,
  espera: number,
  stdoutMax = 20000,
  bg = false,
): Promise<{ exit: number; stdout: string; stderr: string; truncado: boolean }> {
  const r = await rodar(ctx.u, ctx.alvo, ctx.host, cmd, espera, `${ctx.origem}:${ctx.tool}`, stdoutMax, bg);
  return r;
}

/* ------------------------------------------------------------------ as tools */

const A = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const S = (v: unknown): string => String(v ?? "");

async function listarArquivos(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const caminho = S(args.caminho);
  const padrao = S(args.padrao) || "*";
  if (!caminho) throw new HttpError(422, "caminho obrigatório");
  let cmd: string;
  if (ctx.so === "windows") {
    cmd = psEncoded(
      "$ErrorActionPreference='Stop'\n" +
        `Get-ChildItem -LiteralPath '${pq(caminho)}' -Filter '${pq(padrao)}' -Force -ErrorAction SilentlyContinue | ` +
        "Sort-Object Name | ForEach-Object {\n" +
        "  $t = if ($_.PSIsContainer) { 'D' } else { 'F' }\n" +
        "  $s = if ($_.PSIsContainer) { '-' } else { $_.Length }\n" +
        "  \"$t`t$s`t$($_.LastWriteTime.ToString('dd/MM/yyyy HH:mm:ss'))`t$($_.FullName)\"\n" +
        "}\n",
    );
  } else {
    cmd = shCmd(`ls -la --time-style='+%d/%m/%Y %H:%M:%S' -- ${sq(caminho)} 2>/dev/null`);
  }
  const res = await exec(ctx, cmd, 30);
  const itens: unknown[] = [];
  for (const linha of saida(ctx.so, res).split("\n")) {
    if (!linha.trim()) continue;
    if (ctx.so === "windows") {
      const partes = linha.split("\t");
      if (partes.length === 4)
        itens.push({ tipo: partes[0], tamanho: partes[1], modificado: partes[2], caminho: partes[3] });
    } else itens.push({ linha });
  }
  return { ok: true, host: ctx.host, caminho, total: itens.length, itens };
}

async function lerArquivo(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const caminho = S(args.caminho);
  const offset = Math.max(0, Number(args.offset ?? 0) || 0);
  const limite = Math.max(1, Math.min(800000, Number(args.limite ?? 200000) || 200000));
  const binario = Boolean(args.binario);
  if (!caminho) throw new HttpError(422, "caminho obrigatório");
  let cmd: string;
  if (ctx.so === "windows") {
    // valores EMBUTIDOS como literal (medido no túnel: $limite indefinida = 0 bytes lidos com ok)
    cmd = psEncoded(
      "$ErrorActionPreference='Stop'\n" +
        `$fs = [System.IO.File]::OpenRead('${pq(caminho)}')\n` +
        "$tamanho = $fs.Length\n" +
        `[void]$fs.Seek(${offset}, [System.IO.SeekOrigin]::Begin)\n` +
        `$buf = New-Object byte[] ${limite}\n` +
        "$n = 0\n" +
        `while ($n -lt ${limite}) { $r = $fs.Read($buf, $n, ${limite} - $n); if ($r -le 0) { break }; $n += $r }\n` +
        "$fs.Close()\n" +
        "$rec = New-Object byte[] $n\n" +
        "[Array]::Copy($buf, $rec, $n)\n" +
        'Write-Output "$tamanho $n"\n' +
        "Write-Output ([Convert]::ToBase64String($rec))\n",
    );
  } else {
    cmd = shCmd(
      `f=${sq(caminho)}; t=$(mktemp) || exit 9; ` +
        `tail -c +${offset + 1} "$f" | head -c ${limite} > "$t" || exit 8; ` +
        `printf "%s %s\\n" "$(wc -c < "$f" | tr -dc 0-9)" "$(wc -c < "$t" | tr -dc 0-9)"; ` +
        `base64 -w 0 "$t"; rm -f "$t"`,
    );
  }
  const res = await exec(ctx, cmd, 45, 3_200_000);
  /* v3.43: -124 aqui é SILÊNCIO, não demora. Antes a mensagem genérica mandava
     "aumente timeout (max 900s)" — campo que o ler_arquivo não tem — e o modelo
     repetia a mesma chamada pagando 53 s por tentativa. */
  if (res.exit === -124)
    throw new HttpError(504, `leitura sem resposta em 53s — reduza 'limite' (ex.: 200000) ou use 'offset'; nao existe 'timeout' nesta ferramenta`);
  if (res.exit !== 0) throw new HttpError(502, `leitura falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  const linhas = String(res.stdout).split("\n");
  const cab = (linhas[0] ?? "").trim().split(/\s+/);
  const tamanho = Number(cab[0]);
  const lidos = Number(cab[1]);
  if (!Number.isFinite(tamanho) || !Number.isFinite(lidos))
    throw new HttpError(502, `saída de leitura inesperada: ${(res.stdout ?? "").slice(0, 120)}`);
  const b64 = (linhas.slice(1).join("") ?? "").replace(/\s+/g, "");
  const dados = Buffer.from(b64, "base64");
  const out: Record<string, unknown> = {
    ok: true, host: ctx.host, caminho, tamanho_total: tamanho, offset, lidos,
    fim: offset + lidos >= tamanho,
    ...(res.truncado ? { truncado: true } : {}),
  };
  if (binario) out.base64 = b64;
  else out.texto = dados.toString("utf8");
  return out;
}

async function escreverArquivo(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const caminho = S(args.caminho);
  const append = Boolean(args.append);
  if (!caminho) throw new HttpError(422, "caminho obrigatório");
  let dados: Buffer;
  if (S(args.conteudo_base64).trim()) {
    const b = String(args.conteudo_base64).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/=]+$/.test(b)) throw new HttpError(422, "conteudo_base64 inválido");
    dados = Buffer.from(b, "base64");
  } else if (args.conteudo !== undefined) {
    dados = Buffer.from(String(args.conteudo), "utf8");
  } else throw new HttpError(422, "passe conteudo (texto cru utf-8) ou conteudo_base64 (bytes)");
  if (dados.length > 16 * 1024 * 1024) throw new HttpError(422, `conteúdo maior que 16MB (${dados.length} bytes)`);
  const base = ctx.httpBase();
  if (!base) throw new HttpError(500, "máquina conectou sem Host de retorno — sem canal de upload");
  const chave = criarUpload(dados, ctx.host);
  const url = `${base}/maquina/u?k=${chave}&host=${encodeURIComponent(ctx.host)}`;
  let cmd: string;
  if (ctx.so === "windows") {
    const i = caminho.lastIndexOf("\\");
    const pai = i > 0 ? caminho.slice(0, i) : "";
    const mkdir = pai
      ? `$d = '${pq(pai)}'; if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }\n`
      : "";
    const entrega = append
      ? `$fs=[System.IO.File]::Open('${pq(caminho)}',[System.IO.FileMode]::Append,[System.IO.FileAccess]::Write); ` +
        "$b=[System.IO.File]::ReadAllBytes($tmp); $fs.Write($b,0,$b.Length); $fs.Close()\n"
      : `[System.IO.File]::WriteAllBytes('${pq(caminho)}', [System.IO.File]::ReadAllBytes($tmp))\n`;
    cmd = psEncoded(
      "$ErrorActionPreference='Stop'\n" + mkdir +
        "$tmp = Join-Path $env:TEMP ('nexos_dl_' + [guid]::NewGuid().ToString('N') + '.bin')\n" +
        `curl.exe -sS --fail --retry 2 -o $tmp '${pq(url)}'\n` +
        "if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; exit 7 }\n" +
        entrega + "Remove-Item $tmp -Force\n" +
        `Write-Output ((Get-Item -LiteralPath '${pq(caminho)}').Length)\n`,
    );
  } else {
    const i = caminho.lastIndexOf("/");
    const d = sq(i > 0 ? caminho.slice(0, i) : ".");
    const f = sq(caminho);
    cmd = shCmd(
      `tmp=$(mktemp) || exit 9; mkdir -p ${d}; ` +
        `curl -sSf --retry 2 -o "$tmp" ${sq(url)} || { rm -f "$tmp"; exit 7; }; ` +
        `cat "$tmp" ${append ? ">>" : ">"} ${f} || { rm -f "$tmp"; exit 6; }; ` +
        `rm -f "$tmp"; wc -c < ${f} | tr -dc 0-9`,
    );
  }
  let res;
  try {
    res = await exec(ctx, cmd, 90);
  } finally {
    uploads.delete(chave); // a chave da viagem morreu junto com a escrita
  }
  if (res.exit !== 0) throw new HttpError(502, `escrita falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  const ultimo = (saida(ctx.so, res).split("\n").pop() ?? "").trim();
  return { ok: true, host: ctx.host, caminho, bytes_no_arquivo: /^\d+$/.test(ultimo) ? Number(ultimo) : null, append };
}

async function buscarArquivos(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const raiz = S(args.raiz);
  const nome = S(args.nome) || "*";
  const conteudo = S(args.conteudo);
  const mx = Math.max(1, Math.min(1000, Number(args.max_resultados ?? 200) || 200));
  if (!raiz) throw new HttpError(422, "raiz obrigatória");
  let cmd: string;
  if (ctx.so === "windows") {
    cmd = psEncoded(
      "$ErrorActionPreference='Continue'\n" +
        `$conteudo = '${pq(conteudo)}'\n` +
        `Get-ChildItem -LiteralPath '${pq(raiz)}' -Recurse -File -Force -Filter '${pq(nome)}' -ErrorAction SilentlyContinue | ` +
        "Where-Object {\n" +
        "  if (-not $conteudo) { return $true }\n" +
        "  if ($_.Length -ge 20MB) { return $false }\n" +
        "  return [bool](Select-String -LiteralPath $_.FullName -SimpleMatch -Pattern $conteudo -Quiet)\n" +
        "} | Select-Object -First " + mx + " | ForEach-Object { \"$($_.Length)`t$($_.FullName)\" }\n",
    );
  } else {
    const busk = conteudo
      ? `grep -rl --include=${sq(nome)} -F ${sq(conteudo)} ${sq(raiz)} 2>/dev/null`
      : `find ${sq(raiz)} -type f -name ${sq(nome)} 2>/dev/null`;
    cmd = shCmd(`${busk} | head -n ${mx}`);
  }
  const res = await exec(ctx, cmd, 120);
  const arquivos: unknown[] = [];
  for (const linha of saida(ctx.so, res).split("\n")) {
    if (!linha.trim()) continue;
    if (ctx.so === "windows" && linha.includes("\t")) {
      const [tam, ...rest] = linha.split("\t");
      arquivos.push({ caminho: rest.join("\t"), tamanho: /^\d+$/.test(tam) ? Number(tam) : null });
    } else arquivos.push({ caminho: linha });
  }
  return { ok: true, host: ctx.host, raiz, nome, conteudo: conteudo || null, total: arquivos.length, truncado: arquivos.length >= mx, arquivos };
}

async function grepRemoto(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const raiz = S(args.raiz);
  const padrao = S(args.padrao);
  const glob = S(args.glob) || "*";
  const ctxn = Math.max(0, Math.min(10, Number(args.contexto ?? 0) || 0));
  const mx = Math.max(1, Math.min(1000, Number(args.max_resultados ?? 100) || 100));
  const rx = Boolean(args.regex);
  const ic = args.ignore_case === undefined ? true : Boolean(args.ignore_case);
  if (!raiz || !padrao) throw new HttpError(422, "raiz e padrao obrigatórios");
  if (padrao.includes("\n")) throw new HttpError(422, "grep_remoto busca UMA linha; use buscar_arquivos/editar p/ multiline");
  let cmd: string;
  if (ctx.so === "windows") {
    const flags = (rx ? "" : " -SimpleMatch") + (ctxn ? ` -Context ${ctxn},${ctxn}` : "");
    const sens = ic ? "" :
      " | Where-Object { if ($hregex) { $_.Line -cmatch $hpat } else { $_.Line.Contains($hpat) } }";
    cmd = psOut(
      `$hpat = '${pq(padrao)}'\n` +
      `$hregex = ${rx ? "$true" : "$false"}\n` +
      `$hits = @(Get-ChildItem -LiteralPath '${pq(raiz)}' -Recurse -File -Force -Filter '${pq(glob)}' -ErrorAction SilentlyContinue | ` +
      "Where-Object { $_.Length -lt 20MB } | Select-String -Pattern $hpat" + flags +
      " -ErrorAction SilentlyContinue" + sens + ` | Select-Object -First ${mx})\n` +
      "$sb = New-Object System.Collections.Generic.List[string]\n" +
      "foreach ($h in $hits) {\n" +
      "  foreach ($pre in $h.Context.PreContext) { $sb.Add('  | ' + $pre) }\n" +
      '  $sb.Add("$($h.Path):$($h.LineNumber): $($h.Line)")\n' +
      "  foreach ($pos in $h.Context.PostContext) { $sb.Add('  | ' + $pos) }\n" +
      "}\n" +
      '$out = (($sb -join "`n") + "`nTOTAL=$($hits.Count)")\n',
    );
  } else {
    cmd = shCmd(
      "grep -rn " + (rx ? "-E " : "-F ") + (ic ? "-i " : "") + `--include=${sq(glob)} ` +
      (ctxn ? `-C ${ctxn} ` : "") + `-- ${sq(padrao)} ${sq(raiz)} 2>/dev/null | head -n ${mx * 3}`,
    );
  }
  const res = await exec(ctx, cmd, 120);
  if (res.exit !== 0) throw new HttpError(502, `grep falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  return { ok: true, host: ctx.host, raiz, padrao, resumo: saida(ctx.so, res).slice(0, 60000) };
}

async function editarNoLocal(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const caminho = S(args.caminho);
  const busca = args.busca;
  const subs = args.substituicao;
  if (!caminho || typeof busca !== "string" || !busca) throw new HttpError(422, "caminho e busca (texto nao-vazio) obrigatorios");
  if (typeof subs !== "string") throw new HttpError(422, "substituicao deve ser texto (vazio = apagar a busca)");
  const ra = Boolean(args.replace_all);
  const seca = Boolean(args.seca);
  /* v3.40 — busca/substituição NÃO viajam mais dentro do comando. Antes eram embutidas no
     PowerShell/Python montados aqui e esbarravam no teto de 4000 chars do transporte
     (`origem` de tool de máquina não era "envelope"), o que empurrava o modelo a improvisar
     com rodar_comando. Agora vão num pacote JSON pelo canal de upload — o mesmo do
     escrever_arquivo, com teto de 16MB — e o comando remoto fica curto e fixo: baixa o
     pacote e aplica. A API da tool continua igual (busca/substituicao como texto cru). */
  const base = ctx.httpBase();
  if (!base) throw new HttpError(500, "máquina conectou sem Host de retorno — sem canal de edição");
  const pacote = Buffer.from(
    JSON.stringify({ p: caminho, b: busca, s: subs, ra, seca }),
    "utf8",
  );
  if (pacote.length > 16 * 1024 * 1024)
    throw new HttpError(422, `texto de edição maior que 16MB (${pacote.length} bytes)`);
  const chave = criarUpload(pacote, ctx.host);
  const url = `${base}/maquina/u?k=${chave}&host=${encodeURIComponent(ctx.host)}`;
  let cmd: string;
  if (ctx.so === "windows") {
    cmd = psEncoded(
      "$ErrorActionPreference='Stop'\n" +
        "$tmp = Join-Path $env:TEMP ('nexos_ed_' + [guid]::NewGuid().ToString('N') + '.json')\n" +
        `curl.exe -sS --fail --retry 2 -o $tmp '${pq(url)}'\n` +
        "if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue; throw 'download do pacote de edicao falhou' }\n" +
        "$d = Get-Content -LiteralPath $tmp -Raw -Encoding UTF8 | ConvertFrom-Json\n" +
        "Remove-Item $tmp -Force\n" +
        "$p = [string]$d.p; $busca = [string]$d.b; $subs = [string]$d.s\n" +
        "$RA = [bool]$d.ra; $SECA = [bool]$d.seca\n" +
        "function Count-Of([string]$t, [string]$b) {\n" +
        "  $n = 0; $i = 0\n" +
        "  while (($i = $t.IndexOf($b, $i, [System.StringComparison]::Ordinal)) -ge 0) { $n = $n + 1; $i += $b.Length }\n" +
        "  return $n }\n" +
        "if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw 'arquivo nao existe' }\n" +
        "$fi = Get-Item -LiteralPath $p\n" +
        "if ($fi.Length -gt 16MB) { throw ('grande demais p/ edicao local: ' + $fi.Length + ' bytes (teto 16MB)') }\n" +
        "$txt = [System.IO.File]::ReadAllText($p)\n" +
        "if ($txt.Contains([char]0)) { throw 'parece binario (NUL no conteudo) — use escrever_arquivo' }\n" +
        "$n = Count-Of $txt $busca\n" +
        "$eol = ''\n" +
        "if ($n -eq 0 -and $busca.Contains(\"`n\")) {\n" +
        "  $busca = $busca.Replace(\"`n\", \"`r`n\"); $subs = $subs.Replace(\"`n\", \"`r`n\")\n" +
        "  $n = Count-Of $txt $busca\n" +
        "  if ($n -gt 0) { $eol = 'lf->crlf' }\n" +
        "}\n" +
        "if ($n -eq 0) { throw 'NAO ENCONTRADO: busca com 0 ocorrencias' }\n" +
        "if ($n -gt 1 -and -not $RA) { throw ('MULTIPLOS: ' + $n + ' ocorrencias — use replace_all') }\n" +
        "$novo = $txt.Replace($busca, $subs)\n" +
        "if (-not $SECA) {\n" +
        "  $enc = New-Object System.Text.UTF8Encoding($false)\n" +
        "  [System.IO.File]::WriteAllText($p, $novo, $enc)\n" +
        "}\n" +
        "$d2 = (Get-Item -LiteralPath $p).Length\n" +
        "$tag = if ($SECA) { 'SECA local' } else { 'EDITADO local' }\n" +
        "Write-Output ($tag + ' ocorrencias=' + $n + ' bytes=' + $d2 + ' eol=' + $eol)\n",
    );
  } else {
    const code =
      "import io,json,sys,urllib.request\n" +
      `d=json.loads(urllib.request.urlopen('${url}').read().decode('utf-8'))\n` +
      "p,b,s,ra,seca=d['p'],d['b'],d['s'],d['ra'],d['seca']\n" +
      "t=io.open(p,encoding='utf-8',errors='strict').read()\n" +
      "n=t.count(b)\n" +
      "if n==0: sys.exit('NAO ENCONTRADO: busca com 0 ocorrencias')\n" +
      "if n>1 and not ra: sys.exit('MULTIPLOS: '+str(n)+' ocorrencias - use replace_all')\n" +
      "if seca:\n" +
      "    print('SECA local ocorrencias='+str(n))\n" +
      "else:\n" +
      "    t=t.replace(b,s)\n" +
      "    io.open(p,'w',encoding='utf-8').write(t)\n" +
      "    print('EDITADO local ocorrencias='+str(n)+' bytes='+str(len(t.encode('utf-8'))))\n";
    cmd = shCmd("python3 -c " + sq(code));
  }
  const res = await exec(ctx, cmd, 60);
  if (res.exit !== 0)
    throw new HttpError(502, `editar_no_local: ${(saida(ctx.so, res) || stderrLimpo(res)).slice(0, 200)}`);
  return { ok: true, host: ctx.host, caminho, resumo: saida(ctx.so, res).slice(0, 2000) };
}

async function estadoMaquina(ctx: Ctx): Promise<unknown> {
  let cmd: string;
  if (ctx.so === "windows") {
    cmd = psOut(
      "$os = Get-CimInstance Win32_OperatingSystem\n" +
      "$cs = Get-CimInstance Win32_ComputerSystem\n" +
      "$cpu = @(Get-CimInstance Win32_Processor)[0]\n" +
      "$lin = @()\n" +
      '$lin += "HOST=$($cs.Name) SO=$($os.Caption)"\n' +
      '$lin += "UP=$([int](([DateTime]::Now - $os.LastBootUpTime).TotalHours))h (boot $($os.LastBootUpTime))"\n' +
      '$lin += "RAM=$([int]($os.FreePhysicalMemory/1024))MB livres de $([int]($os.TotalVisibleMemorySize/1024))MB"\n' +
      '$lin += "CPU=$($cpu.LoadPercentage)% $($($cpu.Name))"\n' +
      "foreach ($d in Get-PSDrive -PSProvider FileSystem) {\n" +
      "  $tot = [int](($d.Used + $d.Free) / 1GB)\n" +
      '  if ($tot -gt 0) { $lin += "DISCO $($d.Name): $([int]($d.Free/1GB))GB livres de ${tot}GB" }\n' +
      "}\n" +
      '$out = $lin -join "`n"\n',
    );
  } else {
    cmd = shCmd("hostname; uptime; free -m | sed -n 2p; df -B1G 2>/dev/null | tail -n +2");
  }
  const res = await exec(ctx, cmd, 45);
  if (res.exit !== 0) throw new HttpError(502, `estado falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  return { ok: true, host: ctx.host, resumo: saida(ctx.so, res) };
}

async function processos(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const acao = S(args.acao) || "listar";
  let cmd: string;
  if (acao === "listar") {
    const top = Math.max(1, Math.min(100, Number(args.top ?? 15) || 15));
    cmd = ctx.so === "windows"
      ? psOut(
          '$lin = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ' + top +
          ' | ForEach-Object { "PID=$($_.Id) MEM=$([int]($_.WorkingSet64/1MB))MB CPU=$([int]($_.CPU))s APP=$($_.ProcessName) TITULO=$($_.MainWindowTitle)" }\n' +
          '$out = $lin -join "`n"\n',
        )
      : shCmd(`ps -eo pid,rss,pcpu,comm --sort=-rss | head -n ${top + 1}`);
  } else if (acao === "matar") {
    /* v3.39: além do nome, aceita PID e PORTA — antes só nome, e achar o PID de quem
       ocupava a 8080 custava uma tool `rede portas` + uma `processos listar`. */
    const nome = S(args.nome).trim();
    const pid = Number(args.pid ?? 0) || 0;
    const porta = Number(args.porta ?? 0) || 0;
    const quantos = [nome, pid, porta].filter(Boolean).length;
    if (quantos === 0) throw new HttpError(422, "matar exige nome, pid ou porta");
    if (quantos > 1) throw new HttpError(422, "matar aceita UM alvo por vez: nome OU pid OU porta");
    if (pid && (!Number.isInteger(pid) || pid < 1)) throw new HttpError(422, "pid invalido");
    if (porta && (porta < 1 || porta > 65535)) throw new HttpError(422, "porta invalida (1-65535)");
    if (ctx.so === "windows") {
      if (porta) {
        cmd = psOut(
          `$l = @(Get-NetTCPConnection -LocalPort ${porta} -State Listen -ErrorAction SilentlyContinue)\n` +
          `if ($l.Count -eq 0) { throw 'nenhum processo escutando na porta ${porta}' }\n` +
          "$ids = @($l | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)\n" +
          "Stop-Process -Id $ids -Force\n" +
          `$out = "MATOU porta=${porta} PIDs=$($ids -join ',')"\n`,
        );
      } else if (pid) {
        cmd = psOut(
          `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue\n` +
          `if (-not $p) { throw 'nenhum processo com PID ${pid}' }\n` +
          `Stop-Process -Id ${pid} -Force\n$out = "MATOU PID=${pid} APP=$($p.ProcessName)"\n`,
        );
      } else {
        cmd = psOut(`$ids = @(Get-Process -Name '${pq(nome)}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })\nif ($ids.Count -eq 0) { throw 'nenhum processo com nome ${pq(nome)}' }\nStop-Process -Id $ids -Force\n$out = "MATOU $($ids.Count): $($ids -join ',')"\n`);
      }
    } else {
      if (porta) {
        cmd = shCmd(
          `pid=$(ss -tlnp 2>/dev/null | awk '$4 ~ /:${porta}$/ {print $6}' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -1)\n` +
          `[ -n "$pid" ] || { echo "nenhum processo escutando na porta ${porta}"; exit 9; }\n` +
          `kill -9 "$pid" && echo "MATOU porta=${porta} PID=$pid"`,
        );
      } else if (pid) {
        cmd = shCmd(`kill -9 ${pid} 2>/dev/null && echo "MATOU PID=${pid}" || { echo "nenhum processo com PID ${pid}"; exit 9; }`);
      } else {
        cmd = shCmd(`pkill -x ${sq(nome)} && echo MATOU || { echo NAO_ENCONTRADO; exit 9; }`);
      }
    }
  } else throw new HttpError(422, "acao deve ser listar ou matar");
  const res = await exec(ctx, cmd, 45);
  if (res.exit !== 0) throw new HttpError(502, `processos falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  return { ok: true, host: ctx.host, acao, resumo: saida(ctx.so, res).slice(0, 40000) };
}

/* v3.39: um comando só para o retrato da máquina — CPU, RAM, disco, GPU e top de
   memória. Antes eram três tools (estado_maquina + procesos + nvidia-smi na mão). */
async function metricas(ctx: Ctx): Promise<unknown> {
  let cmd: string;
  if (ctx.so === "windows") {
    cmd = psOut(
      "$os = Get-CimInstance Win32_OperatingSystem\n" +
      "$cpu = @(Get-CimInstance Win32_Processor)[0]\n" +
      "$lin = @()\n" +
      '$lin += "CPU_PCT=$($cpu.LoadPercentage)"\n' +
      "$ramTot = [int]($os.TotalVisibleMemorySize/1024)\n" +
      "$ramLiv = [int]($os.FreePhysicalMemory/1024)\n" +
      '$lin += "RAM_MB usada=$($ramTot-$ramLiv) total=$ramTot livre=$ramLiv"\n' +
      "$lin += \"UPTIME_H=$([int](([DateTime]::Now - $os.LastBootUpTime).TotalHours))\"\n" +
      "foreach ($d in Get-PSDrive -PSProvider FileSystem) {\n" +
      "  $tot = [int](($d.Used + $d.Free) / 1GB)\n" +
      '  if ($tot -gt 0) { $lin += "DISCO $($d.Name): livre=$([int]($d.Free/1GB))GB de ${tot}GB" }\n' +
      "}\n" +
      "$lin += @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object { \"TOP PID=$($_.Id) MEM=$([int]($_.WorkingSet64/1MB))MB APP=$($_.ProcessName)\" })\n" +
      "try {\n" +
      "  $g = @(& nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader 2>$null)\n" +
      "  if ($g.Count -gt 0) { $lin += @($g | ForEach-Object { \"GPU $_\" }) } else { $lin += 'GPU nenhuma (nvidia-smi sem resposta)' }\n" +
      "} catch { $lin += 'GPU nenhuma (nvidia-smi ausente)' }\n" +
      '$out = $lin -join "`n"\n',
    );
  } else {
    cmd = shCmd(
      "echo CPU_PCT=$(awk '{u=$2+$4; t=$2+$4+$5} END {if (t>0) printf \"%d\", u*100/t; else print 0}' /proc/stat)\n" +
      "free -m | awk '/^Mem:/ {print \"RAM_MB usada=\" $3 \" total=\" $2 \" livre=\" $7}'\n" +
      "echo UPTIME_H=$(awk '{print int($1/3600)}' /proc/uptime)\n" +
      "df -BG 2>/dev/null | tail -n +2 | awk '{print \"DISCO \" $6 \": livre=\" $4 \" de \" $2}'\n" +
      "ps -eo pid,rss,comm --sort=-rss | head -n 6 | tail -n +2 | awk '{print \"TOP PID=\" $1 \" MEM=\" int($2/1024) \"MB APP=\" $3}'\n" +
      "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader 2>/dev/null | sed 's/^/GPU /'; else echo 'GPU nenhuma (nvidia-smi ausente)'; fi",
    );
  }
  const res = await exec(ctx, cmd, 45);
  if (res.exit !== 0) throw new HttpError(502, `metricas falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  return { ok: true, host: ctx.host, resumo: saida(ctx.so, res).slice(0, 20000) };
}

async function janelas(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  if (ctx.so !== "windows") throw new HttpError(422, `janelas so em Windows (host ${ctx.host} e ${ctx.so})`);
  const acao = S(args.acao) || "listar";
  let corpo: string;
  if (acao === "listar") {
    corpo = '$out = (Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "PID=$($_.Id) APP=$($_.ProcessName) TITULO=$($_.MainWindowTitle)" }) -join "`n"\n';
  } else if (acao === "focar") {
    const t = S(args.titulo);
    if (!t) throw new HttpError(422, "focar exige titulo (substring)");
    corpo =
      'Add-Type -Namespace Win32 -Name FW -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);\'\n' +
      `$hpat = '*${pq(t)}*'\n` +
      "$alvo = Get-Process | Where-Object { $_.MainWindowTitle -like $hpat } | Select-Object -First 1\n" +
      "if (-not $alvo) { throw ('janela nao encontrada: ' + $hpat) }\n" +
      "[void][Win32.FW]::ShowWindowAsync($alvo.MainWindowHandle, 9)\n" +
      "[void][Win32.FW]::SetForegroundWindow($alvo.MainWindowHandle)\n" +
      '$out = "FOCOU PID=$($alvo.Id) TITULO=$($alvo.MainWindowTitle)"\n';
  } else throw new HttpError(422, "acao deve ser listar ou focar");
  const res = await exec(ctx, psOut(corpo), 45);
  if (res.exit !== 0) throw new HttpError(502, `janelas falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  return { ok: true, host: ctx.host, janelas: saida(ctx.so, res).slice(0, 40000) };
}

async function areaTransferencia(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const acao = S(args.acao) || "get";
  if (acao !== "get" && acao !== "set") throw new HttpError(422, "acao deve ser get ou set");
  const texto = args.texto;
  if (acao === "set") {
    if (typeof texto !== "string" || !texto) throw new HttpError(422, "set exige texto nao-vazio");
    if (texto.length > 200000) throw new HttpError(422, "texto grande demais p/ clipboard (200KB)");
  }
  let cmd: string;
  if (ctx.so === "windows") {
    /* T043: em sessão remota (RDP/RustDesk/AnyDesk) Get-Clipboard e Set-Clipboard estouram
       "Requested Clipboard operation did not succeed". Cai para o Win32 via Windows.Forms. */
    const nucleo = acao === "get"
      ? "$out = Get-Clipboard -Raw; if ($null -eq $out) { $out = '' }"
      : `Set-Clipboard -Value '${pq(String(texto))}'; $out = 'AREA_SET_OK'`;
    const reserva = acao === "get"
      ? "Add-Type -AssemblyName System.Windows.Forms\n$out = [System.Windows.Forms.Clipboard]::GetText()\nif ($null -eq $out) { $out = '' }"
      : `Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.Clipboard]::SetText('${pq(String(texto))}')\n$out = 'AREA_SET_OK'`;
    cmd = psOut(
      "$erro = ''\n" +
        "for ($i = 0; $i -lt 3; $i++) {\n" +
        "  try { " + nucleo + "; $erro = ''; break } catch { $erro = $_.Exception.Message }\n" +
        "  try { " + reserva + "; $erro = ''; break } catch { $erro = $_.Exception.Message }\n" +
        "  Start-Sleep -Milliseconds 300\n" +
        "}\n" +
        "if ($erro) { $out = 'AREA_BLOQUEADA: ' + $erro }\n",
    );
  } else {
    cmd = acao === "get"
      ? shCmd("command -v xclip >/dev/null 2>&1 || { echo SEM_XCLIP; exit 9; }; xclip -o -selection clipboard 2>/dev/null")
      : shCmd(`command -v xclip >/dev/null 2>&1 || { echo SEM_XCLIP; exit 9; }; printf '%s' ${sq(String(texto))} | xclip -selection clipboard`);
  }
  const res = await exec(ctx, cmd, 45);
  const corpo = (saida(ctx.so, res) || stderrLimpo(res)).slice(0, 250);
  if (res.exit !== 0 || corpo.includes("AREA_BLOQUEADA")) {
    const bloqueado = corpo.includes("AREA_BLOQUEADA");
    throw new HttpError(
      bloqueado ? 422 : 502,
      bloqueado
        ? `area_transferencia: o Windows recusou o clipboard (${corpo.replace("AREA_BLOQUEADA:", "").trim().slice(0, 160)}) — sessao remota RDP/RustDesk/AnyDesk trava a area de transferencia; libere no app e tente de novo`
        : `area_transferencia falhou (exit=${res.exit}): ${corpo}`,
    );
  }
  return acao === "get"
    ? { ok: true, host: ctx.host, conteudo: saida(ctx.so, res).slice(0, 200000) }
    : { ok: true, host: ctx.host, set_chars: String(texto).length };
}

async function falar(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const texto = S(args.texto);
  if (!texto.trim()) throw new HttpError(422, "texto vazio");
  if (texto.length > 600) throw new HttpError(422, "maximo 600 chars");
  const cmd = ctx.so === "windows"
    ? psOut("Add-Type -AssemblyName System.Speech\n$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n$s.Volume = 70\n$s.Speak('" + pq(texto) + "')\n$out = 'FALOU " + texto.length + " chars'\n")
    : shCmd(`if command -v espeak-ng >/dev/null 2>&1; then espeak-ng -v pt -- ${sq(texto)}; elif command -v espeak >/dev/null 2>&1; then espeak -v pt+f2 -- ${sq(texto)}; else echo SEM_ESPEAK; exit 9; fi`);
  const res = await exec(ctx, cmd, 90);
  if (res.exit !== 0) throw new HttpError(502, `falar falhou (exit=${res.exit}): ${(saida(ctx.so, res).slice(0, 120) || stderrLimpo(res))}`);
  return { ok: true, host: ctx.host, resumo: saida(ctx.so, res).slice(0, 200) };
}

async function abrir(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const alvo = S(args.alvo).trim();
  if (!alvo || alvo.length > 500) throw new HttpError(422, "alvo invalido (vazio ou >500 chars)");
  const cmd = ctx.so === "windows"
    ? psOut("Start-Process -FilePath '" + pq(alvo) + "'\n$out = 'ABRIU'\n")
    : shCmd("command -v xdg-open >/dev/null 2>&1 || { echo SEM_XDG; exit 9; }; xdg-open " + sq(alvo));
  const res = await exec(ctx, cmd, 30);
  if (res.exit !== 0) throw new HttpError(502, `abrir falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  return { ok: true, host: ctx.host, alvo };
}

async function servicos(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const acao = S(args.acao) || "listar";
  let cmd: string;
  if (acao === "listar") {
    const mx = Math.max(1, Math.min(200, Number(args.max_resultados ?? 30) || 30));
    const filtro = S(args.filtro) || "*";
    cmd = ctx.so === "windows"
      ? psOut("$lin = Get-Service -Name '" + pq(filtro) + "' -ErrorAction SilentlyContinue | Select-Object -First " + mx + ' | ForEach-Object { "$($_.Status) $($_.Name) :: $($_.DisplayName)" }\n$out = ($lin -join "`n"); if (-not $out) { $out = \'NENHUM_SERVICO\' }\n')
      : shCmd(`systemctl list-units --type=service --no-pager 2>/dev/null | head -n ${mx}`);
  } else if (acao === "start" || acao === "stop" || acao === "restart") {
    const nome = S(args.nome).trim();
    if (!nome) throw new HttpError(422, "start/stop/restart exigem nome exato do servico");
    cmd = ctx.so === "windows"
      ? psOut(`${acao === "start" ? "Start-Service" : acao === "stop" ? "Stop-Service" : "Restart-Service"} -Name '${pq(nome)}' -ErrorAction Stop\n$out = "${pq(nome)} agora = $((Get-Service -Name '${pq(nome)}').Status)"\n`)
      : shCmd(`systemctl ${acao} -- ${sq(nome)} && systemctl is-active -- ${sq(nome)}`);
  } else throw new HttpError(422, "acao invalida");
  const res = await exec(ctx, cmd, 60);
  if (res.exit !== 0)
    throw new HttpError(502, `servicos falhou (exit=${res.exit} — precisa de admin?): ${(saida(ctx.so, res).slice(0, 120) || stderrLimpo(res))}`);
  return { ok: true, host: ctx.host, resumo: saida(ctx.so, res).slice(0, 40000) };
}

async function eventos(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const h = Math.max(1, Math.min(168, Number(args.horas ?? 24) || 24));
  const mx = Math.max(1, Math.min(100, Number(args.max_resultados ?? 15) || 15));
  const nivel = (S(args.nivel) || "erro").toLowerCase();
  let cmd: string;
  if (ctx.so === "windows") {
    let corpo = "$ini = (Get-Date).AddHours(-" + h + ")\n$fl = @{ LogName = 'Application','System'; StartTime = $ini }\n";
    if (nivel !== "qualquer") corpo += "$fl.Level = 1,2,3\n";
    corpo += "$ev = @(Get-WinEvent -FilterHashtable $fl -MaxEvents " + mx + " -ErrorAction SilentlyContinue)\n" +
      "$sb = New-Object System.Collections.Generic.List[string]\n" +
      "foreach ($e in $ev) {\n" +
      '  $m = (($e.Message -split "`n") | Where-Object { $_ } | Select-Object -First 1)\n' +
      "  if ($m -and $m.Length -gt 160) { $m = $m.Substring(0,160) }\n" +
      '  $sb.Add("$($e.TimeCreated) [$($e.LevelDisplayName)] $($e.ProviderName): $m")\n' +
      "}\n" +
      '$out = if ($sb.Count) { $sb -join "`n" } else { \'NENHUM_EVENTO\' }\n';
    cmd = psOut(corpo);
  } else {
    cmd = shCmd(`journalctl -p err --since '${h} hours ago' --no-pager 2>/dev/null | tail -n ${mx}`);
  }
  const res = await exec(ctx, cmd, 60);
  if (res.exit !== 0) throw new HttpError(502, `eventos falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  return { ok: true, host: ctx.host, janela_horas: h, resumo: saida(ctx.so, res).slice(0, 40000) };
}

async function rede(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const acao = S(args.acao);
  const alvo = S(args.alvo).trim();
  if ((acao === "ping" || acao === "dns" || acao === "tracado") && !alvo) throw new HttpError(422, `${acao} exige alvo`);
  let espera = 45;
  let timeoutEp = 30;
  if (acao === "espera_porta") {
    if (!/^\d+$/.test(alvo) || Number(alvo) < 1 || Number(alvo) > 65535)
      throw new HttpError(422, "espera_porta: alvo deve ser a porta numerica (ex.: 5173)");
    timeoutEp = Math.max(1, Math.min(900, Number(args.timeout ?? 30) || 30));
    espera = timeoutEp + 20;
  }
  let cmd: string;
  if (ctx.so === "windows") {
    let corpo: string;
    if (acao === "ping")
      corpo = "$r = @(Test-Connection -ComputerName '" + pq(alvo) + "' -Count 4 -ErrorAction SilentlyContinue)\nif ($r.Count -eq 0) { throw 'sem resposta de " + pq(alvo) + "' }\n$out = ($r | ForEach-Object { \"PING $($_.Address) $($_.ResponseTime)ms\" }) -join \"`n\"\n";
    else if (acao === "dns")
      corpo = "$r = @(Resolve-DnsName '" + pq(alvo) + "' -ErrorAction SilentlyContinue | Select-Object -First 10)\nif ($r.Count -eq 0) { throw 'sem resposta dns para " + pq(alvo) + "' }\n$out = ($r | ForEach-Object { \"DNS $($_.Name) TIPO=$($_.Type) IP=$($_.IPAddress)\" }) -join \"`n\"\n";
    else if (acao === "tracado") corpo = '$out = (tracert -d -w 1000 -h 16 \'' + pq(alvo) + "') -join \"`n\"\n";
    else if (acao === "portas")
      corpo = "$lin = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess } | ForEach-Object {\n  $pr = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName\n  \"LISTEN $($_.LocalAddress):$($_.LocalPort) PID=$($_.OwningProcess) $pr\" } | Sort-Object -Unique)\n$out = if ($lin.Count) { $lin -join \"`n\" } else { 'NENHUMA' }\n";
    else if (acao === "espera_porta")
      corpo = `$porta = ${alvo}\n$limite = (Get-Date).AddSeconds(${timeoutEp})\nwhile ($true) {\n  $l = @(Get-NetTCPConnection -State Listen -LocalPort $porta -ErrorAction SilentlyContinue)\n  if ($l.Count -gt 0) { $out = ('ABERTA porta=' + $porta + ' PID=' + $l[0].OwningProcess); break }\n  if ((Get-Date) -gt $limite) { $out = ('TEMPO_ESGOTADO porta=' + $porta); break }\n  Start-Sleep -Milliseconds 700\n}\n`;
    else if (acao === "info")
      corpo = "$lin = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { \"IP $($_.IPAddress)/$($_.PrefixLength) if=$($_.InterfaceAlias)\" })\n$lin += @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -First 3 | ForEach-Object { \"GW $($_.NextHop)\" })\n$lin += @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses } | Select-Object -First 4 | ForEach-Object { \"DNS $($_.InterfaceAlias): $($_.ServerAddresses -join ',')\" })\n$out = ($lin -join \"`n\")\n";
    else throw new HttpError(422, "acao deve ser ping, dns, tracado, portas, espera_porta ou info");
    if (acao === "tracado") espera = 90;
    cmd = psOut(corpo);
  } else {
    if (acao === "ping") cmd = shCmd(`ping -c 4 -W 2 ${sq(alvo)} 2>&1 | tail -n 3`);
    else if (acao === "dns") cmd = shCmd(`getent hosts ${sq(alvo)}`);
    else if (acao === "tracado") cmd = shCmd(`command -v traceroute >/dev/null || { echo SEM_TRACEROUTE; exit 9; }; traceroute -w 2 ${sq(alvo)} | head -20`);
    else if (acao === "info") cmd = shCmd("ip -brief addr 2>/dev/null || ifconfig | grep 'inet '; ip route 2>/dev/null | head -3");
    else if (acao === "portas") cmd = shCmd("ss -tlnp 2>/dev/null | tail -n +2 | head -60 || netstat -tlnp 2>/dev/null | tail -n +3 | head -60");
    else if (acao === "espera_porta")
      cmd = shCmd(`limite=$(( $(date +%s) + ${timeoutEp} ))\nwhile true; do\n  if command -v bash >/dev/null 2>&1 && bash -c 'exec 3<>/dev/tcp/127.0.0.1/${alvo}' 2>/dev/null; then echo ABERTA porta=${alvo}; break; fi\n  if command -v python3 >/dev/null 2>&1 && python3 -c 'import socket;socket.create_connection(("127.0.0.1",${alvo}),1)' 2>/dev/null; then echo ABERTA porta=${alvo}; break; fi\n  if [ $(date +%s) -gt $limite ]; then echo TEMPO_ESGOTADO porta=${alvo}; break; fi\n  sleep 0.7\ndone`);
    else throw new HttpError(422, "acao deve ser ping, dns, tracado, portas, espera_porta ou info");
  }
  const res = await exec(ctx, cmd, espera);
  if (res.exit !== 0)
    throw new HttpError(502, `rede falhou (exit=${res.exit}): ${(saida(ctx.so, res).slice(0, 120) || stderrLimpo(res))}`);
  const txt = saida(ctx.so, res);
  if (acao === "espera_porta" && txt.includes("TEMPO_ESGOTADO")) throw new HttpError(502, `porta ${alvo} nao abriu em ${timeoutEp}s`);
  /* T043: `info` aceitava `alvo` e ignorava — agora filtra as linhas (IP, interface, gateway
     ou DNS que contenham o valor). Sem casar nada, 422 em vez de devolver tudo como resposta. */
  let resumo = txt.slice(0, 20000);
  if (acao === "info" && alvo) {
    const filtradas = resumo.split("\n").filter((l) => l.toLowerCase().includes(alvo.toLowerCase()));
    if (!filtradas.length) throw new HttpError(422, `rede info: nenhuma interface/rota/DNS casa com '${alvo}'`);
    resumo = filtradas.join("\n");
  }
  return { ok: true, host: ctx.host, acao, alvo: alvo || null, resumo };
}

async function esperarArquivo(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const pasta = S(args.pasta);
  const padrao = S(args.padrao) || "*";
  const t = Math.max(1, Math.min(900, Number(args.timeout ?? 60) || 60));
  if (!pasta) throw new HttpError(422, "pasta obrigatória");
  let cmd: string;
  if (ctx.so === "windows") {
    cmd = psOut(
      "$fim = (Get-Date).AddSeconds(" + t + ")\n$f = $null\n" +
      "while ((Get-Date) -lt $fim) {\n" +
      "  $f = Get-ChildItem -LiteralPath '" + pq(pasta) + "' -Filter '" + pq(padrao) + "' -File -Force -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1\n" +
      "  if ($f) { break }\n  Start-Sleep -Milliseconds 700\n}\n" +
      "if (-not $f) { throw 'TEMPO_ESGOTADO (" + t + "s) em " + pq(pasta) + "' }\n" +
      '$out = "ACHOU $($f.FullName)|$($f.Length) bytes|$($f.LastWriteTime)"\n',
    );
  } else {
    cmd = shCmd(
      `fim=$(( $(date +%s) + ${t} )); f=''\nwhile [ $(date +%s) -lt $fim ]; do\n  f=$(find ${sq(pasta)} -maxdepth 1 -type f -name ${sq(padrao)} 2>/dev/null | head -1)\n  [ -n "$f" ] && break; sleep 0.7\ndone\n[ -n "$f" ] || { echo TEMPO_ESGOTADO; exit 8; }\nls -l "$f"`,
    );
  }
  const res = await exec(ctx, cmd, t + 20);
  if (res.exit !== 0) throw new HttpError(502, `esperar_arquivo: ${(saida(ctx.so, res).slice(0, 120) || stderrLimpo(res))}`);
  return { ok: true, host: ctx.host, resumo: saida(ctx.so, res).slice(0, 2000) };
}

async function power(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const acao = S(args.acao);
  if (!["lock", "logout", "restart", "shutdown"].includes(acao))
    throw new HttpError(422, "acao deve ser lock, logout, restart ou shutdown");
  if (!args.confirmar) throw new HttpError(409, `power ${acao} exige confirmar=true — NADA foi feito nesta chamada`);
  let cmd: string;
  if (ctx.so === "windows") {
    const corpo = acao === "lock"
      ? "Start-Process -FilePath rundll32.exe -ArgumentList 'user32.dll,LockWorkStation'\n$out = 'TELA BLOQUEADA'\n"
      : `$out = 'EXECUTADO ${acao} — maquina sem autostart: fica offline ate alguem reabrir o cliente'\nshutdown ${acao === "logout" ? "/l" : acao === "restart" ? "/r /t 10" : "/s /t 10"}\n`;
    cmd = psEncoded("$ErrorActionPreference='Stop'\n" + corpo);
  } else {
    cmd = shCmd(({ lock: "loginctl lock-session", logout: "loginctl terminate-user $(whoami)", restart: "systemctl reboot || shutdown -r now", shutdown: "systemctl poweroff || shutdown -h now" } as Record<string, string>)[acao]);
  }
  const res = await exec(ctx, cmd, 30);
  if (res.exit !== 0) throw new HttpError(502, `power ${acao} falhou (exit=${res.exit}): ${stderrLimpo(res)}`);
  return { ok: true, host: ctx.host, acao, resumo: (saida(ctx.so, res) || "EXECUTADO").slice(0, 300) };
}

async function rodarLote(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const comandos = args.comandos;
  if (!Array.isArray(comandos) || comandos.length < 1 || comandos.length > 20)
    throw new HttpError(422, "comandos: lista de 1 a 20 strings");
  if (!comandos.every((c) => typeof c === "string" && c.trim()))
    throw new HttpError(422, "todo comando deve ser texto nao-vazio");
  /* T044: o teto de 4000 do `rodar` é medido no comando JÁ codificado (base64 de base64),
     que infla ~11x. Aqui o usuário paga o limite pelo texto que escreveu. */
  const charsTexto = (comandos as string[]).reduce((s, c) => s + c.length, 0);
  if (charsTexto > 4000)
    throw new HttpError(422, `lote grande demais: ${charsTexto} chars de texto (teto 4000 por lote)`);
  const lista = (comandos as string[]).map(psAutoencode);
  const env = validaEnv(args.env);
  let prefixo = "";
  const sessNome = S(args.sessao).trim();
  if (sessNome) {
    const pasta = sessoes.get(ctx.host)?.get(sessNome);
    if (!pasta) throw new HttpError(422, `sessao '${sessNome}' nao existe — abra com a tool sessao`);
    prefixo = ctx.so === "windows" ? `cd /d ${pasta} && ` : `cd ${sq(pasta)} && `;
  }
  let cmd: string;
  if (ctx.so === "windows") {
    let script = "$ErrorActionPreference='Continue'\n$out = @()\n$i = 0\n" + envPsLinhas(env);
    for (const c of lista) {
      script += "$i = $i + 1\n" + "$r = (cmd.exe /c '" + pq(prefixo + c) + "' 2>&1) | Out-String\n" +
        "$out += ('### ' + $i + ' exit=' + $LASTEXITCODE + [Environment]::NewLine + $r.TrimEnd())\n";
    }
    script += "$out += '### LOTE-FIM'\n$out = $out -join \"`n\"\n";
    cmd = psOut(script);
  } else {
    const envpre = envDentro(env);
    cmd = shCmd(
      lista.map((c, i) => `echo '### ${i + 1}'; ${envpre}${prefixo}bash -c ${sq(c)} 2>&1; echo "exit=$?"`).join("; ") + "; echo '### LOTE-FIM'",
    );
  }
  const res = await exec(ctx, cmd, Math.max(1, Math.min(900, Number(args.timeout ?? 120) || 120)), 60000);
  const txt = saida(ctx.so, res);
  if (res.exit !== 0) throw new HttpError(502, `rodar_lote falhou (exit=${res.exit}): ${(txt.slice(0, 120) || stderrLimpo(res).slice(0, 200))}`);
  return { ok: true, host: ctx.host, resumo: txt.slice(0, 60000) };
}

async function sessao(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const acao = S(args.acao);
  const nome = (S(args.nome) || "padrao").trim();
  if (!["abrir", "listar", "fechar"].includes(acao)) throw new HttpError(422, "acao deve ser abrir, listar ou fechar");
  if (!nomeSeguro(nome)) throw new HttpError(422, "nome deve ser alfanumerico simples (letras/digitos/._-, ate 40)");
  const secs = sessoes.get(ctx.host) ?? new Map<string, string>();
  sessoes.set(ctx.host, secs);
  if (acao === "listar")
    return { ok: true, host: ctx.host, sessoes: [...secs.entries()].map(([n, p]) => ({ nome: n, pasta: p })) };
  if (acao === "fechar") {
    if (!secs.has(nome)) throw new HttpError(422, `sessao '${nome}' nao existe no servidor`);
    secs.delete(nome);
    return { ok: true, resumo: `SESSAO FECHADA: ${nome}` };
  }
  const pasta = S(args.pasta).trim();
  if (!pasta) throw new HttpError(422, "abrir exige pasta (diretorio que ja existe na maquina)");
  const cmd = ctx.so === "windows"
    ? psOut(`$p = '${pq(pasta)}'\nif (-not (Test-Path -LiteralPath $p -PathType Container)) { throw ('pasta nao encontrada: ' + $p) }\ntry { $s = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($p).ShortPath } catch { $s = $p }\nif (-not (Test-Path -LiteralPath $s -PathType Container)) { $s = $p }\n$out = 'EXISTE|' + $s\n`)
    : shCmd(`[ -d ${sq(pasta)} ] && echo EXISTE || { echo NAO; exit 9; }`);
  const res = await exec(ctx, cmd, 30);
  if (res.exit !== 0) throw new HttpError(502, `pasta invalida: ${(saida(ctx.so, res).slice(0, 120) || stderrLimpo(res).slice(0, 160))}`);
  let pastaUsar = pasta;
  if (ctx.so === "windows") {
    pastaUsar = saida(ctx.so, res).split("|").slice(1).join("|").trim();
    if (pastaUsar.includes(" "))
      throw new HttpError(502, "sessao: o caminho tem espacos e a maquina nao expoe nome curto 8.3; abra a sessao numa pasta sem espacos");
  }
  secs.set(nome, pastaUsar);
  return { ok: true, host: ctx.host, sessao: nome, pasta, resumo: `SESSAO ABERTA — use rodar_comando/rodar_lote com sessao="${nome}"` };
}

async function gitRemoto(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const repo = S(args.repo);
  const acao = S(args.acao);
  if (!["status", "diff", "log", "branches", "add", "commit", "push", "checkout"].includes(acao))
    throw new HttpError(422, "acao invalida");
  if ((acao === "commit" || acao === "push" || acao === "checkout") && !args.confirmar)
    throw new HttpError(409, `git ${acao} exige confirmar=true (governanca) — nada foi feito`);
  if (!repo) throw new HttpError(422, "repo obrigatorio");
  const path = S(args.path).trim();
  const ref = S(args.ref).trim();
  const msg = S(args.mensagem);
  let ga: string[];
  if (acao === "status") ga = ["status", "--porcelain", "-b"];
  else if (acao === "diff") ga = ["diff", ...(path ? ["--", path] : [])];
  else if (acao === "log") ga = ["log", "--oneline", "-n", String(Math.max(1, Math.min(50, /^\d+$/.test(ref) ? Number(ref) : 15)))];
  else if (acao === "branches") ga = ["branch", "-a"];
  else if (acao === "add") {
    if (!path) throw new HttpError(422, "add exige path (caminho relativo no repo)");
    ga = ["add", "--", path];
  } else if (acao === "commit") {
    if (!msg.trim()) throw new HttpError(422, "commit exige mensagem");
    ga = ["commit", "-m", msg.slice(0, 500)];
  } else if (acao === "push") ga = ["push", ...(ref ? ["origin", ref] : [])];
  else {
    if (!ref) throw new HttpError(422, "checkout exige ref (branch)");
    ga = ["checkout", ref];
  }
  const base = ["-C", repo, ...ga];
  let cmd: string;
  if (ctx.so === "windows") {
    const arr = base.map((x) => `'${pq(x)}'`).join(",");
    cmd = psOut("[Console]::OutputEncoding=[Text.Encoding]::UTF8\n$gargs = @(" + arr + ")\n$oi = & git @gargs 2>&1\n$out = (($oi | Out-String).TrimEnd() + \"`nEXIT=$LASTEXITCODE\")\n");
  } else {
    cmd = shCmd(`{ git ${base.map(sq).join(" ")} 2>&1; echo "EXIT=$?"; } | tail -c 60000`);
  }
  const res = await exec(ctx, cmd, 60, 60000);
  /* T043: pasta que não é repositório virava 502 com o CLIXML cru do PowerShell na cara.
     É erro de uso, não de servidor: 422 curto, sem ruído. O PS sai != 0 por causa do
     NativeCommandError, então a detecção tem de vir ANTES do 502. */
  const brutoErro = semRuidoPs(`${saida(ctx.so, res)}\n${stderrLimpo(res, 800)}`);
  if (/not a git repository|not a git dir|n[ãa]o [ée] um reposit[óo]rio/i.test(brutoErro))
    throw new HttpError(422, `git_remoto: '${repo}' nao e repositorio git (nenhum .git encontrado) — nada foi executado`);
  /* v3.43: máquina SEM git instalado (DESKTOP-0NTAOUP) devolvia 502 com o CLIXML cru
     ("&amp; : O termo 'git' não é reconhecido"). É ambiente, não servidor: 422 curto. */
  if (/n[ãa]o [ée] reconhecid|not recognized|command not found/i.test(brutoErro))
    throw new HttpError(422, `git_remoto: git nao esta instalado nesta maquina — nada foi executado`);
  if (res.exit !== 0) throw new HttpError(502, `git_remoto falhou (exit=${res.exit}): ${brutoErro.slice(0, 200)}`);
  let txt = saida(ctx.so, res);
  let exitCode = -1;
  const i = txt.lastIndexOf("EXIT=");
  if (i >= 0) {
    exitCode = Number(txt.slice(i + 5).trim());
    txt = txt.slice(0, i).replace(/\s+$/, "");
  }
  /* T043: pasta que não é repositório virava 502 com o CLIXML cru do PowerShell na cara.
     É erro de uso, não de servidor: 422 curto, sem ruído. */
  if (exitCode !== 0 && /not a git repository|not a git dir|n[ãa]o [ée] um reposit[óo]rio/i.test(txt))
    throw new HttpError(422, `git_remoto: '${repo}' nao e repositorio git (nenhum .git encontrado) — nada foi executado`);
  return { ok: exitCode === 0, host: ctx.host, acao, exit: exitCode, saida: txt.slice(0, 60000) };
}


/* ------------------------------------------- arquivos que a MÁQUINA manda (v3.44)
   Antes só existia servidor -> máquina (`escrever_arquivo` + /maquina/u). Aqui é
   o sentido contrário, pelo canal binário: o cliente faz POST do arquivo e o
   servidor guarda como ANEXO (print, imagem, log) — sem base64 no WebSocket e
   sem o teto de resposta do túnel. */

/** tamanho + mtime do arquivo na máquina (o mtime entra no id determinístico) */
async function infoRemota(ctx: Ctx, caminho: string): Promise<{ tamanho: number; mtime: number }> {
  const cmd = ctx.so === "windows"
    ? psEncoded(
        `$f = Get-Item -LiteralPath '${pq(caminho)}' -ErrorAction Stop\n` +
          "if ($f.PSIsContainer) { exit 9 }\n" +
          'Write-Output ($f.Length.ToString() + " " + $f.LastWriteTimeUtc.Ticks.ToString())\n',
      )
    : shCmd(`[ -f ${sq(caminho)} ] || exit 9; printf '%s %s' "$(wc -c < ${sq(caminho)} | tr -dc 0-9)" "$(stat -c %Y ${sq(caminho)})"`);
  const res = await exec(ctx, cmd, 30, 300);
  const [tam, mt] = saida(ctx.so, res).trim().split(/\s+/);
  const tamanho = Number(tam);
  const mtime = Number(mt);
  if (res.exit !== 0 || !Number.isFinite(tamanho))
    throw new HttpError(422, `nao consegui ler '${caminho}' (existe? e arquivo?)`);
  return { tamanho, mtime: Number.isFinite(mtime) ? mtime : 0 };
}

async function tamanhoRemoto(ctx: Ctx, caminho: string): Promise<number> {
  return (await infoRemota(ctx, caminho)).tamanho;
}

/** pergunta ao servidor de onde continuar (0 = do começo) */
async function statusDoEnvio(ctx: Ctx, base: string, id: string, chave: string): Promise<number> {
  const url = `${base}/maquina/r/status?id=${id}&k=${encodeURIComponent(chave)}` +
    `&host=${encodeURIComponent(ctx.host)}&tenant=${encodeURIComponent(ctx.alvo)}`;
  const cmd = ctx.so === "windows"
    /* v3.49.2 — a URL tem & (id, k, host, tenant). Sem aspas o PowerShell lê o & como
       operador e o comando morre: o status voltava sempre 0 e o reenvio de um arquivo já
       completo batia em "offset fora de ordem". */
    ? psEncoded(`$r = curl.exe -sS --fail --max-time 60 '${pq(url)}'\nif ($LASTEXITCODE -ne 0) { exit 7 }\nWrite-Output $r\n`)
    : shCmd(`curl -sS --fail --max-time 60 ${sq(url)}`);
  const res = await exec(ctx, cmd, 90, 2000);
  if (res.exit !== 0) return 0; // servidor sem ficha: começa do zero
  try {
    const j = JSON.parse(saida(ctx.so, res)) as { bytes?: number };
    return Math.max(0, Number(j.bytes ?? 0) || 0);
  } catch {
    return 0;
  }
}

/** comando que envia UM bloco (32 MB) do arquivo, a partir de `off` */
function comandoDoBloco(ctx: Ctx, url: string, caminho: string, off: number, n: number): string {
  if (ctx.so === "windows") {
    /* v3.49.1 — no Windows PowerShell 5.1 o assembly System.Net.Http NÃO vem carregado,
       então `New-Object System.Net.Http.HttpClient` estourava com "não é possível localizar
       o tipo". Era o que derrubava capturar_tela, baixar_arquivo e copiar_arquivo em TODO
       Windows (o teste em Linux nunca passava por aqui). Carrega o assembly e, se ainda
       falhar, cai para o WebClient, que existe em qualquer .NET Framework. */
    const ps = [
      "$ErrorActionPreference='Stop'",
      `$fs=[System.IO.File]::OpenRead('${pq(caminho)}')`,
      `$fs.Position=${off}`,
      `$n=${n}`,
      "$buf=New-Object byte[] $n",
      "$lido=0",
      "while($lido -lt $n){ $r=$fs.Read($buf,$lido,$n-$lido); if($r -le 0){break}; $lido+=$r }",
      "$fs.Close()",
      "if($lido -le 0){ exit 8 }",
      "if($lido -lt $n){ $envio=New-Object byte[] $lido; [Array]::Copy($buf,$envio,$lido) } else { $envio=$buf }",
      `$alvo='${pq(url)}'`,
      "$txt=$null",
      "try {",
      "  Add-Type -AssemblyName System.Net.Http -ErrorAction Stop",
      "  $hc=New-Object System.Net.Http.HttpClient",
      "  $hc.Timeout=[TimeSpan]::FromMinutes(30)",
      "  $cont=New-Object System.Net.Http.ByteArrayContent(,$envio)",
      "  $cont.Headers.ContentType=[System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')",
      "  $res=$hc.PostAsync($alvo,$cont).Result",
      "  $txt=$res.Content.ReadAsStringAsync().Result",
      "  if(-not $res.IsSuccessStatusCode){ Write-Output $txt; exit 7 }",
      "} catch {",
      "  if($null -ne $txt){ Write-Output $txt; exit 7 }",
      "  $wc=New-Object System.Net.WebClient",
      "  $wc.Headers.Add('Content-Type','application/octet-stream')",
      "  $bytes=$wc.UploadData($alvo,'POST',$envio)",
      "  $txt=[Text.Encoding]::UTF8.GetString($bytes)",
      "}",
      "Write-Output $txt",
    ].join("\n");
    return psEncoded(ps);
  }
  /* GNU dd com skip_bytes/count_bytes: recorta exatamente o bloco, sem carregar o arquivo */
  return shCmd(
    `dd if=${sq(caminho)} bs=1M iflag=skip_bytes,count_bytes skip=${off} count=${n} 2>/dev/null | ` +
      `curl -sS --fail --max-time 1800 -X POST -H 'content-type: application/octet-stream' --data-binary @- ${sq(url)}`,
  );
}

/** envia o arquivo em BLOCOS; se cair, continua do byte onde parou */
async function enviarParaServidor(ctx: Ctx, caminho: string, nome: string, mime?: string): Promise<AnexoMeta> {
  const base = ctx.httpBase();
  if (!base) throw new HttpError(500, "maquina conectou sem Host de retorno — sem canal de envio");
  const { tamanho, mtime } = await infoRemota(ctx, caminho);
  if (tamanho === 0) throw new HttpError(422, "arquivo vazio — nada foi guardado");
  if (tamanho > MAX_ANEXO)
    throw new HttpError(422, `arquivo de ${tamanho} bytes passa do teto de ${Math.round(MAX_ANEXO / 1048576)} MB`);

  const id = idDoEnvio(ctx.alvo, ctx.host, caminho, tamanho, mtime);
  const chave = await chaveDoEnvio(ctx.alvo, ctx.host, id);
  const nomeFinal = nomeLimpoEnvio(nome);
  const tipo = String(mime ?? mimePorNome(nomeFinal)).slice(0, 120);

  let off = await statusDoEnvio(ctx, base, id, chave);
  const BLOCO = 32 * 1024 * 1024;
  let falhas = 0;
  while (off < tamanho) {
    const n = Math.min(BLOCO, tamanho - off);
    const url = `${base}/maquina/r?id=${id}&k=${encodeURIComponent(chave)}` +
      `&host=${encodeURIComponent(ctx.host)}&tenant=${encodeURIComponent(ctx.alvo)}` +
      `&offset=${off}&total=${tamanho}&nome=${encodeURIComponent(nomeFinal)}&mime=${encodeURIComponent(tipo)}`;
    const res = await exec(ctx, comandoDoBloco(ctx, url, caminho, off, n), 900, 4000);
    const txt = saida(ctx.so, res).trim();
    let novo = off;
    try {
      novo = Number((JSON.parse(txt) as { bytes?: number })?.bytes ?? 0) || off;
    } catch {
      novo = off;
    }
    if (res.exit === 0 && novo > off) {
      off = novo;
      falhas = 0;
      continue;
    }
    /* o bloco pode ter chegado PARCIAL (queda no meio): o servidor diz quanto tem */
    const parcial = await statusDoEnvio(ctx, base, id, chave);
    if (parcial > off) {
      off = parcial;
      falhas = 0;
      continue;
    }
    if (++falhas >= 3)
      throw new HttpError(
        502,
        `envio parou em ${off} de ${tamanho} bytes (${Math.round((off / tamanho) * 100)}%) — ` +
          `chame de novo que ele RETOMA daqui: ${stderrLimpo(res, 180) || txt.slice(0, 160)}`,
      );
  }

  return {
    id, nome: nomeFinal, mime: tipo, bytes: tamanho, host: ctx.host, completo: true,
  };
}

/** nome de exibição (só o nome, nunca caminho) */
function nomeLimpoEnvio(n: string): string {
  const base = String(n ?? "").replace(/\\/g, "/").split("/").pop() ?? "arquivo";
  return (base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").trim() || "arquivo").slice(0, 180);
}

async function capturarTela(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const tela = args.tela === undefined ? 1 : Math.max(1, Math.min(4, Number(args.tela) || 1));
  if (ctx.so === "windows") {
    const tmp = `Join-Path $env:TEMP ('nexos_tela_' + [guid]::NewGuid().ToString('N') + '.jpg')`;
    const pegar = tela === 1
      ? "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n"
      : `$ss=[System.Windows.Forms.Screen]::AllScreens\nif (${tela} -gt $ss.Count) { throw 'so existem ' + $ss.Count + ' telas' }\n$b=$ss[${tela} - 1].Bounds\n`;
    const cmd = psEncoded(
      "$ErrorActionPreference='Stop'\n" +
        "Add-Type -AssemblyName System.Windows.Forms\n" +
        "Add-Type -AssemblyName System.Drawing\n" +
        pegar +
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height\n" +
        "$g = [System.Drawing.Graphics]::FromImage($bmp)\n" +
        "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)\n" +
        `$p = ${tmp}\n` +
        "$bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Jpeg)\n" +
        "$g.Dispose(); $bmp.Dispose()\n" +
        "Write-Output $p\n",
    );
    const res = await exec(ctx, cmd, 60, 2000);
    const caminho = saida(ctx.so, res).split("\n").pop()?.trim() ?? "";
    if (res.exit !== 0 || !caminho) throw new HttpError(422, `nao consegui capturar a tela: ${stderrLimpo(res, 160)}`);
    const nome = `tela-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
    const meta = await enviarParaServidor(ctx, caminho, nome, "image/jpeg");
    await exec(ctx, psEncoded(`Remove-Item -LiteralPath '${pq(caminho)}' -Force -ErrorAction SilentlyContinue`), 20, 200);
    return { ok: true, host: ctx.host, tela, anexo: meta, resumo: `TELA CAPTURADA (${Math.round(meta.bytes / 1024)} KB) — a imagem vai na conversa` };
  }
  /* Linux: precisa de X/Wayland com sessão gráfica */
  const tmp = `/tmp/nexos_tela_${Date.now()}.jpg`;
  const cmd = shCmd(
    `if command -v import >/dev/null 2>&1; then import -window root -quality 80 ${sq(tmp)}; ` +
      `elif command -v gnome-screenshot >/dev/null 2>&1; then gnome-screenshot -f ${sq(tmp)}; ` +
      `elif command -v scrot >/dev/null 2>&1; then scrot -o ${sq(tmp)}; ` +
      `else echo SEM_CAPTURA >&2; exit 3; fi; [ -s ${sq(tmp)} ] || exit 4; echo ok`,
  );
  const res = await exec(ctx, cmd, 60, 2000);
  if (res.exit !== 0) {
    throw new HttpError(422, `capturar tela falhou (exit=${res.exit}): precisa de sessao grafica (import/gnome-screenshot/scrot). ${stderrLimpo(res, 140)}`);
  }
  const meta = await enviarParaServidor(ctx, tmp, `tela-${Date.now()}.jpg`, "image/jpeg");
  await exec(ctx, shCmd(`rm -f ${sq(tmp)}`), 15, 200);
  return { ok: true, host: ctx.host, tela, anexo: meta, resumo: `TELA CAPTURADA (${Math.round(meta.bytes / 1024)} KB) — a imagem vai na conversa` };
}

async function baixarArquivo(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const caminho = S(args.caminho);
  if (!caminho) throw new HttpError(422, "caminho obrigatorio");
  const bytes = await tamanhoRemoto(ctx, caminho);
  if (bytes > MAX_ANEXO) throw new HttpError(422, `arquivo de ${bytes} bytes passa do teto de ${MAX_ANEXO / 1048576} MB — use a LAN entre as maquinas`);
  const nome = S(args.nome) || caminho.replace(/\\/g, "/").split("/").pop() || "arquivo";
  const meta = await enviarParaServidor(ctx, caminho, nome, S(args.mime) || undefined);
  return {
    ok: true, host: ctx.host, caminho, nome: meta.nome, bytes: meta.bytes, mime: meta.mime,
    anexo: meta, resumo: `ARQUIVO ENVIADO: ${meta.nome} (${Math.round(meta.bytes / 1024)} KB)`,
  };
}

/** v3.46: manda para UMA máquina um arquivo que já está no servidor (anexo da
 *  conversa, enviado pelo navegador ou pela própria máquina). O destino baixa por
 *  stream, com retomada (`curl -C -`) e confere o sha256 no fim. */
async function enviarParaMaquina(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const anexoId = S(args.anexo_id);
  const hostDestino = S(args.host);
  if (!anexoId || !hostDestino) throw new HttpError(422, "anexo_id e host sao obrigatorios");
  const ficha = await abrirAnexo(anexoId, ctx.u);
  const conferir = args.conferir === undefined ? true : Boolean(args.conferir);
  const destino = S(args.destino) || "";
  const soDestino = await soDaMaquina(ctx.alvo, hostDestino);
  const nomeSeguro = ficha.nome.replace(/['"`$\\]/g, "_");
  const alvoDestino =
    destino ||
    (soDestino === "windows" ? `%USERPROFILE%\\Downloads\\${nomeSeguro}` : `~/Downloads/${nomeSeguro}`);
  /* O pedaço que vai para o shell tem QUOTE próprio: caminho com espaço não quebra,
     e o caminho padrão usa a pasta do usuário da máquina (ExpandEnvironment / $HOME). */
  /* v3.49.2 — pq() só duplica aspas simples; sem as aspas de fora o PS lia o caminho como
     nome de comando ("O termo 'C:\...' não é reconhecido como nome de cmdlet"). */
  const caminhoWin = destino
    ? `'${pq(destino)}'`
    : `(Join-Path (Join-Path $env:USERPROFILE 'Downloads') '${pq(nomeSeguro)}')`;
  const caminhoUnix = destino ? sq(destino) : `"$HOME/Downloads/${nomeSeguro}"`;

  const chave = criarUploadDeArquivo(ficha.caminho, ficha.nome, ficha.bytes, hostDestino);
  const base = ctx.httpBase();
  if (!base) throw new HttpError(500, "maquina conectou sem Host de retorno — sem canal de envio");
  const url = `${base}/maquina/u?k=${chave}&host=${encodeURIComponent(hostDestino)}`;

  const hashServidor = conferir ? await sha256DeArquivo(ficha.caminho) : "";
  let cmd: string;
  if (soDestino === "windows") {
    cmd = psEncoded(
      "$ErrorActionPreference='Stop'\n" +
        `$destino = ${caminhoWin}\n` +
        "$pai = Split-Path -Parent $destino\n" +
        "if ($pai -and -not (Test-Path -LiteralPath $pai)) { New-Item -ItemType Directory -Force -Path $pai | Out-Null }\n" +
        `curl.exe -sS --fail --retry 3 -C - -o $destino '${pq(url)}'\n` +
        "if ($LASTEXITCODE -ne 0) { exit 7 }\n" +
        "Write-Output ((Get-Item -LiteralPath $destino).Length)\n" +
        (conferir ? "Write-Output ((Get-FileHash -LiteralPath $destino -Algorithm SHA256).Hash.ToLower())\n" : ""),
    );
  } else {
    cmd = shCmd(
      `mkdir -p "$(dirname ${caminhoUnix})" && curl -sS --fail --retry 3 -C - -o ${caminhoUnix} ${sq(url)}` +
        ` && wc -c < ${caminhoUnix} | tr -dc 0-9` +
        (conferir ? ` && echo && sha256sum ${caminhoUnix} | cut -d' ' -f1` : ""),
    );
  }

  const res = await rodar(ctx.u, ctx.alvo, hostDestino, cmd, 1800, `${ctx.origem}:enviar_para_maquina`, 4000, false);
  if (res.exit !== 0) throw new HttpError(502, `envio falhou no destino (exit=${res.exit}): ${stderrLimpo(res, 200)}`);
  const linhas = String(res.stdout ?? "").trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bytesDestino = Number(linhas[0] ?? 0);
  const hashDestino = (linhas[1] ?? "").toLowerCase();
  if (bytesDestino !== ficha.bytes)
    throw new HttpError(502, `tamanho no destino (${bytesDestino}) difere do anexo (${ficha.bytes})`);
  if (conferir && hashDestino && hashDestino !== hashServidor)
    throw new HttpError(502, `sha256 no destino nao confere (${hashDestino.slice(0, 12)}… != ${hashServidor.slice(0, 12)}…)`);
  return {
    ok: true, anexo_id: anexoId, host: hostDestino, destino: alvoDestino, bytes: ficha.bytes,
    sha256: hashServidor || undefined, conferido: Boolean(conferir),
    resumo: `ENVIADO: ${ficha.nome} (${Math.round(ficha.bytes / 1024)} KB) -> ${hostDestino}:${alvoDestino}`,
  };
}

async function copiarArquivo(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const origem = S(args.origem);
  const hostDestino = S(args.host_destino);
  const destino = S(args.destino) || origem;
  if (!origem || !hostDestino || !destino) throw new HttpError(422, "origem, host_destino e destino sao obrigatorios");
  const bytes = await tamanhoRemoto(ctx, origem);
  /* v3.45: o canal agora entrega em blocos, então o teto é o mesmo do anexo */
  if (bytes > MAX_ANEXO) throw new HttpError(422, `arquivo de ${bytes} bytes passa do teto de ${Math.round(MAX_ANEXO / 1048576)} MB`);
  const meta = await enviarParaServidor(ctx, origem, origem.replace(/\\/g, "/").split("/").pop() || "arquivo");
  /* v3.45: manda o ARQUIVO NO DISCO (o destino baixa por stream) — antes a cópia
     exigia o conteúdo inteiro em memória, o que matava arquivo de GB */
  const ficha = await abrirAnexo(meta.id, ctx.u);
  const chave = criarUploadDeArquivo(ficha.caminho, ficha.nome, ficha.bytes, hostDestino);
  const base = ctx.httpBase();
  if (!base) throw new HttpError(500, "maquina conectou sem Host de retorno — sem canal de envio");
  const url = `${base}/maquina/u?k=${chave}&host=${encodeURIComponent(hostDestino)}`;
  const soDestino = await soDaMaquina(ctx.alvo, hostDestino);
  let cmd: string;
  if (soDestino === "windows") {
    cmd = psEncoded(
      "$ErrorActionPreference='Stop'\n" +
        `$pai = Split-Path -Parent '${pq(destino)}'\n` +
        "if ($pai -and -not (Test-Path -LiteralPath $pai)) { New-Item -ItemType Directory -Force -Path $pai | Out-Null }\n" +
        `curl.exe -sS --fail --retry 2 -o '${pq(destino)}' '${pq(url)}'\n` +
        "if ($LASTEXITCODE -ne 0) { exit 7 }\n" +
        `Write-Output ((Get-Item -LiteralPath '${pq(destino)}').Length)\n`,
    );
  } else {
    cmd = shCmd(`mkdir -p $(dirname ${sq(destino)}) && curl -sS --fail --retry 2 -o ${sq(destino)} ${sq(url)} && wc -c < ${sq(destino)} | tr -dc 0-9`);
  }
  const res = await rodar(ctx.u, ctx.alvo, hostDestino, cmd, 180, `${ctx.origem}:copiar_arquivo`, 2000, false);
  if (res.exit !== 0) throw new HttpError(502, `copia falhou no destino (exit=${res.exit}): ${stderrLimpo(res, 180)}`);
  return {
    ok: true, host: ctx.host, origem, destino_host: hostDestino, destino,
    bytes, resumo: `COPIADO: ${origem} -> ${hostDestino}:${destino} (${Math.round(bytes / 1024)} KB)`,
  };
}

/** sha256 lido do disco em streaming (não carrega o arquivo na memória) */
async function sha256DeArquivo(caminho: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  await new Promise<void>((ok, falha) => {
    createReadStream(caminho).on("data", (c) => h.update(c)).on("end", () => ok()).on("error", falha);
  });
  return h.digest("hex");
}

/* ------------------------------------------------------------------ dispatch */

export const NOMES_MAQUINA_TOOLS = [
  "listar_arquivos", "ler_arquivo", "escrever_arquivo", "buscar_arquivos", "grep_remoto",
  "editar_no_local", "estado_maquina", "processos", "janelas", "area_transferencia",
  "falar", "abrir", "servicos", "eventos", "rede", "esperar_arquivo", "power",
  "rodar_lote", "sessao", "git_remoto", "metricas",
  "capturar_tela", "baixar_arquivo", "copiar_arquivo", "enviar_para_maquina",
] as const;

type Fn = (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>;
const TABELA: Record<string, Fn> = {
  listar_arquivos: listarArquivos, ler_arquivo: lerArquivo, escrever_arquivo: escreverArquivo,
  buscar_arquivos: buscarArquivos, grep_remoto: grepRemoto, editar_no_local: editarNoLocal,
  estado_maquina: (ctx) => estadoMaquina(ctx), processos: processos, janelas: janelas,
  area_transferencia: areaTransferencia, falar, abrir, servicos, eventos, rede,
  esperar_arquivo: esperarArquivo, power, rodar_lote: rodarLote, sessao, git_remoto: gitRemoto,
  metricas: (ctx) => metricas(ctx),
  capturar_tela: capturarTela, baixar_arquivo: baixarArquivo, copiar_arquivo: copiarArquivo,
  enviar_para_maquina: enviarParaMaquina,
};

/** plataforma: ao vivo (hub) > gravada (DB) > windows (nunca chutar sh num PC) */
/**
 * v3.37 (T042) — o cliente anuncia `process.platform + " " + os.release()` = "win32 10.0.26200",
 * e todas as 20 ferramentas decidem o ramo com `ctx.so === "windows"`. Sem normalizar, TODO PC
 * caía no ramo Unix: `ifconfig` no Windows, `janelas` devolvia 422 e `listar_arquivos` voltava
 * vazio com ok:true. Normaliza em UM lugar; o valor cru de `maquinas.so` continua para exibição.
 */
export function plataforma(so: string): string {
  const s = String(so ?? "").trim().toLowerCase();
  if (!s) return "windows";
  if (s.startsWith("win")) return "windows";
  if (s.startsWith("linux")) return "linux";
  if (s.startsWith("darwin") || s.startsWith("mac") || s.includes("mac os")) return "macos";
  return s.split(" ")[0];
}

async function soDaMaquina(alvo: string, host: string): Promise<string> {
  const vivo = soConectado(alvo, host);
  if (vivo) return plataforma(vivo);
  const r = await q<{ so: string }>(`SELECT so FROM maquinas WHERE tenant = $1 AND host = $2`, [alvo, host]);
  return plataforma(r.rows[0]?.so || "windows");
}

export async function toolMaquina(
  u: Usuario,
  nome: string,
  args: Record<string, unknown>,
  origem: string,
): Promise<unknown> {
  const fn = TABELA[nome];
  if (!fn) throw new HttpError(404, `tool de maquina desconhecida: ${nome}`);
  const host = S(args.host);
  if (!host) throw new HttpError(422, "host obrigatório (veja maquinas_online)");
  const alvo = alvoMaquina(u); // v3.79: sempre a própria conta
  const ctx: Ctx = {
    u, alvo, host, so: await soDaMaquina(alvo, host), origem, tool: nome,
    httpBase: () => httpBaseDaMaquina(alvo, host),
  };
  return fn(ctx, args);
}

/** rodar_comando com sessao/env (portado do túnel): cd + variáveis só nesta chamada */
export async function wrapComando(
  u: Usuario, args: Record<string, unknown>, cmdBruto: string,
): Promise<string> {
  /* T044: aqui o limite é o texto do usuário; o envelope (sessão/env/base64) é nosso. */
  if (cmdBruto.length > 4000)
    throw new HttpError(422, `comando grande demais: ${cmdBruto.length} chars de texto (teto 4000)`);
  const host = S(args.host);
  const sessNome = S(args.sessao).trim();
  const env = validaEnv(args.env);
  let cmd = psAutoencode(cmdBruto);
  if (!sessNome && Object.keys(env).length === 0) return cmd;
  const alvo = alvoMaquina(u); // v3.79: sempre a própria conta
  const so = await soDaMaquina(alvo, host);
  if (sessNome) {
    const pasta = sessoes.get(host)?.get(sessNome);
    if (!pasta) throw new HttpError(422, `sessao '${sessNome}' não existe — abra com a tool sessao`);
    cmd = so === "windows" ? `cd /d ${pasta} && (${cmd})` : `cd ${sq(pasta)} && ${cmd}`;
  }
  if (Object.keys(env).length)
    cmd = so === "windows" ? psEncoded(envPsLinhas(env) + `cmd.exe /c '${pq(cmd)}'\n`) : envDentro(env) + cmd;
  return cmd;
}
