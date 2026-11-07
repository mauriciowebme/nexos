/** Conversas em andamento (v3.0) — a conversa NÃO pertence ao componente.
 *
 *  Por quê: enquanto o agente trabalha (busca, ferramenta, modelo local devagar), você quer
 *  ir olhar a PÁGINA DE BUSCA ou outra gaveta sem perder o que está sendo processado. Se o
 *  estado morar dentro do React, desmontar a tela derruba a bolha e a fila.
 *
 *  Então: este módulo é puro TypeScript, sem import e sem React. Ele guarda o estado por
 *  conversa (`tenant|memoria`), roda a tarefa até o fim mesmo sem ninguém olhando, e avisa
 *  os ouvintes (o Chat) quando algo muda. Fechar a aba do navegador ainda cancela o pedido —
 *  isso é outro degrau (tarefa no servidor); aqui o objetivo é sobreviver à navegação no painel.
 */

/** v3.23 — tela gerada pelo agente (mesmo formato de `types.ts`; aqui sem import para o
 *  módulo continuar puro, sem dependência). */
export type Tela = { id: string; titulo: string; html: string };

export type EventoTransporte =
  | { tipo: "delta"; texto: string }
  /** v3.13: pedaço do raciocínio do modelo (estilo Open WebUI) */
  | { tipo: "raciocinio"; texto: string }
  /** v3.3: fotografia do texto acumulado no servidor (stream reanexável); o client usa
   *  como BASE e descarta o delta cujo efeito não passa dela (duplicata da corrida R2). */
  | { tipo: "parcial"; texto: string }
  | { tipo: "descartar" }
  /** v3.8: fala de caminho da rodada — mostra e FICA (pedido do dono) */
  | { tipo: "fala"; texto: string }
  /** v3.72 (dono 04/11): pedaço de narração SENDO ESCRITA dentro do rastro, letra a letra */
  | { tipo: "narracao_viva"; texto: string }
  /** v3.72: a rodada fechou SEM ferramenta — o texto da trilha é a resposta e muda de casa */
  | { tipo: "mover_resposta"; texto: string; caracteres?: number }
  /** v3.72: a linha viva da narração não deixou fala — sai da vista */
  | { tipo: "fala_fim" }
  /** v3.34: a ferramenta COMEÇOU — abre a linha viva "Consultando X… Ns" na trilha */
  | { tipo: "ferramenta_inicio"; nome: string }
  | { tipo: "ferramenta"; servidor: string; nome: string; ok: boolean; ms: number }
  /** v3.43: a pessoa falou no MEIO do turno — entra na trilha, no ponto em que chegou */
  | { tipo: "steer"; texto: string }
  /** v3.74 (T056/T057): o GUARDA DO LAÇO falou — chamada repetida detectada, ou saída de
   *  ferramenta que saiu do payload e virou arquivo na pasta da conta */
  | { tipo: "guarda"; texto: string }
  /** v3.23: tela pronta — o card com preview funcional entra na bolha na hora */
  | { tipo: "tela"; tela: Tela }
  /** v3.44: arquivo/print que a máquina mandou — aparece na hora (miniatura + baixar) */
  | { tipo: "anexo"; anexo: AnexoArquivo }
  /** v3.24: código da tela chegando em pedaços (o dono vê o HTML sendo digitado) */
  | { tipo: "codigo"; texto: string }
  | { tipo: "fim"; dados: Record<string, unknown> }
  | { tipo: "erro"; detalhe: string };

/** quem sabe falar com o servidor (o Chat injeta; o teste injeta um falso) */
export type Transportar = (
  pedido: { pergunta: string; memoria: string; tenant?: string; provedor?: string; modelo?: string; imagens?: AnexoImagem[]; anexos?: AnexoEnviado[] },
  onEvent: (e: EventoTransporte) => void,
) => Promise<Record<string, unknown>>;

/** o que a tela desenrola em "ferramentas chamadas" (mesmo formato que o servidor devolve) */
export type FerramentaLinha = { servidor: string; nome: string; ok: boolean; ms: number; args?: unknown; resumo?: string };

/** v3.15 — segmento do RASTRO DO TURNO, na ordem em que aconteceu (o jeito do IA_GO):
 *  o pensamento com o tempo dele, a fala de caminho e a ferramenta com o tempo dela.
 *  `vivo`/`inicio` só existem na tela enquanto o passo está acontecendo: o servidor devolve
 *  a trilha pronta, com o tempo medido, e ela substitui a montagem ao vivo no `fim`. */
export type SegmentoRastro =
  /** `em` (v3.34): ms desde o começo do turno em que o passo aconteceu — a trilha é ordenada
   *  por ele (cronologia de verdade), com `vivo`/`inicio` só do que está acontecendo agora. */
  | { tipo: "pensamento"; texto: string; ms: number; vivo?: boolean; inicio?: number; em?: number }
  | { tipo: "narracao"; texto: string; vivo?: boolean; inicio?: number; em?: number }
  | { tipo: "ferramenta"; servidor: string; nome: string; ok: boolean; ms: number; vivo?: boolean; inicio?: number; em?: number }
  /** v3.43: a fala que a pessoa mandou NO MEIO do turno — mora na trilha, no ponto em que chegou */
  | { tipo: "interrupcao"; texto: string; em?: number }
  /** v3.74 (T056/T057): o guarda do laço interveio (chamada repetida / saída virou arquivo) */
  | { tipo: "guarda"; texto: string; em?: number };

/** v3.44: arquivo que veio da máquina (print, imagem, log) e mora em `anexos` no servidor */
export type AnexoArquivo = { id: string; nome: string; mime: string; bytes: number };

