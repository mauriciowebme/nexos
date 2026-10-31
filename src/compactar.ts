/** Compactação de contexto (v3.56) — mesma mecânica do mini-compress do Hermes.
 *
 *  Determinística, sem LLM, sem custo. Regras (idênticas ao mini-compress):
 *
 *  1. GATILHO — só compacta quando o payload atinge o que vier primeiro:
 *       `threshold_k` MILHARES de tokens (200 = 200k; 0 = nunca)
 *       OU 90% da janela do modelo (rede de segurança p/ janelas menores).
 *     Abaixo disso o histórico vai INTEIRO — nada de resumir "por precaução".
 *
 *  2. CASCATA C -> B -> A, cada parte com teto próprio. NADA SE PERDE: o que
 *     não couber numa parte desce para a anterior (vira candidato da análise
 *     seguinte):
 *       C = últimas `protect_last_n` mensagens verbatim, teto `tail_chars_cap`.
 *           Estourou? remove as mais VELHAS até caber — elas voltam para o B/A.
 *       B = até `max_pairs` pares pedido->conclusão dos mais recentes do que
 *           sobrou, teto `pairs_block_cap`. Estourou? descarta os pares mais
 *           ANTIGOS — os pedidos/conclusões voltam para o A.
 *       A = resumo determinístico do que sobrou (faixa mais antiga), teto
 *           `summary_chars_cap`.
 *
 *  3. AVISO DE RECUPERAÇÃO sempre no início da parte C, nunca truncado.
 *
 *  4. EMERGÊNCIA: se depois da cascata ainda não couber no orçamento, a cauda
 *     é apertada por dentro (cabeça+cauda) em vez de sumir — o gateway nunca
 *     recebe um payload acima da janela.
 *
 *  Saída sempre: [system] + [A?] + [B?] + AVISO + C + pergunta atual.
 */

export const CHARS_POR_TOKEN = 4;
/** rede de segurança do gatilho: compactar também a 90% da janela do modelo */
export const SAFETY_CONTEXT_PERCENT = 0.9;

/** estimativa de tokens de um texto (sem tokenizador: 4 caracteres por token) */
export function estimarTokens(texto: unknown): number {
  const t = typeof texto === "string" ? texto : texto === undefined || texto === null ? "" : JSON.stringify(texto);
  return Math.ceil(String(t).length / CHARS_POR_TOKEN);
}

/** quanto o payload inteiro custa: mensagens + as specs de ferramenta que vão junto */
export function custoDoPayload(mensagens: { content?: unknown }[], tools?: unknown): number {
  let n = 0;
  for (const m of mensagens) n += estimarTokens(m?.content ?? "") + 4; /* +4: papel/estrutura */
  if (tools) n += estimarTokens(tools) + 32;
  return n;
}

export type MsgChat = { role: "system" | "user" | "assistant" | "tool"; content: string; [k: string]: unknown };

/* Marcadores no padrão do mini-compress — um bloco compactado é reconhecido por
   eles e IGNORADO na análise (não vira pedido nem par). */
export const SUMMARY_MARKER = "[CONTEXT COMPACTION — REFERENCE ONLY] (mini-compress, resumo determinístico)";
export const SUMMARY_FOOTER = "[FIM DO RESUMO — fim do contexto compactado]";
export const PAIRS_MARKER = "[PEDIDOS E CONCLUSÕES — REFERENCE ONLY] (mini-compress, pares dos últimos pedidos)";
export const PAIRS_FOOTER = "[FIM DOS PEDIDOS E CONCLUSÕES]";
export const NOTICE_MARK = "🔎 AVISO — O QUE FOI COMPACTADO ACIMA É RECUPERÁVEL";

/* truncamentos por item dentro do resumo (iguais ao mini-compress) */
const USER_REQ_CHARS = 400;
const LOG_LINE_CHARS = 180;
const MAX_USER_REQS = 12;
const MAX_LOG_LINES = 25;

export type Opcoes = {
  /** gatilho em MILHARES de tokens (200 = 200k; 0 = nunca) */
  thresholdK: number;
  /** quantas últimas mensagens a parte C tenta manter verbatim */
  protectLastN: number;
  /** teto de caracteres da parte C */
  tailCharsCap: number;
  /** teto de caracteres da parte B */
  pairsBlockCap: number;
  /** teto de caracteres da parte A */
  summaryCharsCap: number;
  /** quantos pares pedido->conclusão no bloco B */
  maxPairs: number;
};

