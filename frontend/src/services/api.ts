/* Camada única de HTTP: nenhum componente chama fetch direto. */

let chave = "";

export function definirChave(k: string): void {
  chave = k;
}

export class ApiErro extends Error {
  status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.status = status;
  }
}

export function qs(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function cabecalhos(comCorpo: boolean): Record<string, string> {
  const h: Record<string, string> = { Authorization: "B" + "earer " + chave };
  if (comCorpo) h["Content-Type"] = "application/json";
  return h;
}

export async function api<T>(caminho: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(caminho, { ...opts, headers: cabecalhos(opts.body !== undefined) });
  if (r.ok) {
    const ct = r.headers.get("content-type") || "";
    return (ct.includes("json") ? await r.json() : await r.text()) as T;
  }
  let detalhe = `${r.status} ${r.statusText}`;
  try {
    const j = (await r.json()) as { detail?: string };
    if (j.detail) detalhe = j.detail;
  } catch {
    /* corpo não-JSON */
  }
  throw new ApiErro(r.status, detalhe);
}

/** v3.8: roda uma ferramenta de máquina direto pela tela (JSON-RPC do MCP interno). */
export async function rodarAcao(nome: string, args: Record<string, unknown>): Promise<string> {
  const r = await api<{
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  }>(
    "/mcp",
    { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: nome, arguments: args } }) },
  );
  if (r.error) throw new ApiErro(500, r.error.message ?? "a ferramenta falhou");
  const texto = (r.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return texto || "(vazio)";
}

export function get<T>(caminho: string): Promise<T> {
  return api<T>(caminho);
}

export function post<T>(caminho: string, corpo?: unknown): Promise<T> {
  return api<T>(caminho, { method: "POST", body: JSON.stringify(corpo ?? {}) });
}

/** v3.46: arquivo grande do navegador — sobe em BLOCOS de 8 MB com retomada.
 *  O id fica preso ao arquivo (nome+tamanho+data) no localStorage: reenviar o
 *  mesmo arquivo depois de uma queda continua do byte onde o servidor parou. */
export type AnexoEnviado = { id: string; nome: string; bytes: number };

const BLOCO_UPLOAD = 8 * 1024 * 1024;

function idDoArquivo(f: File): { id: string; chaveLocal: string } {
  const chaveLocal = `nexos.anexo.${f.name}.${f.size}.${f.lastModified}`;
  const salvo = localStorage.getItem(chaveLocal);
  if (salvo && /^[A-Za-z0-9_-]{16,64}$/.test(salvo)) return { id: salvo, chaveLocal };
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  localStorage.setItem(chaveLocal, id);
  return { id, chaveLocal };
}

export async function subirAnexo(
  arquivo: File,
  onProgresso?: (feito: number, total: number) => void,
): Promise<AnexoEnviado> {
  const { id, chaveLocal } = idDoArquivo(arquivo);
  const total = arquivo.size;
  const nome = arquivo.name || "arquivo";
  let offset = 0;
  try {
    const st = await get<{ bytes: number; completo: boolean }>(`/anexos/enviar/status?${qs({ id })}`);
    if (st.bytes > 0 && st.bytes <= total) offset = st.bytes;
  } catch {
    /* sem status ainda: começa do zero */
  }
  onProgresso?.(offset, total);

  while (offset < total) {
    const fim = Math.min(offset + BLOCO_UPLOAD, total);
    const parte = arquivo.slice(offset, fim);
    let tentativas = 0;
    for (;;) {
      try {
        const r = await fetch(
          `/anexos/enviar?${qs({ id, offset, total, nome, mime: arquivo.type || "application/octet-stream" })}`,
          {
            method: "POST",
            headers: { Authorization: "B" + "earer " + chave, "Content-Type": "application/octet-stream" },
            body: parte,
          },
        );
        if (!r.ok) {
          let detalhe = `${r.status} ${r.statusText}`;
          try {
            const j = (await r.json()) as { detail?: string };
            if (j.detail) detalhe = j.detail;
          } catch {
            /* corpo não-JSON */
          }
          throw new ApiErro(r.status, detalhe);
        }
        const j = (await r.json()) as { bytes?: number };
        offset = Number(j.bytes ?? fim);
        onProgresso?.(offset, total);
        break;
      } catch (e) {
        if (++tentativas >= 3) throw e;
        /* antes de repetir, pergunta o que o servidor já tem — assim a retomada é
           do byte real, não do começo do bloco */
        try {
          const st = await get<{ bytes: number }>(`/anexos/enviar/status?${qs({ id })}`);
          if (st.bytes > offset) offset = st.bytes;
        } catch {
          /* mantém o offset conhecido */
        }
        await new Promise((ok) => setTimeout(ok, 800 * tentativas));
      }
    }
  }
  localStorage.removeItem(chaveLocal);
  return { id, nome, bytes: total };
}

/** POST que lê um fluxo de eventos (SSE) e chama `onEvento` para cada `data:`.
 *  Usado pelo chat com streaming; erros antes do fluxo chegam como ApiErro normal. */
export async function postStream(caminho: string, corpo: unknown, onEvento: (e: any) => void): Promise<void> {
  const r = await fetch(caminho, {
    method: "POST",
    headers: cabecalhos(true),
    body: JSON.stringify(corpo ?? {}),
  });
  await lerSse(r, onEvento);
}