export type Linha = {
  id: string;
  /** id no banco (v3.18): só as linhas vindas do servidor têm — é a alavanca do "editar e reenviar" */
  sid?: number;
  papel: "user" | "assistant";
  texto: string;
  ferramentas: FerramentaLinha[];
  /** ainda não saiu para o modelo */
  naFila?: boolean;
  /** erro de envio */
  falha?: boolean;
  /** escrevendo em pedaços agora */
  escrevendo?: boolean;
  /** fala de caminho (rascunho da rodada virou balão fixo) */
  fala?: boolean;
  /** v3.13: o que o modelo pensou (mostrado recolhido, estilo Open WebUI) */
  raciocinio?: string;
  /** v3.15: a trilha do turno (pensamento / fala / ferramenta) na ordem real */
  rastro?: SegmentoRastro[];
  /** ms desde o começo do turno até o 1º pedaço de pensamento */
  raciocinioInicio?: number;
  /** ms desde o começo do turno até a resposta começar (fecha o "Pensou por Ns") */
  raciocinioFim?: number;
  aviso?: string | null;
  compacto?: string;
  /** v3.41: imagens que a pessoa colou neste turno (só na tela: o servidor grava texto) */
  imagens?: AnexoImagem[];
  /** v3.46: arquivos grandes anexados nesta mensagem (mostrados na bolha) */
  arquivos?: AnexoEnviado[];
  /** v3.18: hora ISO da mensagem (T012 — o servidor já mandava `quando`, a tela ignorava) */
  when?: string;
  /** v3.18 (T004): de quais documentos a resposta veio */
  fontes?: string[];
  /** v3.18 (T018): quanto custou (tok_out; tok_in quando o servidor mandou) */
  custo?: Record<string, unknown> | null;
  /** v3.19: qual provedor nomeado respondeu (ausente = padrão da casa) */
  provedor?: string;
  modelo?: string;
  /** v3.23: telas geradas neste turno (cards com preview funcional) */
  telas?: Tela[];
  /** v3.44: arquivos/prints que as ferramentas trouxeram neste turno */
  anexos?: AnexoArquivo[];
  /** v3.24: o código da tela enquanto o modelo escreve (o HTML nasce à vista) */
  codigo?: string;
  /** v3.34: duração do turno medida pelo servidor — é o tempo do cabeçalho do rastro */
  ms?: number;
  /** v3.34: quando esta bolha começou a ser escrita (epoch ms) — relógio do turno ao vivo */
  inicio?: number;
};

/** v3.41: imagem colada no campo (Ctrl+V) — vai no turno como parte de visão do modelo */
export type AnexoImagem = { mime: string; base64: string; nome?: string };

/** v3.46: arquivo grande que o navegador subiu em blocos — fica no servidor, só o id viaja */
export type AnexoEnviado = { id: string; nome: string; bytes: number };

/** v3.73 (T054): para onde foi o contexto do ÚLTIMO envio. As três fatias somam o total —
 *  quando o provedor conta de verdade, o total é dele e as fatias são proporcionais (a tela
 *  declara isso). */
export type DetalheContexto = { prompt: number; conversa: number; ferramentas: number };
export type RetratoContexto = {
  tokens: number;
  disponivel: number;
  detalhe: DetalheContexto;
  origem_contagem: "estimativa" | "provedor";
  estimado: boolean;
  janela: number;
  reserva: number;
  origem_janela: string;
};

/** v3.73 (T054): o retrato viaja no `custo.ctx` do `fim` — e volta com o histórico, porque é
 *  o mesmo JSONB gravado na mensagem. Só mostramos o medidor com os DOIS números (usado e teto). */
export function retratoDoCusto(custo: unknown): RetratoContexto | null {
  const c = (custo as Record<string, unknown> | null | undefined)?.ctx as Record<string, unknown> | undefined;
  if (!c) return null;
  const tokens = Number(c.tokens ?? 0);
  const disponivel = Number(c.disponivel ?? 0);
  if (!(tokens > 0) || !(disponivel > 0)) return null;
  const d = (c.detalhe ?? {}) as Record<string, unknown>;
  return {
    tokens,
    disponivel,
    detalhe: {
      prompt: Number(d.prompt ?? 0),
      conversa: Number(d.conversa ?? 0),
      ferramentas: Number(d.ferramentas ?? 0),
    },
    origem_contagem: c.origem_contagem === "provedor" ? "provedor" : "estimativa",
    estimado: c.estimado !== false,
    janela: Number(c.janela ?? 0),
    reserva: Number(c.reserva ?? 0),
    origem_janela: String(c.origem_janela ?? ""),
  };
}

export type MedicaoEscrita = { ateLetraMs: number; escritaMs: number; tokEscrita: number; tokS: number };

/** v3.73.1 (T055): o que o turno MEDEU de escrita (1ª letra, janela de escrita, tok/s). Mora no
 *  mesmo `custo` gravado na mensagem, então sobrevive a recarregar a conversa. Devolve null
 *  quando não houve medição — a tela não mostra número inventado. */
export function velocidadeDoCusto(custo: unknown): MedicaoEscrita | null {
  const c = (custo ?? {}) as Record<string, unknown>;
  const escritaMs = Number(c.ms_escrita ?? 0);
  const tokS = Number(c.tok_s ?? 0);
  const tokEscrita = Number(c.tok_escrita ?? 0);
  if (!(escritaMs > 0) || !(tokS > 0) || !(tokEscrita > 0)) return null;
  return { ateLetraMs: Math.max(0, Number(c.ms_ate_primeira_letra ?? 0)), escritaMs, tokEscrita, tokS };
}