export const OPCOES_PADRAO: Opcoes = {
  thresholdK: 200,
  protectLastN: 20,
  tailCharsCap: 80_000,
  pairsBlockCap: 40_000,
  summaryCharsCap: 12_000,
  maxPairs: 8,
};

export type PedidoDeOrcamento = {
  /** system prompt (intocável) */
  system: string;
  /** histórico da gaveta, da mais antiga para a mais nova (sem a pergunta atual) */
  historico: MsgChat[];
  /** pergunta atual (intocável) */
  pergunta: string;
  /** tokens que as specs de ferramenta custam */
  toolsTokens: number;
  /** janela total do modelo (detectada ou configurada) */
  janela: number;
  /** quanto deixar livre para a resposta */
  reserva: number;
  /** opções da compactação (as mesmas chaves do mini-compress) */
  opcoes?: Partial<Opcoes>;
};

export type Plano = {
  mensagens: MsgChat[];
  /** a compactação agiu neste turno? (abaixo do gatilho = false, histórico inteiro) */
  compactou: boolean;
  /** gatilho efetivo em tokens (min(threshold_k, 90% da janela)) */
  gatilho: number;
  /** tokens estimados do payload final */
  tokens: number;
  /** para quanto ficou o orçamento disponível */
  disponivel: number;
  /** mensagens antigas que entraram no resumo (parte A) */
  resumidas: number;
  /** pares pedido->conclusão preservados íntegros (parte B) */
  pares: number;
  /** conteúdos apertados por dentro para caber (emergência) */
  cortadas: number;
  /** mensagens jogadas fora para caber (última instância) */
  descartadas: number;
  /** cabou no orçamento? */
  coube: boolean;
};

const txt = (m: MsgChat): string => String(m?.content ?? "");
const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim();

