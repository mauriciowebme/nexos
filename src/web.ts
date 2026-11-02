/** Busca e leitura na web para o chat (v3.32).
 *
 * Sem chave de API: o buscador é a página pública do Brave (a única que respondeu
 * da VPS sem captcha — DDG devolve 202 anti-bot, Mojeek captcha, Bing sem resultados
 * no HTML). Se o Brave falhar, cai para os RSS de notícia (Bing/Google), que servem
 * para fatos recentes mas não para consulta geral — o resultado diz de onde veio.
 *
 * Leitura de página (web_open) é livre: baixa o HTML e devolve texto limpo, com
 * trava contra endereço interno (SSRF).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { renderizar } from "./navegador";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT = 15000;
const MAX_TEXTO = 12000;

export type ResultadoWeb = { titulo: string; url: string; resumo: string };

function limparEspacos(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function entidades(s: string) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&hellip;/gi, "…")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

/** HTML → texto: tira o que não se lê e mantém quebras de bloco. */
export function htmlParaTexto(html: string) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = entidades(s);
  return s
    .split("\n")
    .map((l) => limparEspacos(l))
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* O Brave recusa (429) o TLS do Node — fetch, node:https e http/2 todos levam 429 com
 * o MESMO user-agent que o curl; a diferença é o handshake. Então quem baixa é o curl
 * (presente na imagem), com o fetch do Node só como reserva. */
const ACEITA = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

async function viaCurl(url: string, aceita: string, limite: number) {
  const { execFile } = await import("node:child_process");
  const args = [
    "-sS", "-L", "--max-time", String(Math.round(TIMEOUT / 1000)),
    "--max-filesize", String(limite),
    "-A", UA,
    "-H", "Accept-Language: pt-BR,pt;q=0.9,en;q=0.7",
    "-H", `Accept: ${aceita}`,
    "-o", "-",
    "-w", "\n%{http_code}",
    url,
  ];
  const saida = await new Promise<{ erro?: Error; saida?: string }>((res) => {
    execFile("curl", args, { maxBuffer: limite + 4096 }, (erro, stdout) => res({ erro: erro ?? undefined, saida: stdout }));
  });
  if (saida.erro) throw new Error(`curl: ${saida.erro.message.split("\n")[0]}`);
  const bruto = saida.saida ?? "";
  const corte = bruto.lastIndexOf("\n");
  const status = Number(bruto.slice(corte + 1).trim());
  return { status, corpo: bruto.slice(0, corte) };
}

async function baixar(url: string, aceita = ACEITA, limite = 8 * 1024 * 1024) {
  try {
    const { status, corpo } = await viaCurl(url, aceita, limite);
    if (status > 0) return { status, texto: corpo, ct: "", bytes: Buffer.byteLength(corpo) };
  } catch {
    /* sem curl: cai para o fetch */
  }
  const r = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7", Accept: aceita },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") ?? "";
  const m = /charset=([\w-]+)/i.exec(ct);
  let texto = "";
  try {
    texto = new TextDecoder(m?.[1] ?? "utf-8").decode(buf);
  } catch {
    texto = new TextDecoder("utf-8").decode(buf);
  }
  return { status: r.status, texto, ct, bytes: buf.length };
}