export type Estado = {
  msgs: Linha[];
  fila: { id: string; texto: string; imagens?: AnexoImagem[]; arquivos?: AnexoEnviado[] }[];
  rodando: boolean;
  /** v3.18 (T001): id da tarefa no servidor do turno em curso ("" = nada para parar) */
  tarefaId: string;
  /** "parar" apertado — aguardando o `fim` com o parcial (botão vira "parando…") */
  parando: boolean;
  /** a bolha que está sendo escrita agora (vazio = nenhuma) */
  vivo: string;
  /** desde quando esta tarefa corre, em epoch ms (0 = parada) — a tela mostra o tempo certo ao voltar */
  inicio: number;
  /** v3.73 (T054): retrato do contexto do ÚLTIMO envio desta conversa (null = nunca enviou,
   *  ou o provedor não contou e o histórico não trouxe o número: sem os dois números, sem barra) */
  contexto: RetratoContexto | null;
};

type Conversa = Estado & { ouvintes: Set<() => void> };

let seq = 0;
/* v3.15 — o rastro do turno (o jeito do IA_GO). As três ajudas abaixo montam a trilha ao
 *  vivo, na ordem dos eventos; no `fim` a trilha do servidor (com tempo medido) substitui. */
function fecharPensamento(b: Linha): void {
  const r = b.rastro ?? [];
  const ultimo = r.length ? r[r.length - 1] : null;
  if (ultimo && ultimo.tipo === "pensamento" && ultimo.vivo) {
    ultimo.vivo = false;
    ultimo.ms = Math.max(0, Date.now() - (ultimo.inicio ?? Date.now()));
  }
}

/** emenda o pedaço de raciocínio no bloco aberto da rodada, ou abre um bloco novo */
function acrescentarPensamento(b: Linha, pedaco: string): void {
  const r = (b.rastro ??= []);
  const ultimo = r.length ? r[r.length - 1] : null;
  if (ultimo && ultimo.tipo === "pensamento" && ultimo.vivo) ultimo.texto += pedaco;
  else r.push({ tipo: "pensamento", texto: pedaco, ms: 0, vivo: true, inicio: Date.now() });
}

/** acrescenta uma linha fechada à trilha (fala de caminho ou ferramenta) */
function acrescentar(b: Linha, s: SegmentoRastro): void {
  (b.rastro ??= []).push(s);
}

/* v3.72 (dono 04/11) — a NARRAÇÃO nasce escrita DENTRO da trilha, letra a letra, e só
   depois muda de casa: virou fala (rodada chamou ferramenta) ou virou resposta (rodada
   terminou sem ferramenta). Nada é pintado na bolha para depois ser apagado. */

/** emenda o pedaço na linha viva da narração, ou abre a linha na trilha */
function acrescentarNarracaoViva(b: Linha, pedaco: string, em: number): void {
  const r = (b.rastro ??= []);
  const ultimo = r.length ? r[r.length - 1] : null;
  if (ultimo && ultimo.tipo === "narracao" && ultimo.vivo) ultimo.texto += pedaco;
  else r.push({ tipo: "narracao", texto: pedaco, vivo: true, inicio: Date.now(), em });
}

/** fecha a linha viva da narração com o texto definitivo do servidor (sem duplicar a linha) */
function fecharNarracaoViva(b: Linha, texto: string, em: number): boolean {
  const r = b.rastro ?? [];
  for (let i = r.length - 1; i >= 0; i--) {
    const s = r[i];
    if (s.tipo === "narracao" && s.vivo) {
      if (texto) { s.texto = texto; s.em = em; }
      s.vivo = false;
      delete s.inicio;
      return true;
    }
  }
  return false;
}

/** a linha viva da narração não deixou fala nenhuma: sai da vista */
function descartarNarracaoViva(b: Linha): boolean {
  const r = b.rastro ?? [];
  for (let i = r.length - 1; i >= 0; i--) {
    const s = r[i];
    if (s.tipo === "narracao" && s.vivo) { r.splice(i, 1); return true; }
  }
  return false;
}

/** a linha viva da narração É a resposta: sai da trilha e vira a bolha (uma vez só) */
function moverNarracaoParaBolha(b: Linha): string {
  const r = b.rastro ?? [];
  for (let i = r.length - 1; i >= 0; i--) {
    const s = r[i];
    if (s.tipo === "narracao" && s.vivo) {
      const texto = s.texto;
      r.splice(i, 1);
      return texto;
    }
  }
  return "";
}

/** v3.34: a ferramenta terminou — fecha a linha que estava viva em vez de criar outra
 *  (antes a linha só nascia no fim; agora ela existe enquanto roda e é completada aqui) */
function fecharFerramenta(b: Linha, servidor: string, nome: string, ok: boolean, ms: number): boolean {
  const r = b.rastro ?? [];
  for (let i = r.length - 1; i >= 0; i--) {
    const s = r[i];
    if (s.tipo === "ferramenta" && s.vivo) {
      Object.assign(s, { servidor, nome, ok, ms, vivo: false });
      return true;
    }
  }
  return false;
}

/** v3.34: a trilha é cronológica — ordena por `em` quando todas as linhas têm o instante;
 *  mensagem antiga (sem `em`) mantém a ordem que veio do servidor. */
function ordenarRastro(trilha: SegmentoRastro[]): SegmentoRastro[] {
  if (!trilha.every((s) => typeof s.em === "number")) return trilha;
  return [...trilha].sort((a, b) => (a.em as number) - (b.em as number));
}

/** a trilha autoritativa do servidor tem o tempo medido de cada passo; sem ela (servidor
 *  mais velho), fica a montagem ao vivo da tela */
function adotarRastro(b: Linha, r: Record<string, unknown>): boolean {
  const trilha = Array.isArray(r.rastro) ? (r.rastro as SegmentoRastro[]) : [];
  if (!trilha.length) return false;
  b.rastro = ordenarRastro(trilha.map((s) => ({ ...s })));
  return true;
}