/** GET que lê um fluxo de eventos (SSE) — v3.3: stream reanexável da tarefa.
 *  `EventSource` não serve: ele não manda o header Authorization.
 *
 *  v3.64 — vigia de silêncio: se o fluxo ficar 120 s sem entregar NADA (proxy engoliu a
 *  conexão, rede mudou de torre), aborta e devolve o controle para `bombearTarefa`, que
 *  consulta o status da tarefa e reata — em vez de a tela ficar "trabalhando" para sempre. */
export async function getStream(caminho: string, onEvento: (e: any) => void): Promise<void> {
  const ctl = new AbortController();
  let vigia: ReturnType<typeof setTimeout> | null = null;
  const armar = (): void => {
    if (vigia) clearTimeout(vigia);
    vigia = setTimeout(() => ctl.abort(), 120_000);
  };
  armar();
  try {
    const r = await fetch(caminho, { headers: cabecalhos(false), signal: ctl.signal });
    await lerSse(r, (e) => {
      armar();
      onEvento(e);
    });
  } finally {
    if (vigia) clearTimeout(vigia);
  }
}

/** miolo comum dos dois fluxos: valida, lê `data:` por bloco até o fim do turno.
 *
 *  v3.64 — o `fim` (ou `erro`) encerra a leitura na hora, com `cancel()`: antes a função só
 *  retornava quando o servidor FECHAVA a conexão, e atrás do proxy (Caddy) o fecho podia não
 *  chegar — a resposta aparecia na tela e o app continuava "trabalhando em segundo plano",
 *  com o botão de parar aceso, para sempre. */
async function lerSse(r: Response, onEvento: (e: any) => void): Promise<void> {
  if (!r.ok) {
    let detalhe = `${r.status} ${r.statusText}`;
    try {
      const j = (await r.json()) as { detail?: string };
      if (j.detail) detalhe = j.detail;
    } catch {
      /* corpo não-JSON */
    }
    throw new ApiErro(r.status, detalhe);
  }
  if (!r.body) throw new ApiErro(r.status, "o servidor respondeu sem corpo");
  const leitor = r.body.getReader();
  const dec = new TextDecoder();
  let sobra = "";
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    sobra += dec.decode(value, { stream: true });
    const blocos = sobra.split("\n\n");
    sobra = blocos.pop() ?? "";
    for (const bloco of blocos) {
      const linha = bloco.split("\n").find((l) => l.startsWith("data:"));
      if (!linha) continue;
      let evento: { tipo?: string } | null = null;
      try {
        evento = JSON.parse(linha.slice(5).trim());
      } catch {
        continue; /* comentário de manutenção (: ping) ou payload quebrado */
      }
      onEvento(evento);
      if (evento?.tipo === "fim" || evento?.tipo === "erro") {
        /* turno acabou: solta a conexão sem esperar o EOF do proxy */
        try {
          await leitor.cancel();
        } catch {
          /* já fechada */
        }
        return;
      }
    }
  }
}

export function patch<T>(caminho: string, corpo: unknown): Promise<T> {
  return api<T>(caminho, { method: "PATCH", body: JSON.stringify(corpo) });
}

export function put<T>(caminho: string, corpo: unknown): Promise<T> {
  return api<T>(caminho, { method: "PUT", body: JSON.stringify(corpo) });
}

export function del<T>(caminho: string): Promise<T> {
  return api<T>(caminho, { method: "DELETE" });
}

/** Upload multipart (arquivo + campos). O navegador monta o Content-Type com boundary. */
export async function enviar<T>(caminho: string, form: FormData): Promise<T> {
  const r = await fetch(caminho, { method: "POST", headers: cabecalhos(false), body: form });
  if (r.ok) {
    const ct = r.headers.get("content-type") || "";
    return (ct.includes("json") ? await r.json() : await r.text()) as T;
  }
  let detalhe = `${r.status} ${r.statusText}`;
  try {
    const j = (await r.json()) as { detail?: string };
    if (j.detail) detalhe = j.detail;
  } catch {
    /* corpo não-JSON */
  }
  throw new ApiErro(r.status, detalhe);
}

/** Blob URL de um recurso autenticado (imagem de anexo, por exemplo). */
export async function blobUrl(caminho: string): Promise<string> {
  const r = await fetch(caminho, { headers: cabecalhos(false) });
  if (!r.ok) throw new ApiErro(r.status, `${r.status} ${r.statusText}`);
  return URL.createObjectURL(await r.blob());
}

/** Download autenticado (o <a href> não manda o header). */
/* v3.10.1: download por LINK de verdade (bilhete de uso único). O fetch+blob fazia
 * o Edge/Chrome bloquear o segundo download da mesma página ("Precisa de
 * autorização para transferir"). Navegação comum o navegador sempre permite. */
export async function baixarPorLink(plataforma: "win" | "linux"): Promise<string> {
  const r = await post<{ url: string }>(`/maquinas/cliente/${plataforma}/bilhete`);
  window.location.assign(r.url);
  return r.url;
}

export async function baixar(caminho: string, nomeArquivo: string): Promise<void> {
  const r = await fetch(caminho, { headers: cabecalhos(false) });
  if (!r.ok) throw new Error(`download: HTTP ${r.status}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // o servidor batiza o arquivo com o dono (content-disposition); o nome local é só reserva
  const disp = /filename="?([^";]+)"?/i.exec(r.headers.get("content-disposition") || "");
  a.download = disp ? decodeURIComponent(disp[1]) : nomeArquivo;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
