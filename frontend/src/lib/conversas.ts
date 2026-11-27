/** v3.81 — conversas no cliente: a lista lateral, abrir, criar, renomear e arquivar.
 *  A conversa é do servidor (id); a gaveta aqui é só o recorte de documentos. */
import { del, get, patch, post, qs } from "../services/api";

export type ConversaMeta = {
  id: number;
  titulo: string;
  memoria: string;
  arquivada: boolean;
  compactado_ate: number | null;
  criado_em: string;
  atualizado_em: string;
  mensagens: number;
  previa: string;
};

export type ListaConversas = { conversas: ConversaMeta[]; contagem: { ativas: number; arquivadas: number } };

export type MensagemServidor = {
  id: number;
  papel: "user" | "assistant" | string;
  texto: string;
  ferramentas?: unknown[];
  falas?: string[];
  raciocinio?: string;
  rastro?: unknown[];
  fontes?: unknown[];
  custo?: Record<string, unknown> | null;
  provedor?: string;
  modelo?: string;
  telas?: unknown[];
  anexos?: unknown[];
  quando: string;
};

export async function listarConversas(opts: {
  memoria?: string;
  busca?: string;
  arquivadas?: boolean;
  tenant?: string;
  limit?: number;
}): Promise<ListaConversas> {
  const q = qs({
    ...(opts.memoria ? { memoria: opts.memoria } : {}),
    ...(opts.busca ? { busca: opts.busca } : {}),
    ...(opts.arquivadas ? { arquivadas: "1" } : {}),
    ...(opts.tenant ? { tenant: opts.tenant } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
  return get<ListaConversas>(`/conversas${q ? "?" + q : ""}`);
}

export async function criarConversa(memoria: string, tenant?: string, titulo = ""): Promise<number> {
  const r = await post<{ id: number }>("/conversas", { memoria, titulo, ...(tenant ? { tenant } : {}) });
  return Number(r.id);
}

export async function abrirConversa(
  id: number,
  opts: { tenant?: string; limit?: number } = {},
): Promise<{ conversa: ConversaMeta; mensagens: MensagemServidor[] }> {
  const q = qs({ ...(opts.tenant ? { tenant: opts.tenant } : {}), ...(opts.limit ? { limit: opts.limit } : {}) });
  return get(`/conversas/${id}${q ? "?" + q : ""}`);
}

export async function renomearConversa(id: number, titulo: string, tenant?: string): Promise<void> {
  await patch(`/conversas/${id}${tenant ? "?" + qs({ tenant }) : ""}`, { titulo });
}

/** arquiva (não apaga): sai da lista e o histórico continua no banco */
export async function arquivarConversa(id: number, tenant?: string): Promise<void> {
  await del(`/conversas/${id}${tenant ? "?" + qs({ tenant }) : ""}`);
}