const proximoId = () => `c${Date.now().toString(36)}-${++seq}`;

const conversas = new Map<string, Conversa>();

function nova(): Conversa {
  return { msgs: [], fila: [], rodando: false, tarefaId: "", parando: false, vivo: "", inicio: 0, contexto: null, ouvintes: new Set() };
}

/* v3.19: provedor/modelo escolhidos POR CONVERSA — a tela lembra e todo reenvio
 * (novo, regenerar, fila, edição) leva junto. "" = padrão da casa.
 * v3.60: a escolha agora SOBREVIVE ao recarregamento. Duas camadas no navegador:
 * a da CONVERSA (`tenant|gaveta`) vence; a da CONTA (`tenant`) é a última usada em
 * qualquer conversa — recarregar não devolve o chat ao automático sem o dono pedir. */
const selecoes = new Map<string, { provedor?: string; modelo?: string }>();
type Selecao = { provedor?: string; modelo?: string };
const loja = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
const chaveDaConta = (chave: string) => `nexos:selecao:conta:${chave.split("|")[0] || "-"}`;
const chaveDaConversa = (chave: string) => `nexos:selecao:conversa:${chave}`;
function lerGravada(chave: string): Selecao | null {
  const s = loja();
  if (!s) return null;
  try {
    const bruto = s.getItem(chave);
    if (!bruto) return null;
    const v = JSON.parse(bruto) as { provedor?: unknown; modelo?: unknown };
    return { provedor: String(v.provedor ?? ""), modelo: String(v.modelo ?? "") };
  } catch {
    return null;
  }
}
function gravar(chave: string, sel: Selecao): void {
  const s = loja();
  if (!s) return;
  try {
    s.setItem(chave, JSON.stringify({ provedor: sel.provedor ?? "", modelo: sel.modelo ?? "" }));
  } catch {
    /* navegador em modo privado ou cota cheia: a escolha vale só nesta sessão */
  }
}
export function definirSelecao(chave: string, sel: Selecao): void {
  selecoes.set(chave, sel);
  gravar(chaveDaConversa(chave), sel);
  gravar(chaveDaConta(chave), sel);
}
export function getSelecao(chave: string): { provedor: string; modelo: string } {
  const s = selecoes.get(chave) ?? lerGravada(chaveDaConversa(chave)) ?? lerGravada(chaveDaConta(chave)) ?? {};
  return { provedor: s.provedor ?? "", modelo: s.modelo ?? "" };
}

export function chaveConversa(tenant: string, memoria: string) {
  return `${tenant || "-"}|${memoria || "-"}`;
}

function pega(chave: string): Conversa {
  let c = conversas.get(chave);
  if (!c) {
    c = nova();
    conversas.set(chave, c);
  }
  return c;
}

function notifica(chave: string): void {
  const c = conversas.get(chave);
  if (!c) return;
  /* cópia rasa: o React exige referência nova para re-renderizar */
  c.ouvintes.forEach((f) => {
    try {
      f();
    } catch {
      /* ouvinte morto (tela desmontada) nunca interrompe o processamento */
    }
  });
}

/** fotografia imutável do estado (o que o Chat renderiza) */
export function estado(chave: string): Estado {
  const c = pega(chave);
  return { msgs: c.msgs.slice(), fila: c.fila.slice(), rodando: c.rodando, tarefaId: c.tarefaId, parando: c.parando, vivo: c.vivo, inicio: c.inicio, contexto: c.contexto };
}

/** dá para assinar mesmo com a tela fechada: o trabalho continua e a tela volta quando quiser */
export function assinar(chave: string, fn: () => void): () => void {
  const c = pega(chave);
  c.ouvintes.add(fn);
  return () => c.ouvintes.delete(fn);
}

/** o histórico carregado do servidor entra na conversa sem atropelar o que está vivo */
export function semear(chave: string, msgs: Linha[]): void {
  const c = pega(chave);
  const vivo = c.msgs.filter((m) => m.escrevendo || m.naFila);
  c.msgs = [...msgs, ...vivo];
  /* v3.73 (T054): reabrir a conversa não zera o medidor — o retrato do último envio está no
     `custo.ctx` gravado na própria mensagem. Ache a mais nova com retrato e mostra aquele. */
  for (let i = msgs.length - 1; i >= 0; i--) {
    const r = retratoDoCusto(msgs[i].custo);
    if (r) {
      c.contexto = r;
      break;
    }
  }
  notifica(chave);
}

/** empurra para o modelo: entra na fila da gaveta e sai uma por vez, na ordem */
export function enviar(
  chave: string, texto: string, memoria: string, tenant: string | undefined, transportar: Transportar,
  /** v3.41: imagens coladas — só neste turno; não entram no histórico gravado */
  imagens?: AnexoImagem[],
  /** v3.46: arquivos grandes já no servidor (id) — a bolha mostra nome e tamanho */
  arquivos?: AnexoEnviado[],
): string {
  const c = pega(chave);
  const id = proximoId();
  c.msgs.push({
    id, papel: "user", texto, ferramentas: [], naFila: true, when: new Date().toISOString(),
    ...(imagens?.length ? { imagens } : {}),
    ...(arquivos?.length ? { arquivos } : {}),
  });
  c.fila.push({ id, texto, ...(imagens?.length ? { imagens } : {}), ...(arquivos?.length ? { arquivos } : {}) });
  notifica(chave);
  void bombeia(chave, memoria, tenant, transportar);
  return id;
}

/** v3.42 — a tarefa viva desta conversa (para encaixar fala no MEIO do turno) */
export function tarefaViva(chave: string): string {
  const c = pega(chave);
  return c.rodando && c.tarefaId ? c.tarefaId : "";
}