/** Brave: cada resultado é um <div class="snippet" data-type="web">. */
export function lerBrave(html: string, k: number): ResultadoWeb[] {
  const out: ResultadoWeb[] = [];
  const blocos = html.split('data-type="web"').slice(1);
  for (const b of blocos) {
    const corte = b.indexOf('<div class="snippet');
    const bloco = (corte > 0 ? b.slice(0, corte) : b).replace(/<!--[\s\S]*?-->/g, " ");
    const href = /href="(https?:\/\/[^"]+)"/i.exec(bloco);
    if (!href) continue;
    const url = entidades(href[1]);
    if (/^https?:\/\/(www\.)?search\.brave\.com/i.test(url)) continue;
    let titulo = "";
    const tAttr = /class="title[^"]*"[^>]*title="([^"]*)"/i.exec(bloco);
    if (tAttr) titulo = entidades(tAttr[1]);
    if (!titulo) {
      const tDiv = /class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(bloco);
      if (tDiv) titulo = entidades(tDiv[1].replace(/<[^>]+>/g, " "));
    }
    let resumo = "";
    const d = /class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(bloco);
    if (d) resumo = htmlParaTexto(d[1]).replace(/\n+/g, " ");
    titulo = limparEspacos(titulo);
    if (!url || !titulo) continue;
    out.push({ titulo, url, resumo: limparEspacos(resumo).slice(0, 400) });
    if (out.length >= k) break;
  }
  return out;
}

/** RSS (Bing News / Google News): <item><title><link><description>. */
export function lerRss(xml: string, k: number): ResultadoWeb[] {
  const out: ResultadoWeb[] = [];
  const itens = xml.split(/<item[\s>]/i).slice(1);
  for (const it of itens) {
    const t = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(it);
    const l = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(it);
    const d = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i.exec(it);
    if (!t || !l) continue;
    const url = entidades(limparEspacos(l[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      titulo: limparEspacos(entidades(t[1])),
      url: urlDoItem(url),
      resumo: limparEspacos(htmlParaTexto(antidadeRss(d?.[1] ?? ""))).slice(0, 400),
    });
    if (out.length >= k) break;
  }
  return out;
}

/** Bing News embrulha o link num redirecionador com a URL real no parâmetro url=. */
function urlDoItem(url: string) {
  if (/bing\.com\/news\/apiclick/i.test(url)) {
    const m = /[?&]url=([^&]+)/i.exec(url);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return url;
      }
    }
  }
  return url;
}

/** RSS às vezes vem com HTML escapado (&lt;p&gt;) — desescapa antes de limpar. */
function antidadeRss(s: string) {
  return s.replace(/&lt;([\s\S]*?)&gt;/g, "<$1>");
}

function limparQuery(q: string) {
  const t = q.replace(/\s+/g, " ").trim();
  if (!t) throw new Error("parametros invalidos: campo obrigatorio: query");
  return t.slice(0, 300);
}