function crop(texto: string, maxChars: number): string {
  const t = oneLine(texto);
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars - 1).trimEnd()}…`;
}

function charsDe(msgs: MsgChat[]): number {
  let n = 0;
  for (const m of msgs) n += txt(m).length;
  return n;
}

/** bloco A/B/aviso de compactação (não vira pedido nem par numa nova análise) */
export function ehBlocoCompactado(m: MsgChat): boolean {
  const h = txt(m).trimStart();
  return h.startsWith(SUMMARY_MARKER) || h.startsWith(PAIRS_MARKER) || h.startsWith(NOTICE_MARK);
}

/** trunca uma mensagem POR DENTRO (70% início + 30% fim), preservando o role */
function truncarPorDentro(m: MsgChat, cap: number): MsgChat {
  const t = txt(m);
  if (cap <= 0 || t.length <= cap) return { ...m };
  const cabeca = Math.max(0, Math.floor(cap * 0.7));
  const cauda = Math.max(0, cap - cabeca);
  const marca = `\n\n…[compactação: output truncado de ${t.length} chars para ${cap}; texto completo continua gravado na gaveta]…\n\n`;
  return { ...m, content: t.slice(0, cabeca) + marca + (cauda ? t.slice(-cauda) : "") };
}

type Par = { pedido: string; conclusao: string };

/** casa pedidos (user) com a ÚLTIMA resposta de texto do assistente antes do próximo pedido */
export function extrairPares(meio: MsgChat[], maxPairs: number): { pares: Par[]; pendente: MsgChat | null } {
  if (maxPairs <= 0) return { pares: [], pendente: null };
  const pares: Par[] = [];
  let pendente: MsgChat | null = null;
  let pedido: string | null = null;
  let pedidoMsg: MsgChat | null = null;
  let conclusao: string | null = null;

  for (const m of meio) {
    if (ehBlocoCompactado(m)) continue;
    if (m.role === "user") {
      if (pedido !== null && conclusao !== null) pares.push({ pedido, conclusao });
      pedido = txt(m).trim() || null;
      pedidoMsg = m;
      conclusao = null;
    } else if (m.role === "assistant") {
      const t = txt(m).trim();
      if (t) conclusao = t;
    }
  }
  if (pedido !== null && conclusao !== null) {
    pares.push({ pedido, conclusao });
    pendente = null;
  } else {
    pendente = pedido !== null ? pedidoMsg : null;
  }
  return { pares: pares.slice(-maxPairs), pendente };
}

function corpoPares(pares: Par[]): string {
  const linhas = [
    PAIRS_MARKER,
    `(${pares.length} pares — o que foi pedido e o que foi entregue; verbatim íntegro, sem cortes)`,
  ];
  for (const p of pares) {
    linhas.push(`• “${p.pedido}”`);
    linhas.push(`  → ${p.conclusao}`);
  }
  linhas.push(PAIRS_FOOTER);
  return linhas.join("\n");
}

/** encaixa os pares no teto: descarta os mais ANTIGOS (nunca corta um par no meio) */
function encaixarPares(pares: Par[], budget: number): Par[] {
  const out = [...pares];
  while (out.length > 1 && corpoPares(out).length > budget) out.shift();
  return out;
}

function construirPares(pares: Par[], budget: number): MsgChat {
  let body = corpoPares(pares);
  if (body.length > budget) {
    const keep = Math.max(0, budget - PAIRS_FOOTER.length - 80);
    body = `${body.slice(0, keep).trimEnd()}\n…[par excede o teto sozinho — truncado]…\n\n${PAIRS_FOOTER}`;
  }
  return { role: "user", content: body };
}

/** resumo determinístico da faixa antiga (mesmo formato do mini-compress) */
export function construirResumo(faixa: MsgChat[], nPares: number, budget: number): MsgChat {
  const pedidos: string[] = [];
  const log: string[] = [];
  let nTools = 0;
  let nAssistant = 0;
  let nIgnorados = 0;

  for (const m of faixa) {
    if (ehBlocoCompactado(m)) {
      nIgnorados++;
      continue;
    }
    const t = txt(m).trim();
    if (m.role === "user") {
      if (t) pedidos.push(crop(t, USER_REQ_CHARS));
    } else if (m.role === "tool") {
      nTools++;
      const fn = String((m as Record<string, unknown>).name ?? (m as Record<string, unknown>).tool_name ?? "tool");
      log.push(`• ferramenta ${fn}: ${t ? crop(t, LOG_LINE_CHARS) : "(sem saída)"}`);
    } else if (m.role === "assistant") {
      nAssistant++;
      if (t) log.push(`• resposta: ${crop(t, LOG_LINE_CHARS)}`);
    }
  }

  const partes: string[] = [SUMMARY_MARKER];
  const extra = nPares ? ` — ${nPares} pares no bloco seguinte` : "";
  const nota = nIgnorados
    ? ` (inclui ${nIgnorados} marcador(es) de compactação anterior, ignorado(s) na análise)`
    : "";
  partes.push(
    `(faixa antiga compactada: ${faixa.length - nIgnorados} mensagens — ${pedidos.length} pedidos, ` +
      `${nTools} saídas de ferramenta, ${nAssistant} respostas; resumo determinístico, sem LLM${extra}${nota})`,
  );

  if (pedidos.length) {
    partes.push("## Pedidos do usuário (restantes da faixa, mais recentes primeiro)");
    pedidos
      .slice(-MAX_USER_REQS)
      .reverse()
      .forEach((r, i) => partes.push(`${i + 1}. ${r}`));
    if (pedidos.length > MAX_USER_REQS) {
      partes.push(`…(+${pedidos.length - MAX_USER_REQS} pedidos mais antigos não listados)`);
    }
  }
  if (log.length) {
    partes.push("## Ações registradas (amostra, mais recentes)");
    for (const ln of log.slice(-MAX_LOG_LINES)) partes.push(crop(ln, LOG_LINE_CHARS));
    if (log.length > MAX_LOG_LINES) partes.push(`…(+${log.length - MAX_LOG_LINES} ações não listadas)`);
  }
  partes.push(SUMMARY_FOOTER);

  let body = partes.join("\n\n");
  if (body.length > budget) {
    const keep = Math.max(0, budget - SUMMARY_FOOTER.length - 40);
    body = `${body.slice(0, keep).trimEnd()}\n…[resumo truncado no teto]\n\n${SUMMARY_FOOTER}`;
  }
  return { role: "user", content: body };
}

/** aviso de recuperação — SEMPRE no início da parte C, nunca truncado */
export function construirAviso(): MsgChat {
  return {
    role: "user",
    content:
      `${NOTICE_MARK}\n` +
      "Os detalhes exatos da faixa acima (saídas de ferramenta, arquivos, erros, trechos literais) " +
      "saíram do que você está lendo agora. O histórico completo continua gravado na gaveta: " +
      "se precisar de um trecho exato, peça ao usuário ou busque na gaveta — não adivinhe.",
  };
}

/** Gatilho efetivo: o que vier primeiro entre o absoluto (k*1000) e 90% da janela. */
export function gatilhoEmTokens(opcoes: Opcoes, janela: number): number {
  const cands: number[] = [];
  if (opcoes.thresholdK > 0) cands.push(Math.round(opcoes.thresholdK * 1000));
  if (janela > 0) cands.push(Math.floor(janela * SAFETY_CONTEXT_PERCENT));
  return cands.length ? Math.min(...cands) : 0;
}

/** Monta o payload: abaixo do gatilho vai inteiro; no gatilho (ou sem caber), cascata C/B/A. */
export function montarPayload(p: PedidoDeOrcamento): Plano {
  const op: Opcoes = { ...OPCOES_PADRAO, ...(p.opcoes ?? {}) };
  const disponivel = Math.max(1, Math.floor(p.janela - p.reserva - p.toolsTokens));
  const system: MsgChat[] = p.system.trim() ? [{ role: "system", content: p.system }] : [];
  const atual: MsgChat[] = [{ role: "user", content: p.pergunta }];
  const gatilho = gatilhoEmTokens(op, p.janela);

  const historico = p.historico.map((m) => ({ ...m }));
  const intacto = custoDoPayload([...system, ...historico, ...atual]);

  /* ---- abaixo do gatilho E cabendo: nada é tocado (igual ao mini-compress) ---- */
  if ((gatilho <= 0 || intacto < gatilho) && intacto <= disponivel) {
    return {
      mensagens: [...system, ...historico, ...atual],
      compactou: false,
      gatilho,
      tokens: intacto,
      disponivel,
      resumidas: 0,
      pares: 0,
      cortadas: 0,
      descartadas: 0,
      coube: true,
    };
  }

  /* ---- PARTE C: últimas protect_last_n verbatim, teto de caracteres ---- */
  const n = historico.length;
  let cauda = historico.slice(Math.max(0, n - Math.max(0, op.protectLastN)));
  while (cauda.length > 1 && charsDe(cauda) > op.tailCharsCap) cauda.shift();

  /* o que saiu do C volta para a análise do B/A */
  const meio = historico.slice(0, n - cauda.length);

  /* ---- PARTE B: pares íntegros dos mais RECENTES do meio ---- */
  let { pares } = extrairPares(meio, op.maxPairs);
  pares = encaixarPares(pares, op.pairsBlockCap);

  /* ---- PARTE A: resumo do que sobra ANTES da região dos pares ---- */
  let faixaA = meio;
  if (pares.length) {
    const alvo = pares[0].pedido.trim();
    const idx = meio.findIndex((m) => m.role === "user" && txt(m).trim() === alvo);
    faixaA = idx > 0 ? meio.slice(0, idx) : [];
  }
  const fazerBlocoA = (faixa: MsgChat[], budget: number): MsgChat | null =>
    faixa.length ? construirResumo(faixa, pares.length, budget) : null;
  let blocoA = fazerBlocoA(faixaA, op.summaryCharsCap);
  let blocoB = pares.length ? construirPares(pares, op.pairsBlockCap) : null;

  const montar = (c: MsgChat[]): MsgChat[] => {
    /* o aviso só entra quando houve compactação de verdade (A, B ou cauda) — se nem
       isso existe, o payload é system + pergunta e não há o que avisar */
    const houve = Boolean(blocoA || blocoB || c.length);
    return [
      ...system,
      ...(blocoA ? [blocoA] : []),
      ...(blocoB ? [blocoB] : []),
      ...(houve ? [construirAviso()] : []),
      ...c,
      ...atual,
    ];
  };

  let saida = montar(cauda);
  let cortadas = 0;
  let descartadas = 0;

  /* ---- EMERGÊNCIA 1: ainda não coube -> aperta a cauda POR DENTRO ---- */
  if (custoDoPayload(saida) > disponivel) {
    const tetoPorMsg = Math.max(2000, Math.floor(op.tailCharsCap / Math.max(cauda.length, 1)));
    const apertada = cauda.map((m) => truncarPorDentro(m, tetoPorMsg));
    cortadas = apertada.filter((m, i) => txt(m).length < txt(cauda[i]).length).length;
    cauda = apertada;
    saida = montar(cauda);
  }

  /* ---- EMERGÊNCIA 2: descarta do mais antigo da cauda (até esvaziar) ---- */
  while (custoDoPayload(saida) > disponivel && cauda.length > 0) {
    cauda.shift();
    descartadas++;
    saida = montar(cauda);
  }

  /* ---- EMERGÊNCIA 3: ainda não coube -> encolhe B e A (nunca o system nem a pergunta) ---- */
  while (custoDoPayload(saida) > disponivel && pares.length > 1) {
    pares = pares.slice(1); /* par mais antigo volta a ser texto do resumo */
    faixaA = meio.slice(0, Math.max(0, faixaA.length + 2));
    blocoB = construirPares(pares, op.pairsBlockCap);
    blocoA = fazerBlocoA(faixaA, op.summaryCharsCap);
    saida = montar(cauda);
  }
  while (custoDoPayload(saida) > disponivel && blocoA) {
    const corpo = txt(blocoA);
    if (corpo.length <= 600) break;
    blocoA = { role: "user", content: corpo.slice(0, Math.floor(corpo.length * 0.6)) + "\n…[resumo truncado por orçamento]\n\n" + SUMMARY_FOOTER };
    saida = montar(cauda);
  }

  /* ---- EMERGÊNCIA 4: nem os blocos cabem -> só system + pergunta (nunca estoura) ---- */
  if (custoDoPayload(saida) > disponivel) {
    const antes = custoDoPayload(saida);
    blocoA = null;
    blocoB = null;
    saida = montar([]);
    if (custoDoPayload(saida) < antes) cortadas++;
  }

  const tokens = custoDoPayload(saida);
  return {
    mensagens: saida,
    compactou: true,
    gatilho,
    tokens,
    disponivel,
    resumidas: faixaA.length,
    pares: pares.length,
    cortadas,
    descartadas,
    coube: tokens <= disponivel,
  };
}

/** Aperta UMA rodada do loop de ferramentas: resultado velho de ferramenta encolhe antes de qualquer descarte. */
export function apertarRodada(
  mensagens: MsgChat[],
  orc: { janela: number; reserva: number; toolsTokens: number; verbatim: number },
): { mensagens: MsgChat[]; cortadas: number; descartadas: number; tokens: number; disponivel: number } {
  const disponivel = Math.max(1, Math.floor(orc.janela - orc.reserva - orc.toolsTokens));
  const copia = mensagens.map((m) => ({ ...m }));
  let cortadas = 0;
  let descartadas = 0;

  const custo = () => custoDoPayload(copia) + Math.max(0, orc.toolsTokens);

  /* 1) conteúdos de ferramenta: os mais antigos viram as primeiras vítimas (400 chars) */
  for (let i = 0; i < copia.length - 1 && custo() > disponivel; i++) {
    if (copia[i].role === "tool" && txt(copia[i]).length > 400) {
      copia[i].content = `${txt(copia[i]).slice(0, 400)}\n…(cortado por orçamento de contexto)`;
      cortadas++;
    }
  }
  /* 2) mensagens antigas (mantém system na frente + cauda verbatim + última) */
  const cauda = Math.max(1, Math.min(orc.verbatim, copia.length - 2));
  while (custo() > disponivel && copia.length > 2 + cauda) {
    const idx = copia.findIndex((m, i) => i > 0 && m.role !== "system" && copia.length - 1 - i >= cauda);
    if (idx < 0) break;
    copia.splice(idx, 1);
    descartadas++;
  }
  return { mensagens: copia, cortadas, descartadas, tokens: custo(), disponivel };
}