/** v3.43 — fala encaixada no turno em curso: entra DENTRO do rastro do turno, na posição em
 *  que chegou (o dono: "minha mensagem deveria entrar no meio do rastro"). Não vira balão
 *  solto nem vai para a fila; quem entrega ao modelo é a rota /fala. */
export function falarNoTurno(chave: string, texto: string): string {
  const c = pega(chave);
  const alvo = [...c.msgs].reverse().find((m) => m.papel === "assistant");
  if (!alvo) return "";
  alvo.rastro = alvo.rastro ?? [];
  if (!alvo.rastro.some((x) => x.tipo === "interrupcao" && x.texto === texto)) {
    alvo.rastro.push({ tipo: "interrupcao", texto, em: Math.max(0, Date.now() - c.inicio) });
  }
  notifica(chave);
  return alvo.id;
}

/** cancela antes de sair (se já estiver escrevendo, cancela a próxima, não a viva) */
export function cancelar(chave: string, id: string): void {
  const c = pega(chave);
  c.fila = c.fila.filter((x) => x.id !== id);
  c.msgs = c.msgs.filter((m) => m.id !== id);
  notifica(chave);
}

/** v3.18 (T001): a tela registrou o id da tarefa criada (transporte chama depois do POST /chat/tarefa) */
export function registrarTarefa(chave: string, id: string): void {
  const c = pega(chave);
  c.tarefaId = id;
  c.parando = false;
  notifica(chave);
}

/** v3.18 (T001): "parar" — marca o estado do botão e devolve o id para o POST .../cancelar.
 *  Sem tarefa conhecida (servidor antigo / turno local): devolve "" e a tela não faz nada. */
export function pedirParada(chave: string): string {
  const c = pega(chave);
  if (!c.tarefaId || !c.rodando) return "";
  c.parando = true;
  notifica(chave);
  return c.tarefaId;
}

/** v3.18 (T002): regenerar — derruba os N últimos balões da tela (o servidor cortou antes). */
export function descartarUltimos(chave: string, n: number): void {
  const c = pega(chave);
  c.msgs = c.msgs.slice(0, Math.max(0, c.msgs.length - n));
  c.fila = c.fila.filter((f) => c.msgs.some((m) => m.id === f.id && m.naFila));
  notifica(chave);
}

/** v3.18 (T003): editar e reenviar — corta da mensagem `sid` para frente (a própria excluída;
 *  a tela reenvia o texto editado pelo caminho normal, e ele entra de novo como pergunta). */
export function apararAteSid(chave: string, sid: number): void {
  const c = pega(chave);
  const i = c.msgs.findIndex((m) => m.sid === sid);
  if (i < 0) return;
  c.msgs = c.msgs.slice(0, i);
  c.fila = c.fila.filter((f) => c.msgs.some((m) => m.id === f.id && m.naFila));
  notifica(chave);
}

/** limpar a conversa da tela (o servidor apaga o histórico; aqui sobra o que estiver vivo) */
export function limpar(chave: string): void {
  const c = pega(chave);
  c.msgs = c.msgs.filter((m) => m.escrevendo);
  c.fila = [];
  notifica(chave);
}

export function temTrabalho(chave: string): boolean {
  const c = pega(chave);
  return c.rodando || c.fila.length > 0;
}

/** v3.3: tarefa que está viva no servidor (a aba fechou no meio e voltou). */
export type TarefaViva = { id: string; pergunta: string; parcial: string };

/** Adota uma tarefa viva no servidor: bolha do usuário + bolha escrevendo desde o parcial.
 *  A pergunta ainda NÃO está no histórico (o servidor só grava as mensagens no fim), por
 *  isso ela é empurrada aqui. `correr` é injetado — quem sabe religar em queda de rede é
 *  o transporte (Chat.tsx); conversa.ts continua puro, sem conhecer fetch. */