export async function buscarWeb(args: {
  query: string;
  k?: number;
  site?: string;
}): Promise<{ query: string; fonte: string; resultados: ResultadoWeb[] }> {
  const base = limparQuery(args.query);
  const k = Math.min(Math.max(Number(args.k) || 5, 1), 10);
  const site = (args.site ?? "").trim();
  const q = site ? `${base} site:${site}` : base;
  const falhas: string[] = [];

  try {
    const r = await baixar(`https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`);
    if (r.status === 200) {
      const achados = lerBrave(r.texto, k);
      if (achados.length) return { query: base, fonte: "brave", resultados: achados };
      falhas.push(`brave: página sem resultados (${r.bytes} bytes)`);
    } else falhas.push(`brave: http ${r.status}`);
  } catch (e) {
    falhas.push(`brave: ${(e as Error).message}`);
  }

  for (const [nome, url] of [
    ["bing-news", `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=RSS`],
    [
      "google-news",
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`,
    ],
  ] as const) {
    try {
      const r = await baixar(url, "application/rss+xml,application/xml;q=0.9,*/*;q=0.8");
      if (r.status === 200) {
        const achados = lerRss(r.texto, k);
        if (achados.length) return { query: base, fonte: nome, resultados: achados };
        falhas.push(`${nome}: sem itens`);
      } else falhas.push(`${nome}: http ${r.status}`);
    } catch (e) {
      falhas.push(`${nome}: ${(e as Error).message}`);
    }
  }

  throw new Error(`busca indisponivel agora (${falhas.join(" | ")}). Tente de novo em instantes ou use web_open com uma URL conhecida.`);
}

const BLOQUEADOS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadados?\./i,
  /^169\.254\./,
  /^10\./,
  /^127\./,
  /^0\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?fc00:/i,
  /^\[?fe80:/i,
];

export function enderecoInterno(ip: string) {
  return BLOQUEADOS.some((re) => re.test(ip)) || BLOQUEADOS.some((re) => re.test(ip.replace(/^\[|\]$/g, "")));
}

/** Normaliza e valida uma URL de saída: so http(s), nunca endereco interno (SSRF).
 *  Vale para web_open e para qualquer download (imagem do OCR, por exemplo). */
export async function validarUrlPublica(urlBruta: string): Promise<URL> {
  const cru = (urlBruta ?? "").trim();
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(cru) ? cru : `https://${cru}`);
  } catch {
    throw new Error("endereço invalido: use http:// ou https://");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("so http e https");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (enderecoInterno(host)) throw new Error("endereco interno nao permitido");
  if (!isIP(host)) {
    try {
      const { address } = await lookup(host, { verbatim: true });
      if (enderecoInterno(address)) throw new Error("endereco interno nao permitido");
    } catch (e) {
      if ((e as Error).message.includes("interno")) throw e;
      throw new Error(`nao consegui resolver ${host}`);
    }
  }
  return u;
}

/** Baixa uma imagem de URL publica com o mesmo user-agent do navegador (sites exigentes,
 *  como o Wikimedia, devolvem 400 para o UA padrao do Node). Bloqueia endereco interno e
 *  valida cada salto de redirecionamento — sem isso um 302 para 127.0.0.1 furaria o SSRF. */
export async function baixarImagem(
  urlBruta: string,
  limite = 8 * 1024 * 1024,
): Promise<{ buffer: Buffer; tipo: string }> {
  let atual = await validarUrlPublica(urlBruta);
  for (let salto = 0; salto < 4; salto++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const r = await fetch(atual.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": UA,
          Accept: "image/*,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
        },
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) throw new Error(`a imagem respondeu ${r.status} sem destino`);
        atual = await validarUrlPublica(new URL(loc, atual).toString());
        continue;
      }
      if (!r.ok) throw new Error(`a imagem respondeu ${r.status}`);
      const tipo = (r.headers.get("content-type") ?? "").toLowerCase();
      if (!tipo.startsWith("image/")) throw new Error(`a URL nao devolveu imagem (${tipo || "sem content-type"})`);
      const buffer = Buffer.from(await r.arrayBuffer());
      if (buffer.length > limite)
        throw new Error(`imagem de ${(buffer.length / 1024 / 1024).toFixed(1)}MB passa do teto de ${limite / 1024 / 1024}MB`);
      return { buffer, tipo };
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error("a imagem redirecionou vezes demais");
}

/** web_open: baixa a página e devolve texto limpo. Bloqueia endereço interno. */
const POUCO_TEXTO = 250;

/* v3.67 — a mensagem de erro diz o que o servidor respondeu de verdade.
 * Antes, TODO status >= 400 virava "a pagina bloqueou o acesso", então uma URL de API
 * errada (http 400) fazia o modelo concluir que a fonte estava bloqueada e sair vagando
 * por outros sites. Medido no chat do admin em 02/11: BCB "bloqueado" com a URL errada. */
export function mensagemHttp(status: number): string {
  if (status === 400 || status === 404 || status === 410 || status === 422) {
    return `o endereco respondeu http ${status} — a URL parece errada ou o conteudo nao existe (isto NAO e bloqueio): confira o caminho da pagina/API e tente a URL correta`;
  }
  if (status === 401 || status === 403 || status === 429) {
    return `a pagina bloqueou o acesso (http ${status}) — nem o navegador passou; procure a informacao em outra fonte ou em outro endereco`;
  }
  if (status >= 500) {
    return `o site respondeu http ${status} (instabilidade do servidor deles) — tente de novo em instantes`;
  }
  return `a pagina respondeu http ${status}`;
}

/** status que não melhora com navegador: é endereço errado, não bloqueio de robô */
function urlErrada(status: number): boolean {
  return status === 400 || status === 404 || status === 410 || status === 422;
}

export async function abrirPagina(
  urlBruta: string,
  opcoes: { js?: boolean } = {},
): Promise<{
  url: string;
  titulo: string;
  texto: string;
  truncado: boolean;
  bytes: number;
  renderizado: boolean;
  ms: number;
}> {
  const t0 = Date.now();
  const u = await validarUrlPublica(urlBruta);

  const r = await baixar(u.toString());
  /* 403/429 no curl costuma ser bloqueio de robô, não conteúdo inexistente: o navegador
   * tem outra impressão digital e muitas vezes passa. Então o erro fica guardado e quem
   * decide é o resultado do chromium (quando disponível). */
  const bloqueado = r.status >= 400;
  if (bloqueado && process.env.NEXOS_NAVEGADOR === "0") throw new Error(mensagemHttp(r.status));
  const tipo = r.ct.toLowerCase();
  if (tipo && !/text\/|html|xml|json/.test(tipo)) {
    throw new Error(`conteudo nao textual (${tipo}) — web_open le paginas, nao arquivos`);
  }
  const tituloBruto = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(r.texto)?.[1] ?? "";
  const og = /property=["']og:title["'][^>]*content=["']([^"']{1,300})["']/i.exec(r.texto)?.[1] ?? "";
  const titulo = limparEspacos(entidades(og || tituloBruto));
  let texto = htmlParaTexto(r.texto);
  let renderizado = false;

  /* v3.33: site que monta o conteúdo por JS entrega HTML oco ao curl — muito markup e
   * pouco texto. Página pequena e simples (ex.: example.com, 577 bytes) NÃO paga o
   * navegador: só renderiza com js:true, ou quando o HTML tem corpo para uma SPA. */
  const sinalDeJs = /id=["'](root|app|__next)["']|__NEXT_DATA__|window\.__(NUXT|INITIAL_STATE)/i.test(r.texto);
  /* v3.67: 400/404 não é bloqueio — o navegador não vai transformar URL errada em conteúdo,
     e esperar por ele custava 30 s (medido: série inexistente do BCB pendurou o turno). */
  const valeRenderizar =
    (bloqueado && !urlErrada(r.status)) || opcoes.js === true || texto.length < POUCO_TEXTO || (texto.length < 900 && sinalDeJs);
  const htmlGordo = r.bytes > 3000;
  if (valeRenderizar && (htmlGordo || bloqueado) && process.env.NEXOS_NAVEGADOR !== "0") {
    try {
      const nav = await renderizar(u.toString());
      if (nav.texto.length > texto.length) {
        texto = nav.texto;
        renderizado = true;
      }
    } catch (e) {
      if (opcoes.js === true && !bloqueado) throw new Error(`nao consegui renderizar a pagina: ${(e as Error).message}`);
      if (bloqueado) throw new Error(`${mensagemHttp(r.status)} (o navegador tambem tentou e nao passou)`);
      /* sem navegador: devolve o que o curl trouxe, e o texto vazio fala por si */
    }
  }

  /* Bloqueio de robô não vira "página com 3 caracteres": quem lê precisa saber que falhou.
   * Medido: invest·ing e UOL devolvem 403/“Access Denied” para IP de datacenter em curl E
   * no chromium, por mais tempo que se espere. */
  if (bloqueado && texto.length < 200) {
    throw new Error(mensagemHttp(r.status));
  }

  const truncado = texto.length > MAX_TEXTO;
  return {
    url: u.toString(),
    titulo,
    texto: truncado ? texto.slice(0, MAX_TEXTO) + "\n[... cortado]" : texto,
    truncado,
    bytes: r.bytes,
    renderizado,
    ms: Date.now() - t0,
  };
}