export async function reativar(
  chave: string,
  tarefa: TarefaViva,
  correr: (id: string, onEvent: (e: EventoTransporte) => void) => Promise<Record<string, unknown> | null>,
): Promise<void> {
  const c = pega(chave);
  if (c.rodando) return; // já há trabalho local na frente: não atropela
  c.rodando = true;
  c.inicio = Date.now();
  const vivoId = proximoId();
  c.vivo = vivoId;
  const agora = new Date().toISOString();
  c.msgs.push(
    { id: proximoId(), papel: "user", texto: tarefa.pergunta, ferramentas: [], when: agora },
    { id: vivoId, papel: "assistant", texto: tarefa.parcial, ferramentas: [], escrevendo: true, when: agora, inicio: Date.now() },
  );
  c.tarefaId = tarefa.id; // v3.18: quem reanexou uma tarefa viva também pode pará-la
  notifica(chave);

  let bruto = tarefa.parcial;
  let base = bruto.length; // tamanho da última fotografia confirmada pelo servidor (R2)
  let falou = false;
  let erro = "";
  const caixa: { dados: Record<string, unknown> | null } = { dados: null };
  try {
    const saida = await correr(tarefa.id, (e) => {
      const bolha = c.msgs.find((m) => m.id === vivoId);
      if (!bolha) return;
      if (e.tipo === "parcial") {
        const foto = String(e.texto ?? "");
        if (foto.length > bruto.length) bruto = foto;
        base = Math.max(base, bruto.length);
        bolha.texto = bruto;
      } else if (e.tipo === "delta") {
        const pedaco = String(e.texto ?? "");
        if (bruto.length >= base) {
          bruto += pedaco;
          bolha.texto = bruto;
          if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
          fecharPensamento(bolha);
        } // abaixo da base: o delta já está contido na fotografia — descarta (R2)
      } else if (e.tipo === "raciocinio") {
        bolha.raciocinio = (bolha.raciocinio ?? "") + String(e.texto ?? "");
        if (bolha.raciocinioInicio === undefined) bolha.raciocinioInicio = Math.max(0, Date.now() - c.inicio);
        acrescentarPensamento(bolha, String(e.texto ?? ""));
      } else if (e.tipo === "narracao_viva") {
        /* v3.72: a letra nasce NA TRILHA — dentro do rastro, nunca na bolha */
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
        acrescentarNarracaoViva(bolha, String(e.texto ?? ""), Math.max(0, Date.now() - c.inicio));
      } else if (e.tipo === "mover_resposta") {
        /* v3.72: a rodada acabou SEM chamar ferramenta — o texto que estava sendo escrito na
           trilha é a resposta: muda de casa uma vez (trilha -> bolha), sem reaparecer */
        const txt = moverNarracaoParaBolha(bolha) || String(e.texto ?? "");
        if (txt) {
          bruto += txt; base = Math.max(0, bruto.length); bolha.texto = bruto;
        }
        descartarNarracaoViva(bolha);
      } else if (e.tipo === "fala_fim") {
        descartarNarracaoViva(bolha);
      } else if (e.tipo === "fala") {
        const txt = String(e.texto ?? "");
        if (txt) {
          falou = true;
          if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
          /* v3.15/v3.72: a fala de caminho é LINHA DO RASTRO. A linha já está viva na trilha
             (nasceu em `narracao_viva`) — aqui ela só fecha com o texto definitivo. A bolha
             não é tocada: o que a rodada escreveu nunca entrou nela. */
          fecharPensamento(bolha);
          if (!fecharNarracaoViva(bolha, txt, Math.max(0, Date.now() - c.inicio))) {
            acrescentar(bolha, { tipo: "narracao", texto: txt, em: Math.max(0, Date.now() - c.inicio) });
          }
        }
      } else if (e.tipo === "guarda") {
        /* v3.74 (T056/T057): o guarda do laço falou — entra na trilha no ponto em que
           aconteceu (o dono vê o modelo repetir chamada / a saída virar arquivo) */
        const txt = String(e.texto ?? "");
        if (txt) {
          fecharPensamento(bolha);
          acrescentar(bolha, { tipo: "guarda", texto: txt, em: Math.max(0, Date.now() - c.inicio) });
        }
      } else if (e.tipo === "steer") {
        /* v3.43: interrupção aparece DENTRO do rastro, no ponto em que chegou — não como
           balão solto depois da resposta (que era o pedido do dono) */
        const txt = String(e.texto ?? "").replace(/^\(a pessoa falou enquanto você trabalhava[^)]*\)\s*/, "");
        if (txt && !(bolha.rastro ?? []).some((x) => x.tipo === "interrupcao" && x.texto === txt)) {
          fecharPensamento(bolha);
          acrescentar(bolha, { tipo: "interrupcao", texto: txt, em: Math.max(0, Date.now() - c.inicio) });
        }
      } else if (e.tipo === "ferramenta_inicio") {
        /* v3.34: a linha nasce quando a ferramenta COMEÇA ("Consultando X… Ns") e é fechada no
           evento de fim — a trilha não fica parada enquanto a ferramenta roda */
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
        acrescentar(bolha, {
          tipo: "ferramenta", servidor: "?", nome: String(e.nome), ok: true, ms: 0,
          vivo: true, inicio: Date.now(), em: Math.max(0, Date.now() - c.inicio),
        });
      } else if (e.tipo === "ferramenta") {
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
        const servidor = String(e.servidor);
        const nome = String(e.nome);
        const ok = Boolean(e.ok);
        const ms = Number(e.ms);
        if (!fecharFerramenta(bolha, servidor, nome, ok, ms)) {
          acrescentar(bolha, { tipo: "ferramenta", servidor, nome, ok, ms, em: Math.max(0, Date.now() - c.inicio) });
        }
        bolha.ferramentas.push({ servidor, nome, ok, ms, args: {}, resumo: "" });
      } else if (e.tipo === "tela") {
        /* v3.23: a tela chega pronta — o card entra na bolha sem esperar o fim */
        (bolha.telas ??= []).push(e.tela);
      } else if (e.tipo === "anexo") {
        /* v3.44: print/arquivo da máquina entra na bolha na hora */
        (bolha.anexos ??= []).push(e.anexo);
      } else if (e.tipo === "codigo") {
        /* v3.24: o código da tela nasce letra por letra (pedido do dono) */
        bolha.codigo = (bolha.codigo ?? "") + String(e.texto ?? "");
      } else if (e.tipo === "fim") {
        caixa.dados = e.dados;
      } else if (e.tipo === "erro") {
        erro = String(e.detalhe ?? "a tarefa falhou");
      }
      notifica(chave);
    });
    const bolha = c.msgs.find((m) => m.id === vivoId);
    if (bolha) {
      const r = caixa.dados ?? saida ?? { resposta: bruto };
      bolha.texto = erro ? "não consegui responder: " + erro : String(r.resposta ?? bruto);
      if (!bolha.raciocinio && r.raciocinio) bolha.raciocinio = String(r.raciocinio);
      /* v3.34: o tempo do cabeçalho é o do TURNO medido pelo servidor, não a soma dos trechos */
      const msTurno = Number(r.ms ?? 0);
      if (Number.isFinite(msTurno) && msTurno > 0) bolha.ms = msTurno;
      fecharPensamento(bolha);
      /* v3.15: a trilha do servidor manda (tem o tempo medido de cada passo) */
      const trilhou = adotarRastro(bolha, r);
      /* servidor sem stream (ou reanexar de tarefa): as falas vêm no remanescente do `fim`
         e ainda viram balão quando não existe trilha que as hospede */
      const fl = Array.isArray(r.falas) ? (r.falas as string[]) : [];
      if (fl.length && !falou && !trilhou) {
        const idx = c.msgs.findIndex((m) => m.id === vivoId);
        fl.forEach((txt, k) =>
          c.msgs.splice(idx < 0 ? c.msgs.length : idx + k, 0, {
            id: vivoId + "f" + k, papel: "assistant", texto: String(txt), ferramentas: [], fala: true,
          }),
        );
      }
      bolha.ferramentas = (r.ferramentas as FerramentaLinha[]) ?? bolha.ferramentas;
      /* v3.18: fontes (T004) e custo (T018) chegam no `fim` — a tela mostra e o histórico confirma */
      if (Array.isArray(r.fontes)) bolha.fontes = (r.fontes as string[]).map(String);
      if (r.custo && typeof r.custo === "object") bolha.custo = r.custo as Record<string, unknown>;
      /* v3.23: no reanexar sem stream as telas vêm no `fim` (nunca some o card) */
      if (Array.isArray(r.telas) && r.telas.length) bolha.telas = r.telas as Tela[];
      if (Array.isArray(r.anexos) && r.anexos.length) bolha.anexos = r.anexos as AnexoArquivo[];
      /* v3.19: quem respondeu */
      if (r.provedor) bolha.provedor = String(r.provedor);
      if (r.modelo) bolha.modelo = String(r.modelo);
      bolha.when = new Date().toISOString();
      bolha.aviso = (r.aviso as string) ?? null;
      bolha.compacto = (r.compacto as string) ?? undefined;
      /* v3.73 (T054): o retrato do contexto deste envio alimenta a barra do compositor */
      c.contexto = retratoDoCusto(r.custo) ?? c.contexto;
      bolha.escrevendo = false;
      bolha.falha = Boolean(erro);
    }
  } catch (e) {
    const bolha = c.msgs.find((m) => m.id === vivoId);
    if (bolha) {
      bolha.escrevendo = false;
      bolha.falha = true;
      bolha.texto = "não consegui responder: " + (e as Error).message;
    }
  } finally {
    c.rodando = false;
    c.inicio = 0;
    c.vivo = "";
    c.tarefaId = "";
    c.parando = false;
    notifica(chave);
  }
}

/** dispara a próxima da fila quando estiver livre */
async function bombeia(chave: string, memoria: string, tenant: string | undefined, transportar: Transportar): Promise<void> {
  const c = pega(chave);
  if (c.rodando) return;
  const item = c.fila.shift();
  if (!item) {
    notifica(chave);
    return;
  }
  c.rodando = true;
  c.inicio = Date.now();
  const alvo = c.msgs.find((m) => m.id === item.id);
  if (alvo) alvo.naFila = false;
  notifica(chave);

  const vivoId = proximoId();
  c.vivo = vivoId;
  c.msgs.push({ id: vivoId, papel: "assistant", texto: "", ferramentas: [], escrevendo: true, when: new Date().toISOString(), inicio: Date.now() });
  let bruto = "";
  let falou = false; // se os balões chegaram pelo stream, o `fim` nao re-insere (nem duplica)
  /* caixa mutável: o evento `fim` escreve aqui por dentro do closure */
  const caixa: { dados: Record<string, unknown> | null } = { dados: null };
  let erro = "";
  try {
    const saida = await transportar(
      { pergunta: item.texto, memoria, ...(tenant ? { tenant } : {}), ...(item.imagens?.length ? { imagens: item.imagens } : {}),
        ...(item.arquivos?.length ? { anexos: item.arquivos } : {}), ...getSelecao(chave) },
      (e) => {
      const bolha = c.msgs.find((m) => m.id === vivoId);
      if (!bolha) return;
      if (e.tipo === "delta") {
        bruto += String(e.texto ?? "");
        bolha.texto = bruto;
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
      } else if (e.tipo === "raciocinio") {
        bolha.raciocinio = (bolha.raciocinio ?? "") + String(e.texto ?? "");
        if (bolha.raciocinioInicio === undefined) bolha.raciocinioInicio = Math.max(0, Date.now() - c.inicio);
        acrescentarPensamento(bolha, String(e.texto ?? ""));
      } else if (e.tipo === "narracao_viva") {
        /* v3.72: a letra nasce NA TRILHA — dentro do rastro, nunca na bolha */
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
        acrescentarNarracaoViva(bolha, String(e.texto ?? ""), Math.max(0, Date.now() - c.inicio));
      } else if (e.tipo === "mover_resposta") {
        /* v3.72: a rodada acabou SEM chamar ferramenta — o texto escrito na trilha é a
           resposta: sai da trilha e vira a bolha, uma vez só */
        const txt = moverNarracaoParaBolha(bolha) || String(e.texto ?? "");
        if (txt) { bruto += txt; bolha.texto = bruto; }
        descartarNarracaoViva(bolha);
      } else if (e.tipo === "fala_fim") {
        descartarNarracaoViva(bolha);
      } else if (e.tipo === "fala") {
        /* a rodada chamou ferramenta e falou no caminho: a linha já está viva na trilha
           (v3.72) — aqui ela só fecha com o texto definitivo. A bolha não é tocada. */
        const txt = String(e.texto ?? "");
        if (txt) {
          falou = true;
          if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
          fecharPensamento(bolha);
          if (!fecharNarracaoViva(bolha, txt, Math.max(0, Date.now() - c.inicio))) {
            acrescentar(bolha, { tipo: "narracao", texto: txt, em: Math.max(0, Date.now() - c.inicio) });
          }
        }
      } else if (e.tipo === "guarda") {
        /* v3.74 (T056/T057): o guarda do laço falou — linha na trilha, no ponto em que foi */
        const txt = String(e.texto ?? "");
        if (txt) {
          fecharPensamento(bolha);
          acrescentar(bolha, { tipo: "guarda", texto: txt, em: Math.max(0, Date.now() - c.inicio) });
        }
      } else if (e.tipo === "descartar") {
        bruto = "";
        bolha.texto = "";
      } else if (e.tipo === "ferramenta_inicio") {
        /* v3.34: a linha nasce quando a ferramenta COMEÇA ("Consultando X… Ns") e é fechada no
           evento de fim — a trilha não fica parada enquanto a ferramenta roda */
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
        acrescentar(bolha, {
          tipo: "ferramenta", servidor: "?", nome: String(e.nome), ok: true, ms: 0,
          vivo: true, inicio: Date.now(), em: Math.max(0, Date.now() - c.inicio),
        });
      } else if (e.tipo === "ferramenta") {
        if (bolha.raciocinio && bolha.raciocinioFim === undefined) bolha.raciocinioFim = Math.max(0, Date.now() - c.inicio);
        fecharPensamento(bolha);
        const servidor = String(e.servidor);
        const nome = String(e.nome);
        const ok = Boolean(e.ok);
        const ms = Number(e.ms);
        if (!fecharFerramenta(bolha, servidor, nome, ok, ms)) {
          acrescentar(bolha, { tipo: "ferramenta", servidor, nome, ok, ms, em: Math.max(0, Date.now() - c.inicio) });
        }
        bolha.ferramentas.push({ servidor, nome, ok, ms, args: {}, resumo: "" });
      } else if (e.tipo === "tela") {
        /* v3.23: a tela chega pronta — o card entra na bolha sem esperar o fim */
        (bolha.telas ??= []).push(e.tela);
      } else if (e.tipo === "anexo") {
        /* v3.44: print/arquivo da máquina entra na bolha na hora */
        (bolha.anexos ??= []).push(e.anexo);
      } else if (e.tipo === "codigo") {
        /* v3.24: o código da tela nasce letra por letra (pedido do dono) */
        bolha.codigo = (bolha.codigo ?? "") + String(e.texto ?? "");
      } else if (e.tipo === "fim") {
        caixa.dados = e.dados;
      } else if (e.tipo === "erro") {
        erro = String(e.detalhe ?? "o chat falhou");
      }
      notifica(chave);
    });
    const bolha = c.msgs.find((m) => m.id === vivoId);
    if (bolha) {
      const r = caixa.dados ?? saida ?? { resposta: bruto, ferramentas: [] };
      bolha.texto = erro ? "não consegui responder: " + erro : String(r.resposta ?? bruto);
      if (!bolha.raciocinio && r.raciocinio) bolha.raciocinio = String(r.raciocinio);
      /* v3.34: o tempo do cabeçalho é o do TURNO medido pelo servidor, não a soma dos trechos */
      const msTurno = Number(r.ms ?? 0);
      if (Number.isFinite(msTurno) && msTurno > 0) bolha.ms = msTurno;
      fecharPensamento(bolha);
      /* v3.15: a trilha do servidor manda (tem o tempo medido de cada passo) */
      const trilhou = adotarRastro(bolha, r);
      /* servidor sem stream (ou reanexar de tarefa): as falas vêm no remanescente do `fim`
         e ainda viram balão quando não existe trilha que as hospede */
      const fl = Array.isArray(r.falas) ? (r.falas as string[]) : [];
      if (fl.length && !falou && !trilhou) {
        const idx = c.msgs.findIndex((m) => m.id === vivoId);
        fl.forEach((txt, k) =>
          c.msgs.splice(idx < 0 ? c.msgs.length : idx + k, 0, {
            id: vivoId + "f" + k, papel: "assistant", texto: String(txt), ferramentas: [], fala: true,
          }),
        );
      }
      bolha.ferramentas = (r.ferramentas as FerramentaLinha[]) ?? bolha.ferramentas;
      /* v3.18: fontes (T004) e custo (T018) chegam no `fim` — a tela mostra e o histórico confirma */
      if (Array.isArray(r.fontes)) bolha.fontes = (r.fontes as string[]).map(String);
      if (r.custo && typeof r.custo === "object") bolha.custo = r.custo as Record<string, unknown>;
      /* v3.23: no reanexar sem stream as telas vêm no `fim` (nunca some o card) */
      if (Array.isArray(r.telas) && r.telas.length) bolha.telas = r.telas as Tela[];
      if (Array.isArray(r.anexos) && r.anexos.length) bolha.anexos = r.anexos as AnexoArquivo[];
      /* v3.19: quem respondeu */
      if (r.provedor) bolha.provedor = String(r.provedor);
      if (r.modelo) bolha.modelo = String(r.modelo);
      bolha.when = new Date().toISOString();
      bolha.aviso = (r.aviso as string) ?? null;
      /* quem desenha o aviso da compactação é a tela; o transporte entrega a linha pronta */
      bolha.compacto = (r.compacto as string) ?? undefined;
      /* v3.73 (T054): o retrato do contexto deste envio alimenta a barra do compositor */
      c.contexto = retratoDoCusto(r.custo) ?? c.contexto;
      bolha.escrevendo = false;
      bolha.falha = Boolean(erro);
    }
  } catch (e) {
    const bolha = c.msgs.find((m) => m.id === vivoId);
    if (bolha) {
      bolha.escrevendo = false;
      bolha.falha = true;
      bolha.texto = "não consegui responder: " + (e as Error).message;
    }
  } finally {
    c.rodando = false;
    c.inicio = 0;
    c.vivo = "";
    c.tarefaId = "";
    c.parando = false;
    notifica(chave);
    if (c.fila.length) void bombeia(chave, memoria, tenant, transportar);
  }
}
