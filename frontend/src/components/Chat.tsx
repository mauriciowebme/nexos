import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErro, blobUrl, del, get, getStream, post, postStream, qs, subirAnexo, cortarStreams, temFluxoAssistindo } from "../services/api";
import { useToast } from "./Toast";
import { mdParaHtml } from "../lib/md";
import { TelaGerada } from "./TelaGerada";
import {
  apararAteSid,
  assinar,
  cancelar,
  chaveConversa,
  definirSelecao,
  descartarUltimos,
  pedirParada,
  registrarTarefa,
  estado,
  getSelecao,
  enviar as enviarNaConversa,
  type AnexoArquivo,
  type AnexoImagem,
  limpar as limparConversa,
  reativar,
  semear,
  type Estado,
  type EventoTransporte,
  type FerramentaLinha,
  type Linha,
  type SegmentoRastro,
  type Transportar, tarefaViva, falarNoTurno, type AnexoEnviado, type RetratoContexto, velocidadeDoCusto } from "../lib/conversa";
import type { ChatHistorico, Compactacao, ProviderResp, Provedor } from "../types";

/** v3.73: número no jeito brasileiro (18.400), porque o do medidor é lido por gente. */
const numBR = (n: number): string => new Intl.NumberFormat("pt-BR").format(Math.round(n));

/** v3.73 (T055): segundo com decimal brasileiro (1,8 s) — "2 s" escondia o que importava. */
const segBR = (ms: number): string => {
  const s = ms / 1000;
  return s < 10 ? String(s.toFixed(1).replace(".", ",")) : String(Math.round(s));
};

/** v3.73.1 (T055): a VELOCIDADE mora na linha de custo da bolha, não só no cabeçalho do rastro.
 *  Motivo medido: resposta sem ferramenta não tem trilha (`rastro: []` no banco), o bloco do
 *  rastro não é renderizado e o número nunca era lido. O `custo` viaja na mensagem, então o
 *  selo também aparece em conversa reaberta. */
const velocidadeTexto = (custo: unknown): string => {
  const v = velocidadeDoCusto(custo);
  if (!v) return "";
  return ` · ${segBR(v.ateLetraMs)}s até a 1ª letra · ${String(v.tokS).replace(".", ",")} tok/s`;
};
const velocidadeTitulo = (custo: unknown): string => {
  const v = velocidadeDoCusto(custo);
  if (!v) return "";
  return (
    ` · escrita: ${v.tokEscrita} tok em ${segBR(v.escritaMs)}s` +
    " (a janela de escrita não inclui espera de ferramenta; contagem chars ÷ 4)"
  );
};

/* ------------------------------------------------------------------ medidor de contexto (v3.73 / T054) */

/** A barra do piso: quanto do teto o ÚLTIMO envio usou (anel na porcentagem) e, ao clicar,
 *  para onde foi o contexto — prompt de sistema, conversa e ferramentas, na mesma régua que
 *  corta o payload. Só aparece com os DOIS números (usado e teto): sem um deles, nada de meia
 *  verdade na tela. O `~` e a origem de cada número são consequência da régua, não decoração. */
function MedidorContexto({ ctx }: { ctx: RetratoContexto }) {
  const [aberto, setAberto] = useState(false);
  const frac = Math.min(1, ctx.tokens / Math.max(1, ctx.disponivel));
  const circ = 2 * Math.PI * 6.5;
  const d = ctx.detalhe;
  const soma = Math.max(1, d.prompt + d.conversa + d.ferramentas);
  const aprox = ctx.estimado ? "~" : "";
  const regua = ctx.origem_contagem === "provedor" ? "contagem do provedor" : "estimativa (chars ÷ 4)";
  const teto =
    ctx.origem_janela === "configurada"
      ? "janela configurada"
      : ctx.origem_janela === "detectada"
        ? "janela detectada"
        : ctx.origem_janela || "janela";
  return (
    <div className={"chat-contexto" + (frac >= 0.9 ? " chat-contexto-cheio" : "")} data-testid="contextoMedidor">
      <button
        type="button"
        className="chat-contexto-linha"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        data-testid="contextoLinha"
        title={`${numBR(ctx.tokens)} de ${numBR(ctx.disponivel)} tokens · janela ${numBR(ctx.janela)} · reserva de saída ${numBR(ctx.reserva)} · ${regua}`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" className="fill-none stroke-borda" strokeWidth={2.5} />
          <circle
            cx="8"
            cy="8"
            r="6.5"
            className={"fill-none " + (frac >= 0.9 ? "stroke-vermelho" : "stroke-azul")}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={`${(frac * circ).toFixed(2)} ${circ.toFixed(2)}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span className="chat-contexto-num" data-testid="contextoNumeros">
          {aprox}
          {numBR(ctx.tokens)} <span className="chat-contexto-teto">/ {aprox}{numBR(ctx.disponivel)} tokens</span>
        </span>
        <span className="chat-contexto-pct" data-testid="contextoPct">{Math.round(frac * 100)}%</span>
        <span className="chat-contexto-fonte" data-testid="contextoOrigem">{regua} · teto {teto}</span>
        <span className="ml-auto">{aberto ? "▴" : "▾"}</span>
      </button>
      {aberto && (
        <div className="chat-contexto-detalhe" data-testid="contextoDetalhe">
          <div className="chat-contexto-barra" role="img" aria-label={`prompt ${numBR(d.prompt)}, conversa ${numBR(d.conversa)}, ferramentas ${numBR(d.ferramentas)} tokens`}>
            <i className="chat-contexto-fatia chat-contexto-prompt" style={{ width: `${(d.prompt / soma) * 100}%` }} />
            <i className="chat-contexto-fatia chat-contexto-conversa" style={{ width: `${(d.conversa / soma) * 100}%` }} />
            <i className="chat-contexto-fatia chat-contexto-ferramentas" style={{ width: `${(d.ferramentas / soma) * 100}%` }} />
          </div>
          <ul className="chat-contexto-lista">
            <li><i className="chat-contexto-ponto chat-contexto-prompt" />prompt de sistema — <b>{numBR(d.prompt)}</b> tok</li>
            <li><i className="chat-contexto-ponto chat-contexto-conversa" />conversa (histórico + pergunta) — <b>{numBR(d.conversa)}</b> tok</li>
            <li><i className="chat-contexto-ponto chat-contexto-ferramentas" />ferramentas — <b>{numBR(d.ferramentas)}</b> tok</li>
          </ul>
          <p className="chat-contexto-nota">
            {ctx.origem_contagem === "provedor"
              ? "o total é a contagem real do provedor; as fatias são a nossa régua ajustada proporcionalmente (o provedor não manda a partição)"
              : "número estimado com a mesma régua que corta o payload (chars ÷ 4) — o provedor não devolveu contagem nesta chamada"}
            {" · "}o teto já desconta a reserva de {numBR(ctx.reserva)} tok para a resposta
          </p>
        </div>
      )}
    </div>
  );
}

/** linha de status da tarefa viva (GET /chat/tarefas e GET /chat/tarefa/:id) */
type TarefaStatus = { id: string; pergunta?: string; status: string; parcial: string; ferramentas?: unknown[]; telas?: unknown[]; aviso?: string | null };

/** v3.3: lê o stream de uma tarefa no servidor, RELIGANDO em queda de rede (até 3×, backoff).
 *  Queda de conexão ≠ falha: a tarefa vive no servidor; se o stream quebrar, consulta o
 *  estado e reanexa. Devolve os dados do `fim` (ou reconstrói do GET se terminou no vão). */
/** v3.39.2: `tenant` é OBRIGATÓRIO na leitura quando o POST mandou um — a tarefa nasce
 *  com o tenant do foco (operador) e `verTarefa` filtra por ele; sem o parâmetro o servidor
 *  resolve o tenant do usuário, não acha a linha e devolve 404 "tarefa não encontrada"
 *  (a resposta existe e aparece no refresh — o defeito era só na leitura). */
async function bombearTarefa(
  id: string,
  onEvent: (e: EventoTransporte) => void,
  tenant?: string,
): Promise<Record<string, unknown> | null> {
  const busca = tenant ? "?" + qs({ tenant }) : "";
  let dados: Record<string, unknown> | null = null;
  /* v3.68: a contagem de tentativas é de FALHAS SEGUIDAS sem sinal de vida. Antes, cada
     vez que a aba voltava de segundo plano e a tela cortava o stream para revalidar o
     status gastava uma tentativa — 4 idas e vindas matavam o turno com "sem conexão"
     mesmo com o servidor respondendo. Stream que entregou evento = conexão saudável. */
  let seguidas = 0;
  for (;;) {
    let recebeu = false;
    try {
      await getStream(`/chat/tarefa/${id}/stream${busca}`, (e) => {
        recebeu = true;
        if (e.tipo === "fim") dados = e.dados as Record<string, unknown>;
        onEvent(e as EventoTransporte);
      });
      return dados; // stream fechou de verdade (fim, erro ou corrida tratada no servidor)
    } catch (e) {
      if (e instanceof ApiErro && e.status === 404) throw e; // tarefa sumiu: não tem o que religar
      /* rede/proxy caiu no meio: perguntar ao servidor o que houve, sem confiar no stream */
      let t: TarefaStatus | null = null;
      try {
        t = await get<TarefaStatus>(`/chat/tarefa/${id}${busca}`);
      } catch {
        /* servidor inacessível também: tratar como rodando e tentar de novo */
      }
      if (t && t.status !== "rodando") {
        if (t.status === "terminou") return { resposta: t.parcial, ferramentas: t.ferramentas ?? [], telas: t.telas ?? [], aviso: t.aviso ?? null };
        throw new ApiErro(0, t.aviso || "a tarefa falhou");
      }
      /* servidor respondeu o status (ou o stream entregou vida) = conexão saudável:
         o corte foi nosso (volta de aba) ou do vigia — reata sem gastar orçamento.
         Orçamento é só para SERVIDOR INALCANÇÁVEL de verdade. */
      if (recebeu || t) seguidas = 0;
      else if (++seguidas > 3) throw new ApiErro(0, "sem conexão com o servidor");
      await new Promise((r) => setTimeout(r, 500 * 2 ** Math.min(seguidas, 3)));
      if (t) onEvent({ tipo: "parcial", texto: t.parcial }); // ressincroniza a base antes de reanexar
    }
  }
}

/** traduz o que a compactação fez em uma linha honesta (nada de "resumido por IA") */
function textoCompacto(c?: Compactacao | null): string | undefined {
  if (!c) return undefined;
  const partes: string[] = [];
  if (c.resumidas) partes.push(`${c.resumidas} mensagem(ns) antigas viraram 1 linha`);
  if (c.aparadas) partes.push(`${c.aparadas} resultado(s) de ferramenta cortado(s)`);
  if (c.descartadas) partes.push(`${c.descartadas} descartada(s) do mais antigo`);
  if (!c.coube) partes.push("nem assim coube: enviou só instruções + pergunta");
  if (!partes.length) return undefined;
  return `histórico compactado: ${partes.join(" · ")} · ${c.tokens}/${c.disponivel} tokens (${c.origem_janela})`;
}

/* ------------------------------------------------------------------ rastro do turno (v3.15) */

const RASTRO_CHAVE = "nexos:rastro-expandido";

/* v3.22 (preview aprovado): exemplos do estado vazio — textos literais da maquete aprovada.
   O clique preenche o campo com o `t`; o `sub` é só a legenda do chip. */
const EXEMPLOS_VAZIO = [
  { t: "o que anotei sobre o Nexos essa semana?", sub: "busca na memória" },
  { t: "as decisões que tomamos sobre provider", sub: "resumo de decisões" },
  { t: "resuma a conversa de ontem com o cliente", sub: "resumo de conversa" },
  { t: "quais pendências ficaram abertas?", sub: "check de pendências" },
] as const;

/* As ferramentas internas do nexos têm nome em inglês no MCP; a linha do rastro fala como a
   tela (o jeito do IA_GO, que tem mapa de rótulos). Ferramenta de servidor externo mantém o
   nome que o servidor deu — inventar rótulo alheio seria mentira. */
const ROTULOS_FERRAMENTA: Record<string, string> = {
  health: "a saúde do servidor",
  search: "a busca semântica",
  ingest: "a ingestão",
  ingest_status: "o estado da ingestão",
  list_docs: "os documentos",
  delete_doc: "apagar documento",
  upload_file: "subir arquivo",
  get_file: "baixar arquivo",
  edit_doc: "editar documento",
  rename_doc: "renomear documento",
  archive_doc: "arquivar documento",
  list_gavetas: "as gavetas",
  create_gaveta: "criar gaveta",
  delete_gaveta: "apagar gaveta",
  chat: "o chat",
  listar_usuarios: "os usuários",
  criar_usuario: "criar usuário",
  apagar_usuario: "apagar usuário",
  esquecimento: "o esquecimento",
  config_provider: "a configuração do modelo",
  web_search: "a busca na web",
  web_open: "a leitura da página",
  /* v3.41 — ferramentas de máquina: sem entrada aqui o rastro imprimia o nome cru do MCP
     ("Consultando rodar_comando"), único lugar da tela em snake_case. */
  listar_arquivos: "os arquivos da máquina",
  ler_arquivo: "o arquivo na máquina",
  escrever_arquivo: "o arquivo na máquina",
  buscar_arquivos: "arquivos na máquina",
  grep_remoto: "o texto nos arquivos",
  editar_no_local: "a edição no arquivo",
  estado_maquina: "o estado da máquina",
  processos: "os processos",
  janelas: "as janelas",
  area_transferencia: "a área de transferência",
  falar: "a fala na máquina",
  abrir: "a abertura na máquina",
  servicos: "os serviços",
  eventos: "os eventos",
  rede: "a rede da máquina",
  esperar_arquivo: "o arquivo esperado",
  power: "a energia da máquina",
  rodar_lote: "o lote de comandos",
  sessao: "a sessão de pasta",
  git_remoto: "o git na máquina",
  metricas: "as métricas da máquina",
  gerar_pareamento: "o pareamento da máquina",
  maquinas_online: "as máquinas online",
  analisar_imagem: "a imagem",
};

/* v3.41 — o verbo diz o que a ferramenta FAZ. "Consultando" em tudo era mentira em
   escrever_arquivo, rodar_comando e nas de apagar. */
const VERBO_FERRAMENTA: Record<string, string> = {
  escrever_arquivo: "Escrevendo", editar_no_local: "Editando", edit_doc: "Editando",
  upload_file: "Enviando", ingest: "Ingerindo", create_gaveta: "Criando",
  criar_usuario: "Criando", gerar_pareamento: "Gerando",
  delete_doc: "Apagando", delete_gaveta: "Apagando", apagar_usuario: "Apagando",
  rodar_comando: "Rodando", rodar_lote: "Rodando", abrir: "Abrindo", falar: "Falando",
  power: "Ligando/desligando", git_remoto: "Rodando", esperar_arquivo: "Esperando",
  config_provider: "Configurando", rename_doc: "Renomeando", archive_doc: "Arquivando",
  search: "Buscando", web_search: "Buscando", buscar_arquivos: "Buscando",
  grep_remoto: "Buscando", list_docs: "Listando", list_gavetas: "Listando",
  listar_arquivos: "Listando", listar_usuarios: "Listando", maquinas_online: "Listando",
  processos: "Listando", janelas: "Listando", servicos: "Listando",
  ler_arquivo: "Lendo", get_file: "Baixando", analisar_imagem: "Analisando",
  web_open: "Abrindo",
};

function verboFerramenta(nome: string): string {
  return VERBO_FERRAMENTA[nome] ?? "Consultando";
}

function rotuloFerramenta(s: { servidor: string; nome: string }): string {
  const interno = s.servidor === "nexos" || s.servidor === "minirag" || s.servidor === "?";
  if (interno && ROTULOS_FERRAMENTA[s.nome]) return ROTULOS_FERRAMENTA[s.nome];
  return interno ? s.nome : `${s.servidor} · ${s.nome}`;
}

/** O rastro do turno: a trilha do que aconteceu, na ordem, dentro da mesma bolha — o jeito
 *  do assistente do IA_GO. Narração em cinza, pensamento em roxo com o tempo dele, ferramenta
 *  em azul com o tempo dela. Aberto enquanto o turno vive, recolhido quando acaba; a escolha
 *  do usuário vale para todas as mensagens. A resposta final não entra aqui: ela é a bolha. */
function Rastro({
  segmentos,
  vivo,
  detalhes,
  aberto,
  travado,
  onToggle,
  ms,
  inicio,
  custo,
}: {
  segmentos: SegmentoRastro[];
  vivo: boolean;
  detalhes: FerramentaLinha[];
  aberto: boolean;
  travado?: boolean;
  onToggle: (atual: boolean) => void;
  /** v3.34: duração do turno medida pelo servidor (é o tempo do cabeçalho) */
  ms?: number;
  /** v3.34: quando o turno começou (relógio andando enquanto ele vive) */
  inicio?: number;
  /** v3.73 (T055): o que o turno mediu da ESCRITA (custo do `fim`) — sem medição, nada aparece */
  custo?: Record<string, unknown> | null;
}) {
  const corpo = useRef<HTMLDivElement | null>(null);
  const colado = useRef(true);
  /* v3.34 — CRONOLOGIA: a trilha é ordenada pelo instante em que cada passo aconteceu (`em`),
     nunca pela ordem de chegada. Mensagem antiga, sem `em`, mantém a ordem gravada. */
  /* sem memo: a trilha é MUTADA no lugar (push/Object.assign) enquanto o turno corre, então a
     referência do array não muda e um `useMemo` devolveria a ordem velha. Ordenar 5-30 linhas
     a cada quadro não custa nada. */
  const trilha = segmentos.every((s) => typeof s.em === "number")
    ? [...segmentos].sort((a, b) => (a.em as number) - (b.em as number))
    : segmentos;
  const ultimo = trilha[trilha.length - 1];
  const pensando = vivo && ultimo?.tipo === "pensamento" && ultimo.vivo === true;
  const ferramentando = vivo && trilha.some((s) => s.tipo === "ferramenta" && s.vivo);
  const [ticoque, setTicoque] = useState(0);

  useEffect(() => {
    if (!pensando && !ferramentando) return;
    const t = setInterval(() => setTicoque((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [pensando, ferramentando]);

  /* o pensamento cresce POR DENTRO do bloco, que tem altura própria com rolagem: enquanto
     escreve, o bloco fica colado na última linha que chegou. Se você subir lá dentro para
     reler, ele para de puxar e te deixa em paz. (o defeito que o dono mostrou no celular) */
  useEffect(() => {
    const p = corpo.current;
    if (!p) {
      colado.current = true;
      return;
    }
    if (colado.current && pensando) p.scrollTop = p.scrollHeight;
  });

  const segundosVivos =
    pensando && ultimo?.tipo === "pensamento" && ultimo.inicio
      ? Math.max(0, Math.round((Date.now() - ultimo.inicio) / 1000))
      : 0;
  /* v3.34: o tempo do cabeçalho é o do TURNO (medido pelo servidor ao fechar; relógio andando
     enquanto ele vive). Antes somava só os trechos e anunciava "3s" num turno de 40s. */
  void ticoque; // é o que faz o relógio do bloco ao vivo andar
  /* turno medido pelo servidor > relógio andando > soma dos trechos (mensagem antiga, sem `ms`) */
  const somaMs = trilha.reduce((a, s) => a + ("ms" in s ? s.ms : 0), 0);
  const total = ms && ms > 0
    ? Math.max(1, Math.round(ms / 1000))
    : inicio
      ? Math.max(1, Math.round((Date.now() - inicio) / 1000))
      : Math.max(1, Math.round(somaMs / 1000));
  const posTools = trilha.map((s, i) => (s.tipo === "ferramenta" ? i : -1)).filter((i) => i >= 0);
  /* v3.73 (T055): a escrita medida pelo servidor (só existe no streaming). Sem medição, a
     tela não mostra número nenhum — é melhor vazio do que número inventado. */
  const ateLetra = Math.max(0, Number(custo?.ms_ate_primeira_letra ?? 0));
  const escrita = Math.max(0, Number(custo?.ms_escrita ?? 0));
  const tokS = Number(custo?.tok_s ?? 0);

  return (
    <div className="rastro" data-testid="rastroBloco">
      <button
        type="button"
        className="rastro-cab"
        onClick={() => onToggle(aberto)}
        aria-expanded={aberto}
        data-testid="rastroCab"
        disabled={travado}
        title={
          travado
            ? "aberto enquanto processa — recolhe quando a conclusão começa"
            : aberto
              ? "recolher o rastro do turno"
              : "ver o rastro do turno"
        }
      >
        <span
          data-testid="rastroVelocidade"
          title={
            ateLetra > 0 && escrita > 0
              ? "tempo do turno inteiro · tempo até a primeira letra escrita · velocidade de escrita " +
                "(a janela de escrita não inclui espera de ferramenta)"
              : "tempo do turno inteiro"
          }
        >
          <b>Rastro do turno</b>
          {` · ${trilha.length} etapa${trilha.length === 1 ? "" : "s"} · ${total}s`}
          {/* v3.73 (T055): a contagem de etapas não dizia o que importava — travou antes de
              começar ou escreveu devagar? Só aparece no turno MEDIDO (streaming). */}
          {ateLetra > 0 && escrita > 0 && tokS > 0
            ? ` · ${segBR(ateLetra)}s até a 1ª letra · ${tokS} tok/s`
            : ""}
        </span>
        <span className="ml-auto">{aberto ? "▴" : "▾"}</span>
      </button>

      {aberto ? (
        <div className="rastro-corpo" data-testid="rastroCorpo">
          {trilha.map((s, i) => {
            if (s.tipo === "narracao") {
              /* v3.72: a narração é ESCRITA na trilha. Enquanto a rodada não se denuncia, a
                 linha está viva (ponto pulsando); ao fechar vira fala definitiva. */
              return (
                <div className="rastro-linha rastro-narra" key={`n${i}`} data-testid={s.vivo ? "rastroNarracaoViva" : "rastroNarracao"}>
                  <i className={s.vivo ? "rastro-ponto animate-pulse" : "rastro-ponto"} />
                  <span>{s.texto}{s.vivo ? "▌" : ""}</span>
                </div>
              );
            }
            if (s.tipo === "interrupcao") {
              /* v3.43: a fala da pessoa no MEIO do turno — marcada na trilha, onde chegou */
              return (
                <div className="rastro-linha rastro-interrupcao" key={`i${i}`} data-testid="rastroInterrupcao">
                  <i className="rastro-ponto rastro-ponto-amarelo" />
                  <span>
                    <b>você, no meio:</b> {s.texto}
                  </span>
                </div>
              );
            }
            if (s.tipo === "ferramenta") {
              const d = detalhes[posTools.indexOf(i)] as FerramentaLinha | undefined;
              /* v3.34: linha VIVA — aparece quando a ferramenta começa e conta o tempo dela
                 (antes a linha só nascia no fim e a trilha parecia parada/torta ao vivo) */
              if (s.vivo) {
                const seg = s.inicio ? Math.max(0, Math.round((Date.now() - s.inicio) / 1000)) : 0;
                return (
                  <div className="rastro-linha rastro-tool" key={`f${i}`} data-testid="rastroFerramentaViva">
                    <i className="rastro-ponto rastro-ponto-azul animate-pulse" />
                    <span>{`${verboFerramenta(s.nome)} ${rotuloFerramenta(s)}… ${seg}s`}</span>
                  </div>
                );
              }
              return (
                <div className="rastro-linha rastro-tool" key={`f${i}`} data-testid="rastroFerramenta">
                  <i className="rastro-ponto rastro-ponto-azul" />
                  <details className="rastro-tool-detalhe">
                    <summary>
                      {`${verboFerramenta(s.nome)} ${rotuloFerramenta(s)} · ${Math.max(1, Math.round(s.ms / 1000))}s `}
                      <span className={s.ok ? "txt-ok" : "txt-erro"}>{s.ok ? "✓" : "✕"}</span>
                      {d && (d.resumo || (d.args && Object.keys(d.args as object).length)) ? " · detalhe" : ""}
                    </summary>
                    {d ? (
                      <div className="rastro-tool-info">
                        {d.args && Object.keys(d.args as object).length ? (
                          <div className="mono break-all">{JSON.stringify(d.args)}</div>
                        ) : null}
                        {d.resumo ? <div className="sub2 break-all">{d.resumo}</div> : null}
                      </div>
                    ) : null}
                  </details>
                </div>
              );
            }
            const seg = Math.max(0, Math.round((s.ms || 0) / 1000));
            return (
              <div className="rastro-pensa" key={`p${i}`} data-testid="rastroPensamento">
                <div className="rastro-linha rastro-pensa-cab">
                  <i className="rastro-ponto rastro-ponto-roxo" />
                  <span>{s.vivo ? `Pensando… ${segundosVivos}s` : s.ms > 0 ? `Pensou por ${seg}s` : "Pensou"}</span>
                </div>
                {s.texto ? (
                  <div
                    className="racio-txt rastro-pensa-txt"
                    data-testid="rastroPensaTxt"
                    ref={s.vivo ? corpo : undefined}
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      colado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    }}
                  >
                    {s.texto}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Chat: conversa com o provider; as ferramentas vêm do MCP ligado e ficam registradas na mensagem.
 *  Você pode emendar perguntas: entram na fila e saem uma por vez, na ordem.
 *  v3.0: a conversa mora em `lib/conversa` (fora do React). Você troca de página no painel, vai
 *  olhar a Busca ou outra gaveta, e o que o agente está fazendo NÃO é interrompido por isso —
 *  ao voltar, a bolha está lá, maior, com o tempo certo desde o começo. */

/** v3.44 — arquivo que a máquina mandou. Imagem vira miniatura clicável; o resto vira
 *  cartão com nome e tamanho. O GET leva a chave no header (por isso blob URL). */
function AnexoBolha({ a }: { a: AnexoArquivo }) {
  const [url, setUrl] = useState("");
  const [erro, setErro] = useState("");
  const img = String(a.mime || "").startsWith("image/");
  useEffect(() => {
    let vivo = true;
    let criada = "";
    blobUrl(`/anexos/${a.id}`)
      .then((u) => {
        if (!vivo) { URL.revokeObjectURL(u); return; }
        criada = u;
        setUrl(u);
      })
      .catch((e) => vivo && setErro(String((e as Error)?.message ?? e)));
    return () => {
      vivo = false;
      if (criada) URL.revokeObjectURL(criada);
    };
  }, [a.id]);
  const kb = a.bytes >= 1048576 ? `${(a.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.bytes / 1024))} KB`;
  const baixarAgora = () => {
    if (!url) return;
    const el = document.createElement("a");
    el.href = url;
    el.download = a.nome;
    el.click();
  };
  return (
    <div className="chat-arquivo">
      {img && url ? (
        <img src={url} alt={a.nome} className="chat-arquivo-img" onClick={() => window.open(url, "_blank")} />
      ) : null}
      <div className="chat-arquivo-rodape">
        <span className="chat-arquivo-nome" title={a.nome}>{a.nome}</span>
        <span className="sub2">{kb}</span>
        <button className="btn btn-mini" onClick={baixarAgora} disabled={!url} title="baixar o arquivo">
          baixar
        </button>
      </div>
      {erro ? <span className="sub2">anexo indisponível: {erro}</span> : null}
    </div>
  );
}

export function Chat({
  escopo,
  operador,
  provider,
  onProviderConfirmado,
  onIrConfig,
  onAbrirMenu,
}: {
  escopo: { tenant: string; memoria: string };
  operador: boolean;
  /** v3.16: o provider (e o modelo em uso) agora é buscado pelo App e mostrado na
   * lateral; o Chat recebe por props — a pílula do topo saiu de cena. */
  provider: ProviderResp | null;
  /** uma resposta que chegou é prova de que o provider está vivo mesmo se o fetch
   * pegou "não configurado" (o dono ligou o provider depois do login). */
  onProviderConfirmado: () => void;
  onIrConfig: () => void;
  onAbrirMenu: () => void;
}) {
  const { toast } = useToast();
  const [memoria, setMemoria] = useState(escopo.memoria);
  const [pergunta, setPergunta] = useState("");
  const [espera, setEspera] = useState(0);
  /* rolagem respeitando quem manda: a tela SÓ desce sozinha se você já estiver no fim.
     (antes descia a cada tique do cronômetro e não deixava ler a resposta nem digitar) */
  const area = useRef<HTMLDivElement>(null);
  const campoRef = useRef<HTMLTextAreaElement>(null);
  /* v3.41 — imagens coladas (Ctrl+V) no campo: vão junto com a pergunta e o modelo VÊ a imagem.
     Sem texto, a pergunta vira "Analise a imagem que colei." para o turno nunca ir vazio. */
  const [anexos, setAnexos] = useState<AnexoImagem[]>([]);
  /* v3.46 — arquivos grandes: sobem em blocos para o servidor e só o id viaja na mensagem */
  const [arquivos, setArquivos] = useState<AnexoEnviado[]>([]);
  const [subindo, setSubindo] = useState<{ nome: string; pct: number } | null>(null);
  /** v3.48 (T049) — UM seletor só: imagem pequena vai inline (o modelo vê), o resto vai por upload */
  const arquivoRef = useRef<HTMLInputElement>(null);
  const colado = useRef(true);
  /* v3.39.4: marca que o PRÓXIMO evento de scroll foi disparado por nós (irParaOFim).
     Sem isso, o próprio scroll programático era lido como "o usuário saiu do fim" e
     desligava o acompanhamento — era o "pedacinho que não desce" no meio do streaming. */
  const programando = useRef(false);
  const [noFundo, setNoFundo] = useState(true);
  const [novoAbaixo, setNovoAbaixo] = useState(false);
  /* ---------------- v3.18: edição de pergunta, ditado por voz, rascunho por gaveta ---------------- */
  const [editando, setEditando] = useState<number | null>(null); // sid da pergunta que está sendo editada
  const [ditando, setDitando] = useState(false);
  /* v3.31.1 (dono, 27/10): o popover "⚙ ferramentas" guarda provider/modelo e exportar;
     no piso ficam engrenagem, "nova conversa", campo, mic e enviar. */
  const [ajustesAberto, setAjustesAberto] = useState(false);
  const ajustesRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ajustesAberto) return;
    const fora = (e: MouseEvent | TouchEvent) => {
      if (ajustesRef.current && !ajustesRef.current.contains(e.target as Node)) setAjustesAberto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAjustesAberto(false);
    };
    document.addEventListener("mousedown", fora);
    document.addEventListener("touchstart", fora);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("touchstart", fora);
      document.removeEventListener("keydown", tecla);
    };
  }, [ajustesAberto]);
  const recRef = useRef<{ stop(): void } | null>(null);
  /* T014: trocar de gaveta não mata o texto que você começou a digitar na outra */
  const rascunhos = useRef(new Map<string, string>());
  const perguntaRef = useRef(pergunta);
  perguntaRef.current = pergunta;
  /* v3.15: abrir/recolher o rastro é preferência do usuário e vale para TODAS as mensagens
     (o jeito do IA_GO). Sem escolha ainda: aberto enquanto o turno vive, recolhido no fim. */
  const [rastroPref, setRastroPref] = useState<"1" | "0" | null>(
    () => (localStorage.getItem(RASTRO_CHAVE) === "1" ? "1" : localStorage.getItem(RASTRO_CHAVE) === "0" ? "0" : null),
  );
  /* v3.28 (dono, 27/10): o rastro fica SEMPRE aberto até a CONCLUSÃO começar — isto é,
     enquanto o turno processa e ainda não há nada produzido. Quando a resposta começa
     a ser escrita, vale a preferência do usuário (aberto/recolhido) em todas as mensagens.
     v3.30.2 (dono, 27/10): a tela gerada É conclusão — o rastro fecha assim que o código
     da tela começa a aparecer (senão a caixa parecia mais um passo do rastro). */
  const emProcesso = (vivo: boolean, texto: string, produzindo?: boolean) =>
    vivo && !texto.trim() && !produzindo;
  const rastroAberto = (vivo: boolean, texto: string, produzindo?: boolean) =>
    emProcesso(vivo, texto, produzindo) ? true : rastroPref === "1";
  /* "já tem produto na tela" = o código da tela começou a nascer ou a tela está pronta */
  const produzindo = (m: { codigo?: string; telas?: unknown[] }) =>
    Boolean(m.codigo && m.codigo.length) || Boolean(m.telas && m.telas.length);
  function alternarRastro(atual: boolean) {
    const novo = atual ? "0" : "1";
    localStorage.setItem(RASTRO_CHAVE, novo);
    setRastroPref(novo);
  }

  const tenantParam = operador && escopo.tenant ? escopo.tenant : undefined;
  const chave = chaveConversa(escopo.tenant, memoria);
  const [snap, setSnap] = useState<Estado>(() => estado(chave));
  /* v3.19: o usuário escolhe qual provedor (e qual modelo) responde esta conversa */
  const [provedores, setProvedores] = useState<Provedor[]>([]);
  const [sel, setSel] = useState<{ provedor: string; modelo: string }>(() => getSelecao(chave));

  useEffect(() => {
    setSel(getSelecao(chave));
  }, [chave]);
  useEffect(() => {
    let vivo = true;
    get<{ provedores: Provedor[] }>("/provedores")
      .then((r) => {
        if (vivo) setProvedores(r.provedores);
      })
      .catch(() => {
        /* sem provedores cadastrados: a régua nem aparece */
      });
    return () => {
      vivo = false;
    };
  }, []);
  const mudarSelecao = (s: { provedor: string; modelo: string }) => {
    setSel(s);
    definirSelecao(chave, s);
  };
  const selProvedor = provedores.find((x) => x.ativo && x.nome === sel.provedor);
  /* v3.60: o padrão que esta conta enxerga. Desde v3.67.2 ele é o VALOR mostrado no
     seletor quando a conversa não fixou ninguém (a linha "automático" saiu da lista). */
  const padraoNome =
    provedores.find((x) => x.padrao && x.ativo)?.nome ??
    (provedores.filter((x) => x.ativo).length === 1 ? provedores.filter((x) => x.ativo)[0].nome : "");
  /* v3.60: escolha gravada no navegador que não existe mais (provedor desligado/apagado ou
     modelo fora da lista) volta ao automático — senão o chat abre preso num alvo fantasma. */
  useEffect(() => {
    if (!provedores.length || !sel.provedor) return;
    const p = provedores.find((x) => x.ativo && x.nome === sel.provedor);
    if (!p) {
      mudarSelecao({ provedor: "", modelo: "" });
      return;
    }
    if (sel.modelo) {
      const modelos = p.modelos.length ? p.modelos : [p.modelo];
      if (!modelos.includes(sel.modelo)) mudarSelecao({ provedor: p.nome, modelo: "" });
    }
  }, [provedores, sel.provedor, sel.modelo]);

  useEffect(() => {
    setMemoria(escopo.memoria);
  }, [escopo.memoria]);

  /* a tela é só uma janela para a conversa: assina, mostra, e pode fechar sem matar o trabalho */
  useEffect(() => {
    const gritar = () => setSnap(estado(chave));
    gritar();
    return assinar(chave, gritar);
  }, [chave]);

  /* v3.16: a busca de gavetas e provider saiu daqui — vive no App (dono da lateral,
     onde o contexto da conversa passou a ser mostrado). O Chat recebe provider por props. */

  const carregarHistorico = useCallback(async () => {
    try {
      const h = await get<ChatHistorico>("/chat?" + qs({ memoria, ...(tenantParam ? { tenant: tenantParam } : {}) }));
      const linhas: Linha[] = [];
      for (const m of h.mensagens) {
        const trilha = (m.rastro ?? []) as SegmentoRastro[];
        /* v.8: as falas de caminho voltam como balões próprios na ordem em que foram escritas —
           a conversa fica corrida também depois de recarregar a página. Quando a mensagem já tem
           rastro (v3.15), a fala vive DENTRO da trilha: soltar balão duplicaria o mesmo texto. */
        if (!trilha.length) for (const [k, ft] of (m.falas ?? []).entries())
          linhas.push({ id: `h${m.id}f${k}`, papel: "assistant", texto: String(ft), ferramentas: [], fala: true });
        /* v3.13: o raciocínio gravado volta recolhido — "Pensou" clicável, como no Open WebUI */
        linhas.push({
          id: `h${m.id}`, papel: m.papel as "user" | "assistant", texto: m.texto,
          ferramentas: m.ferramentas ?? [],
          /* v3.18: sid (âncora do editar/reenviar), hora, fontes e custo voltam com a linha */
          sid: Number(m.id),
          when: String(m.quando ?? ""),
          ...(trilha.length ? { rastro: trilha } : {}),
          ...(m.raciocinio ? { raciocinio: String(m.raciocinio) } : {}),
          ...(Array.isArray(m.fontes) && m.fontes.length ? { fontes: m.fontes.map(String) } : {}),
          ...(m.custo ? { custo: m.custo as Record<string, unknown> } : {}),
          /* v3.34.1: o tempo do TURNO fica gravado no custo da mensagem — reabrir a conversa
             mantem o mesmo numero do cabeçalho (antes caia na soma dos trechos) */
          ...(Number((m.custo as Record<string, unknown> | null | undefined)?.ms ?? 0) > 0
            ? { ms: Number((m.custo as Record<string, unknown>).ms) }
            : {}),
          ...(m.provedor ? { provedor: String(m.provedor) } : {}),
          ...(m.modelo ? { modelo: String(m.modelo) } : {}),
          /* v3.23: o card da tela gerada volta ao reabrir a conversa */
          ...(Array.isArray(m.telas) && m.telas.length ? { telas: m.telas } : {}),
        });
      }
      semear(chave, linhas);
    } catch (e) {
      toast("histórico: " + (e as Error).message, "erro");
    }
    /* v3.3: fechou a aba no meio e voltou? A tarefa viva do servidor entra na tela
       (pergunta empurrada + bolha escrevendo desde o parcial, religando sozinha).
       Em servidor antigo a rota não existe: silencia, o histórico acima já valeu. */
    try {
      const tv = await get<{ tarefas: TarefaStatus[] }>(
        "/chat/tarefas?" + qs({ memoria, ...(tenantParam ? { tenant: tenantParam } : {}) }),
      );
      const viva = (tv.tarefas ?? [])[0];
      if (viva) {
        void reativar(
          chave,
          { id: String(viva.id), pergunta: String(viva.pergunta ?? ""), parcial: String(viva.parcial ?? "") },
          (id, ev) => bombearTarefa(id, ev, tenantParam),
        );
      }
    } catch {
      /* servidor antigo ou rede caída agora: nada a readotar */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave, memoria, tenantParam, toast]);

  useEffect(() => {
    void carregarHistorico();
  }, [carregarHistorico]);

  /* trocar de gaveta/conversa: começa no fim da lista, sem puxar a página inteira */
  useEffect(() => {
    irParaOFim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  /* T014 (v3.18): o texto digitado é POR GAVETA — trocar e voltar não apaga o rascunho */
  const chaveAnterior = useRef(chave);
  useEffect(() => {
    if (chaveAnterior.current === chave) return;
    if (perguntaRef.current.trim()) rascunhos.current.set(chaveAnterior.current, perguntaRef.current);
    setPergunta(rascunhos.current.get(chave) ?? "");
    setEditando(null);
    chaveAnterior.current = chave;
    requestAnimationFrame(() => {
      if (campoRef.current) ajustarAltura(campoRef.current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  /* T008 (v3.18): teclado aberto no celular não pode esconder a barra de digitar —
     o visualViewport conta quantos pixels o teclado cobriu e a gente empurra o pé para cima.
     Sem essa API (desktop), nada acontece. */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const mexer = () => {
      const piso = document.getElementById("chatPiso");
      if (!piso) return;
      const coberto = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      piso.style.transform = coberto > 60 ? `translateY(-${coberto - 16}px)` : "";
      if (coberto > 60 && document.activeElement === campoRef.current) {
        campoRef.current?.scrollIntoView({ block: "center" });
      }
    };
    vv.addEventListener("resize", mexer);
    vv.addEventListener("scroll", mexer);
    return () => {
      vv.removeEventListener("resize", mexer);
      vv.removeEventListener("scroll", mexer);
    };
  }, []);

  /* T009 (v3.18): o botão "copiar" mora no HTML vindo do md.ts (dangerouslySetInnerHTML),
     então o React não vê o clique — escuta delegada no recipiente das mensagens. */
  const delegou = useRef(false);
  useEffect(() => {
    const a = area.current;
    if (!a || delegou.current) return;
    delegou.current = true;
    const pegar = (e: MouseEvent) => {
      const alvo = e.target as HTMLElement | null;
      const botao = alvo?.closest?.(".chat-pre-copiar") as HTMLElement | null;
      if (!botao) return;
      const pre = botao.closest(".chat-bloco")?.querySelector("pre");
      if (pre) void copiarTexto(pre.textContent ?? "", "bloco copiado");
    };
    a.addEventListener("click", pegar);
    return () => a.removeEventListener("click", pegar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.msgs.length]);

  /** medir é o que decide: folga menor que 80px = você está acompanhando de baixo.
   *  v3.39.4: ignora o scroll que o próprio app disparou — senão o salto automático
   *  era medido com o conteúdo já maior e derrubava `colado` sem o usuário sair do fim. */
  function medirRolagem() {
    const a = area.current;
    if (!a) return;
    if (programando.current) {
      programando.current = false;
      return;
    }
    colado.current = a.scrollHeight - a.scrollTop - a.clientHeight < 80;
    setNoFundo(colado.current);
    if (colado.current) setNovoAbaixo(false);
  }

  function irParaOFim() {
    const a = area.current;
    if (!a) return;
    /* salto imediato: suave em travessia longa parece que nao fez nada */
    programando.current = true;
    a.scrollTo({ top: a.scrollHeight, behavior: "auto" });
    colado.current = true;
    setNoFundo(true);
    setNovoAbaixo(false);
    /* se o scrollTo não mudou nada (já estávamos no fim) não vem evento de scroll;
       o quadro seguinte solta a marca de qualquer jeito. */
    requestAnimationFrame(() => {
      programando.current = false;
    });
  }

  /* o texto chega em pedaços: desce junto se (e somente se) o usuário estiver no fim.
     NAO depende do cronômetro — era ele que puxava a tela a cada 500 ms.
     v3.30.1: o CÓDIGO da tela e as telas prontas também empurram a conversa. Sem eles na
     chave, a caixa crescia para fora da tela e a conversa ficava parada. */
  const ultima = snap.msgs[snap.msgs.length - 1];
  const rastro =
    snap.msgs.length +
    ":" +
    (ultima?.texto.length ?? 0) +
    ":" +
    (ultima?.raciocinio?.length ?? 0) +
    ":" +
    (ultima?.codigo?.length ?? 0) +
    ":" +
    (ultima?.telas?.length ?? 0);
  useEffect(() => {
    if (colado.current) irParaOFim();
    else setNovoAbaixo(true);
  }, [rastro, snap.rodando]);

  /* v3.39.4 — o "pedacinho que não desce": o auto-scroll só reagia a mudança de TEXTO.
     A altura também muda sem texto (campo crescendo, rastro abrindo/fechando, tela ou
     imagem entrando) e ninguém puxava. ResizeObserver no conteúdo + na área cobre os dois,
     agrupado em requestAnimationFrame (1 salto por quadro). Se você subiu, não puxa nada. */
  useEffect(() => {
    const a = area.current;
    if (!a) return;
    const conteudo = a.firstElementChild as HTMLElement | null;
    let agendado = 0;
    const puxar = () => {
      if (!colado.current || agendado) return;
      agendado = requestAnimationFrame(() => {
        agendado = 0;
        if (colado.current) irParaOFim();
      });
    };
    const ro = new ResizeObserver(puxar);
    if (conteudo) ro.observe(conteudo);
    ro.observe(a); // pé/teclado mudam a altura da ÁREA, não do conteúdo
    return () => {
      if (agendado) cancelAnimationFrame(agendado);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* o pensamento cresce POR DENTRO do painel (ele tem altura própria com rolagem): enquanto
     escreve, o painel tem de acompanhar a escrita em vez de deixar o texto novo subir e
     sair de cima. Para de acompanhar se você subir lá dentro para reler; volta a colar
     quando começa uma resposta nova. */
  const racioColado = useRef(true);
  useEffect(() => {
    const painel = document.querySelector<HTMLElement>(".racio[open] .racio-txt");
    if (!painel) {
      racioColado.current = true;
      return;
    }
    if (racioColado.current) painel.scrollTop = painel.scrollHeight;
  }, [rastro]);

  /* cronômetro honesto: conta desde QUANDO a tarefa começou (voltar para a tela não zera o tempo) */
  useEffect(() => {
    if (!snap.rodando || !snap.inicio) {
      setEspera(0);
      return;
    }
    const marcar = () => setEspera(Math.max(0, Math.round((Date.now() - snap.inicio) / 1000)));
    marcar();
    const t = setInterval(marcar, 500);
    return () => clearInterval(t);
  }, [snap.rodando, snap.inicio]);

  /* v3.68 — a janela está assistindo o turno AGORA? (aba visível + stream de tarefa ligado).
     O tique de 500 ms do cronômetro reavalia a cada volta, então o selo aparece/some sem
     listener extra. Ao Voltar para a aba com o turno vivo, corta o stream pendurado: o
     laço de religação trata como queda e CONSULTA O STATUS NA HORA — se a tarefa terminou
     no vão, a resposta entra e o selo morre em ~1 s (antes esperava o vigia de 120 s). */
  const [visivel, setVisivel] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const aoMudar = () => {
      const v = document.visibilityState !== "hidden";
      setVisivel(v);
      if (v) cortarStreams();
    };
    document.addEventListener("visibilitychange", aoMudar);
    return () => document.removeEventListener("visibilitychange", aoMudar);
  }, []);
  /* O corte do stream na volta para a aba abre um vão de ~1 s até a religação; sem
     margem o selo piscaria nesse intervalo. Ele só entra na tela quando a janela está
     de fato sem assistir há 2,5 s (aba oculta, ou stream morto sem reconectar). */
  const assistindoVivo = visivel && temFluxoAssistindo();
  const [seloDeFundo, setSeloDeFundo] = useState(false);
  useEffect(() => {
    if (assistindoVivo) {
      setSeloDeFundo(false);
      return;
    }
    const desde = Date.now();
    const t = setInterval(() => setSeloDeFundo(Date.now() - desde >= 2500), 500);
    return () => clearInterval(t);
  }, [assistindoVivo]);

  /* v3.16: transporte roda com deps vazias; o canal de "provider vivo" passa por ref
     para sempre chamar a função atual do App. */
  const vivoRef = useRef(onProviderConfirmado);
  vivoRef.current = onProviderConfirmado;
  /* v3.18: o transporte (estável, sem deps) precisa do escopo de AGORA para registrar a
     tarefa na conversa certa quando a tela está noutra gaveta — o truque do vivoRef de novo. */
  const escopoRef = useRef(escopo);
  escopoRef.current = escopo;

  /** o transporte sabe falar com o servidor; a conversa não precisa de tela aberta para existir */
  const transportar = useCallback<Transportar>(
    async (pedido, onEvent) => {
      let dados: Record<string, unknown> | null = null;
      /* v3.3: a resposta agora VIVE no servidor (tarefa): fechar a aba não mata o trabalho.
         Servidor antigo (404 em /chat/tarefa): cai no caminho direto /chat/stream. */
      let idTarefa = "";
      /* v3.41 — com imagem colada o turno vai DIRETO pelo /chat/stream: a tarefa guarda só
         texto no banco, e a imagem não pode ser reidratada depois. O stream carrega as partes
         de visão na própria requisição. */
      const temImagem =
        Array.isArray(pedido.imagens) && (pedido.imagens as unknown[]).length > 0;
      if (temImagem) {
        await postStream("/chat/stream", pedido, (ev) => {
          if (ev.tipo === "fim") dados = ev.dados as Record<string, unknown>;
          else onEvent(ev as EventoTransporte);
        });
      } else {
        try {
          idTarefa = String((await post<{ id: string }>("/chat/tarefa", pedido)).id);
          /* v3.18 (T001): a conversa dona da tarefa registra o id — é assim que o "parar" sabe o que matar */
          registrarTarefa(chaveConversa(escopoRef.current.tenant, String(pedido.memoria ?? "")), idTarefa);
        } catch (e) {
          if (e instanceof ApiErro && e.status === 404) {
            await postStream("/chat/stream", pedido, (ev) => {
              if (ev.tipo === "fim") dados = ev.dados as Record<string, unknown>;
              else onEvent(ev as EventoTransporte);
            });
          } else {
            throw e;
          }
        }
        if (idTarefa) dados = await bombearTarefa(idTarefa, onEvent, pedido.tenant);
      }
      const d = (dados ?? {}) as Record<string, unknown>;
      const aviso = textoCompacto(d.compactacao as Compactacao | undefined);
      if (aviso) d.compacto = aviso;
      if (d.resposta) vivoRef.current();
      return d;
    },
    [],
  );

  /* a pílula de escrita acompanha o texto digitado (até ~5 linhas) em vez de esconder o
     restante atrás de um campo de altura fixa */
  function ajustarAltura(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }

  /* copiar (resposta, pergunta ou bloco de código): área de transferência do navegador com
     reserva para http sem suporte (o painel local do cliente roda em http://127.0.0.1, onde o clipboard pode faltar) */
  async function copiarTexto(texto: string, brinde: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(texto);
      } else {
        const sujo = document.createElement("textarea");
        sujo.value = texto;
        sujo.setAttribute("readonly", "");
        sujo.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(sujo);
        sujo.select();
        document.execCommand("copy");
        sujo.remove();
      }
      toast(brinde, "sucesso");
    } catch {
      toast("o navegador nao deixou copiar — selecione o texto e copie", "erro");
    }
  }

  const copiarResposta = (texto: string) => copiarTexto(texto, "resposta copiada");

  function enviar() {
    const texto = pergunta.trim();
    const imgs = anexos;
    const arqs = arquivos;
    if (!texto && imgs.length === 0 && arqs.length === 0) return;
    const pedido = texto || (imgs.length ? "Analise a imagem que colei." : "Segue o arquivo anexado.");
    setPergunta("");
    setAnexos([]);
    setArquivos([]);
    rascunhos.current.delete(chave); // v3.18 (T014): rascunho daquela gaveta foi usado
    if (campoRef.current) {
      campoRef.current.style.height = "auto";
      campoRef.current.focus();
    }
    /* v3.42 — resposta rodando e a pessoa fala de novo: entra NO turno (steering), não
       na fila. Sem imagem: a rota leva só texto. Com anexo, segue o caminho normal. */
    const vivo = imgs.length === 0 ? tarefaViva(chave) : "";
    if (vivo) {
      falarNoTurno(chave, pedido);
      void post(`/chat/tarefa/${vivo}/fala${tenantParam ? "?" + qs({ tenant: tenantParam }) : ""}`, { texto: pedido })
        .catch(async (e) => {
          toast("encaixar a fala falhou: " + (e as Error).message + " — mandei como próxima pergunta", "erro");
          enviarNaConversa(chave, pedido, memoria, tenantParam, transportar);
        });
      return;
    }
    enviarNaConversa(chave, pedido, memoria, tenantParam, transportar, imgs.length ? imgs : undefined, arqs.length ? arqs : undefined);
  }

  /** v3.46 — arquivo de qualquer tamanho: sobe em blocos (com retomada) e o chat
   *  manda só o id; o assistente usa enviar_para_maquina para levar a uma máquina. */
  async function subirArquivos(files: File[]) {
    for (const f of files.slice(0, 5)) {
      setSubindo({ nome: f.name, pct: 0 });
      try {
        const a = await subirAnexo(f, (feito, total) =>
          setSubindo({ nome: f.name, pct: total ? feito / total : 0 }),
        );
        setArquivos((atual) => [...atual, a]);
        toast(`${a.nome} pronto (${(a.bytes / 1048576).toFixed(1)} MB)`, "sucesso", 3000);
      } catch (e) {
        toast(`subir ${f.name} falhou: ${(e as Error).message}`, "erro", 7000);
      } finally {
        setSubindo(null);
      }
    }
  }

  /** v3.41 — imagem entra por COLAR, ARRASTAR ou pelo botão de clipe: um caminho só. */
  async function lerImagens(files: File[]) {
    const novos: AnexoImagem[] = [];
    for (const f of files.slice(0, 3)) {
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
        toast("imagem: só png, jpeg ou webp", "erro");
        continue;
      }
      if (f.size > 4 * 1024 * 1024) {
        toast("imagem maior que 4MB", "erro");
        continue;
      }
      const b64 = await new Promise<string>((ok, falha) => {
        const fr = new FileReader();
        fr.onload = () => ok(String(fr.result).replace(/^data:[^;]+;base64,/, ""));
        fr.onerror = () => falha(fr.error);
        fr.readAsDataURL(f);
      });
      novos.push({ mime: f.type, base64: b64, nome: f.name || "colada.png" });
    }
    if (novos.length) setAnexos((a) => [...a, ...novos].slice(0, 3));
  }

  /* ---------------- v3.18: parar, regenerar, editar, repetir, exportar, voz, hora ---------------- */

  const fmtHora = (iso?: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };

  /** T001: "parar" — o servidor aborta a chamada em curso e devolve pelo stream o que já tinha saído */
  function pararResposta() {
    const id = pedirParada(chave);
    if (!id) return;
    void post(`/chat/tarefa/${encodeURIComponent(id)}/cancelar${tenantParam ? "?" + qs({ tenant: tenantParam }) : ""}`, {}).catch((e) => {
      toast("parar: " + (e as Error).message, "erro");
    });
  }

  /** T002: regenerar — o servidor corta o último par; a tela reenvia a pergunta pelo caminho normal */
  async function regenerar() {
    if (rodando) return;
    try {
      const r = await post<{ pergunta: string; removidas: number }>(
        "/chat/regenerar",
        { memoria, ...(tenantParam ? { tenant: tenantParam } : {}) },
      );
      const p = String(r.pergunta ?? "").trim();
      if (!p) return;
      descartarUltimos(chave, Number(r.removidas ?? 2));
      enviarNaConversa(chave, p, memoria, tenantParam, transportar);
    } catch (e) {
      toast("regenerar: " + (e as Error).message, "erro");
    }
  }

  /** T003: editar e reenviar — o corte no servidor vem antes; se ele falar, nada se move na tela */
  function comecarEdicao(sid: number, texto: string) {
    setEditando(sid);
    setPergunta(texto);
    requestAnimationFrame(() => {
      const el = campoRef.current;
      if (el) {
        el.focus();
        ajustarAltura(el);
      }
    });
  }

  function cancelarEdicao() {
    setEditando(null);
    setPergunta("");
  }

  async function confirmarEdicao() {
    const texto = pergunta.trim();
    const sid = editando;
    setEditando(null);
    setPergunta("");
    if (!texto || sid === null) return;
    try {
      await post("/chat/reenviar-corte", { memoria, ...(tenantParam ? { tenant: tenantParam } : {}), id: sid });
      apararAteSid(chave, sid);
      enviarNaConversa(chave, texto, memoria, tenantParam, transportar);
    } catch (e) {
      toast("reenviar: " + (e as Error).message, "erro");
    }
  }

  /** T013: erro com botão visível de repetir a última pergunta */
  function repetirUltima() {
    const alvo = [...msgs].reverse().find((m) => m.papel === "user");
    if (!alvo) {
      toast("nenhuma pergunta para repetir", "erro");
      return;
    }
    enviarNaConversa(chave, alvo.texto, memoria, tenantParam, transportar);
  }

  /** T017: exportar a conversa visível como markdown (balões na ordem, com hora) */
  function exportarConversa() {
    const corpo = msgs
      .filter((m) => m.texto.trim())
      .map((m) => `${m.papel === "user" ? "**você**" : "**Nexos**"}${m.when ? ` · ${fmtHora(m.when)}` : ""}\n\n${m.texto}\n`)
      .join("\n---\n\n");
    if (!corpo) {
      toast("nada para exportar ainda", "erro");
      return;
    }
    const blob = new Blob([`# conversa${memoria ? ` — ${memoria}` : ""} (Nexos)\n\n${corpo}`], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `conversa-${(memoria || "padrao").replace(/[^\w-]+/g, "_").slice(0, 40)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** T022: ditado por voz do próprio navegador (Web Speech). Sem suporte: avisa, não finge. */
  function alternarDitado() {
    const SR = (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any });
    const Fabrica = SR.SpeechRecognition ?? SR.webkitSpeechRecognition;
    if (!Fabrica) {
      toast("seu navegador não tem ditado por voz (funciona no Chrome/Edge)", "erro");
      return;
    }
    if (ditando) {
      recRef.current?.stop();
      setDitando(false);
      return;
    }
    const rec = new Fabrica();
    rec.lang = "pt-BR";
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (ev: any) => {
      let novo = "";
      for (let k = ev.resultIndex; k < ev.results.length; k++) {
        if (ev.results[k].isFinal) novo += ev.results[k][0].transcript;
      }
      if (!novo) return;
      setPergunta((p) => (p.trim() ? `${p.trimEnd()} ${novo}` : novo));
      requestAnimationFrame(() => {
        if (campoRef.current) ajustarAltura(campoRef.current);
      });
    };
    rec.onerror = (ev: any) => {
      toast("ditado: " + String(ev?.error ?? "falhou") + " (o microfone pode estar bloqueado)", "erro");
      setDitando(false);
    };
    rec.onend = () => setDitando(false);
    recRef.current = rec;
    setDitando(true);
    try {
      rec.start();
    } catch {
      setDitando(false);
    }
  }

  function tirarDaFila(id?: number | string) {
    if (typeof id === "string") cancelar(chave, id);
  }

  async function limpar() {
    if (!confirm("apagar a conversa desta gaveta?")) return;
    try {
      await del("/chat?" + qs({ memoria, ...(tenantParam ? { tenant: tenantParam } : {}) }));
      limparConversa(chave);
      toast("conversa apagada", "sucesso");
    } catch (e) {
      toast("apagar: " + (e as Error).message, "erro");
    }
  }

  const semProvider = provider && !provider.configurado;
  const semFerramenta = provider && provider.configurado && !provider.mcp_interno;
  const naFila = snap.fila.length;
  const msgs = snap.msgs;
  const rodando = snap.rodando;
  /* v3.62 — o botão obedece ao campo: com texto digitado ele ENVIA (a fala entra no meio do
     rastro, o steering da v3.42); com o campo vazio ele é o "parar". Antes, durante o turno,
     o botão era sempre "parar" e o toque matava a resposta com a mensagem ainda no campo. */
  const botaoParar = rodando && !pergunta.trim();

  /* o botão "regenerar" só faz sentido na ÚLTIMA resposta (a que está no fim da corrida) */
  let idxUltimaResposta = -1;
  for (let k = msgs.length - 1; k >= 0; k--) {
    if (msgs[k].papel === "assistant" && !msgs[k].fala && !msgs[k].escrevendo) {
      idxUltimaResposta = k;
      break;
    }
  }

  return (
    <section className="chat-tela flex flex-col gap-3 max-[720px]:gap-0" id="telaChat">
      {/* v3.16: a pílula (modelo+gaveta) subiu para a lateral e o reset desceu para o pé,
           ao lado da caixa de escrita. Esta linha só existe no celular, como porta ☰. */}
      {/* v3.61: a linha do topo existe em TODAS as larguras — no celular é a porta ☰,
           no desktop carrega só ⚙ ferramentas e nova conversa (o piso ficou só com a escrita). */}
      <div className="chat-topo">
        <button
          id="chatMenuCelular"
          className="chat-menu-celular chat-acao"
          aria-label="abrir menu"
          title="menu"
          onClick={onAbrirMenu}
        >
          ☰
        </button>
        <span className="flex-1" />
        <div className="chat-ajustes" ref={ajustesRef}>
          <button
            id="chatAjustes"
            className="chat-ajustes-boto"
            title="ferramentas da conversa (provider, modelo, exportar)"
            aria-label="ferramentas da conversa"
            aria-expanded={ajustesAberto}
            onClick={() => setAjustesAberto((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          {ajustesAberto && (
            <div className="chat-ajustes-pop" role="dialog" aria-label="ferramentas da conversa">
              <div className="chat-ajustes-cab">⚙ ferramentas</div>
              {provedores.some((p) => p.ativo) && (
                <div className="chat-ajustes-modelos" data-testid="chatModelos">
                  {/* v3.67.2 (dono): a lista mostra SÓ os provedores disponíveis — a linha
                      "automático — x" fantasma fazia o provider padrão aparecer duas vezes e o
                      admin contava 3 provedores onde havia 2. Quem não escolheu nada segue o
                      padrão escolhido em Configurações (padraoNome abaixo); escolher aqui fixa
                      a conversa, e o "mudar" do padrão continua sendo na tela de Configurações. */}
                  <select
                    aria-label="provedor da conversa"
                    title="que serviço responde esta conversa"
                    value={sel.provedor || padraoNome || (provedores.find((p) => p.ativo)?.nome ?? "")}
                    onChange={(e) => mudarSelecao({ provedor: e.target.value, modelo: "" })}
                  >
                    {provedores.filter((p) => p.ativo).map((p) => (
                      <option key={p.id} value={p.nome}>
                        {p.nome}
                        {p.padrao ? " · padrão" : ""}
                      </option>
                    ))}
                  </select>
                  {selProvedor && (
                    <select
                      aria-label="modelo"
                      title={
                        selProvedor.modelos.length
                          ? selProvedor.modelos_em
                            ? "modelos descobertos (cache de " + selProvedor.modelos_em.slice(0, 10) + ")"
                            : "modelos descobertos"
                          : "só o modelo cadastrado"
                      }
                      value={sel.modelo || selProvedor.modelo}
                      onChange={(e) => mudarSelecao({ provedor: sel.provedor, modelo: e.target.value })}
                    >
                      {(selProvedor.modelos.length ? selProvedor.modelos : [selProvedor.modelo]).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <div className="chat-ajustes-botoes">
                <button
                  id="chatExportar"
                  className="btn btn-mini"
                  title="exportar a conversa (markdown)"
                  onClick={exportarConversa}
                >
                  ⤓ exportar
                </button>
              </div>
            </div>
          )}
        </div>
        {/* v3.31.1 (dono, 27/10): o piso tem "nova conversa" (ação do dia a dia) e o
            popover virou "⚙ ferramentas" (provider/modelo + exportar). */}
        <button
          id="chatNovaConversa"
          className="chat-nova"
          title="apagar esta conversa e recomeçar do zero"
          aria-label="nova conversa"
          onClick={() => void limpar()}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
            <path d="M13 8v6M10 11h6" />
          </svg>
          <span className="chat-nova-rotulo">nova conversa</span>
        </button>
      </div>

      {semProvider && (
        <div className="aviso" id="avisoProvider">
          <span>Chat desligado: nenhum provedor disponível para esta conta. A Busca continua funcionando.</span>
          {/* v3.4: provider é decisão de admin — o comum não tem Configurações na tela */}
          {operador ? (
            <button className="btn btn-mini ml-auto" onClick={onIrConfig}>
              configurar agora
            </button>
          ) : (
            <span className="ml-auto text-[12px] text-txt3">peça ao administrador para ligar o provider</span>
          )}
        </div>
      )}

      <div className="chat-caixa relative flex flex-col gap-0 p-0">
        {/* min-h-0 e o que falta para a caixa rolar por dentro: sem isso ela crescia
            e quem andava era a pagina inteira */}
        <div className="chat-msgs min-h-0 flex-1 overflow-auto" id="chatMsgs" ref={area} onScroll={medirRolagem}>
          <div className="chat-coluna">
          {msgs.length === 0 && !rodando && (
            semFerramenta ? (
              <p className="dica">
                "nenhuma ferramenta ligada — o modelo responde só com o que sabe (ligue MCP em Configurações → Ferramentas)"
              </p>
            ) : (
              /* v3.22 (preview aprovado): estado vazio — boas-vindas + 4 exemplos clicáveis.
                 O clique cai o texto no campo e foca. Textos literais da maquete aprovada. */
              <div className="chat-vazio" id="chatVazio">
                <p className="chat-vazio-titulo">"Boa. Sua memória está aqui."</p>
                <p className="chat-vazio-sub">"Pergunte com suas palavras, ou comece por uma destas:"</p>
                <div className="chat-chips">
                  {EXEMPLOS_VAZIO.map((ex) => (
                    <button
                      key={ex.t}
                      className="chat-chip"
                      onClick={() => {
                        setPergunta(ex.t);
                        requestAnimationFrame(() => {
                          campoRef.current?.focus();
                          ajustarAltura(campoRef.current as HTMLTextAreaElement);
                        });
                      }}
                    >
                      <span className="chat-chip-corpo">
                        <span className="chat-chip-tit">{ex.t}</span>
                        <span className="chat-chip-sub">{ex.sub}</span>
                      </span>
                      <span className="chat-chip-seta" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 6l6 6-6 6" />
                        </svg>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )
          )}
          {msgs.map((m, i) => (
            <div
              key={m.id ?? i}
              className={"msg " + (m.papel === "user" ? "msg-eu" : "msg-ia") + (m.falha ? " msg-falha" : "")}
              onClick={(e) => {
                /* v3.22 (preview aprovado): as ações (copiar/regenerar/editar) ficam invisíveis
                   e aparecem no hover (mouse) ou no toque (celular). O toque no corpo da
                   mensagem alterna; toque em botão/ação/detalhe não alterna. */
                const alvo = e.target as HTMLElement;
                if (alvo.closest("button, a, summary, details, select, textarea, input")) return;
                e.currentTarget.toggleAttribute("data-acao");
              }}
            >
              {m.papel === "assistant" ? (
                <>
                  {/* v3.13 — bloco de raciocínio no estilo do Open WebUI: "Pensando… Ns"
                      aberto enquanto pensa, "Pensou por Ns" recolhido quando a resposta começa */}
                  {m.rastro && m.rastro.length > 0 ? (
                    <Rastro
                      segmentos={m.rastro}
                      vivo={Boolean(m.escrevendo)}
                      detalhes={m.ferramentas}
                      ms={m.ms}
                      inicio={m.inicio}
                      custo={m.custo}
                      aberto={rastroAberto(Boolean(m.escrevendo), m.texto, produzindo(m))}
                      travado={emProcesso(Boolean(m.escrevendo), m.texto, produzindo(m))}
                      onToggle={alternarRastro}
                    />
                  ) : m.raciocinio ? (
                    <details className="racio" open={Boolean(m.escrevendo) && !m.texto && !produzindo(m)}>
                      <summary className="racio-cab">
                        <svg className="racio-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                          <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" />
                        </svg>
                        {m.escrevendo && !m.texto
                          ? `Pensando… ${espera}s`
                          : `Pensou${m.raciocinioInicio !== undefined && m.raciocinioFim !== undefined
                              ? ` por ${Math.max(1, Math.round((m.raciocinioFim - m.raciocinioInicio) / 1000))}s`
                              : ""}`}
                      </summary>
                      <div
                        className="racio-txt"
                        onScroll={(e) => {
                          const el = e.currentTarget;
                          racioColado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                        }}
                      >
                        {m.raciocinio}
                      </div>
                    </details>
                  ) : null}
                  {/* v3.29: a tela nasce no ponto em que foi gerada — ANTES da conclusão.
                      O servidor emite `tela` na execução da ferramenta e só depois o texto
                      final da rodada; o card tem que vir primeiro (antes vinha depois). */}
                  {(m.codigo || (m.telas && m.telas.length > 0)) && (
                    <div className="tela-area">
                      {m.telas && m.telas.length > 0 ? (
                        m.telas.map((t) => <TelaGerada key={t.id} tela={t} />)
                      ) : (
                        <TelaGerada tela={null} codigo={m.codigo} digitando={Boolean(m.escrevendo)} />
                      )}
                    </div>
                  )}
                  {m.anexos && m.anexos.length > 0 && (
                    <div className="chat-arquivos">
                      {m.anexos.map((a) => <AnexoBolha key={a.id} a={a} />)}
                    </div>
                  )}
                  {m.escrevendo && !m.texto && !(m.codigo || (m.telas && m.telas.length > 0)) ? (
                    /* v3.34: o aviso solto só existe ANTES do primeiro sinal — e ele diz a
                       verdade ("Preparando…"), não "pensando…" (o modelo ainda nem começou).
                       Com rastro na tela, nada solto: o status mora dentro da trilha. */
                    m.raciocinio || (m.rastro && m.rastro.length) ? null : (
                      <span className="sub2" id="chatPensando">
                        Preparando… {espera}s
                        {naFila > 0 ? ` · ${naFila} na fila` : ""}
                      </span>
                    )
                  ) : (
                    <div className={(m.escrevendo ? "md vivo" : "md") + (m.fala ? " fala" : "")} dangerouslySetInnerHTML={{ __html: mdParaHtml(m.texto) }} />
                  )}
                </>
              ) : (
                <>
                  {/* v3.41 — a foto que a pessoa mandou aparece na própria bolha (antes a
                      imagem só existia no campo e sumia ao enviar; igual ao IA_GO) */}
                  {m.imagens && m.imagens.length > 0 && (
                    <div className="chat-bolha-imgs">
                      {m.imagens.map((im, k) => (
                        <a
                          key={k}
                          className="chat-bolha-img"
                          href={`data:${im.mime};base64,${im.base64}`}
                          target="_blank"
                          rel="noreferrer"
                          title="abrir a imagem"
                        >
                          <img src={`data:${im.mime};base64,${im.base64}`} alt="imagem enviada" />
                        </a>
                      ))}
                    </div>
                  )}
                  {m.texto}
                  {m.naFila && (
                    <button className="btn btn-mini ml-2" title="tirar da fila" onClick={() => tirarDaFila(m.id)}>
                      ✕ na fila
                    </button>
                  )}
                  {/* v3.18 (T012/T020/T003): hora, copiar a própria pergunta e editar-e-reenviar */}
                  <span className="chat-acoes chat-acoes-eu">
                    {m.when && <span className="chat-hora">{fmtHora(m.when)}</span>}
                    <button
                      className="chat-acao-icone"
                      title="copiar a pergunta"
                      aria-label="copiar a pergunta"
                      onClick={() => void copiarTexto(m.texto, "pergunta copiada")}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M15 5H6a2 2 0 0 0-2 2v9" />
                      </svg>
                    </button>
                    {m.sid !== undefined && !rodando && editando === null && (
                      <button
                        className="chat-acao-icone"
                        title="editar e reenviar (corta daqui para frente)"
                        aria-label="editar pergunta"
                        onClick={() => comecarEdicao(m.sid as number, m.texto)}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                          <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" />
                        </svg>
                      </button>
                    )}
                    {editando === m.sid && <span className="chat-hora">editando aí embaixo…</span>}
                  </span>
                </>
              )}
              {m.ferramentas.length > 0 && !(m.rastro && m.rastro.length > 0) && (
                <details className="fontes" open={false}>
                  <summary className="fonte">
                    ferramentas chamadas · {m.ferramentas.length} (
                    {m.ferramentas.map((f) => (f.servidor === "nexos" || f.servidor === "minirag" ? "" : f.servidor + "·") + f.nome).join(", ")})
                  </summary>
                  {m.ferramentas.map((f, j) => (
                    <div className="fonte" key={j}>
                      <b>
                        {f.servidor === "nexos" || f.servidor === "minirag" ? "Nexos" : f.servidor} · {f.nome}
                      </b>{" "}
                      {f.ok ? "✓" : "✕"} · {f.ms} ms
                      <div className="mono break-all">{JSON.stringify(f.args)}</div>
                      <div className="sub2 break-all">{f.resumo}</div>
                    </div>
                  ))}
                </details>
              )}
              {/* v3.18 (T004): de onde a resposta veio — os documentos que a busca tocou.
                 Chip só com fonte real; resposta sem ferramentas não inventa procedência. */}
              {m.papel === "assistant" && m.fontes && m.fontes.length > 0 && (
                <div className="chat-fontes" title="documentos usados nesta resposta">
                  {m.fontes.slice(0, 6).map((f, k) => (
                    <span className="chat-fonte" key={k}>{f}</span>
                  ))}
                </div>
              )}
              {/* ações sobre a resposta pronta. v3.18: "refazer" virou REGENERAR — o corte
                 de histórico no servidor (T002) foi o osso que faltava. */}
              {m.papel === "assistant" && !m.escrevendo && m.texto ? (
                <div className="chat-acoes">
                  <button
                    className="chat-acao-icone"
                    title="copiar a resposta"
                    aria-label="copiar a resposta"
                    onClick={() => void copiarResposta(m.texto)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M15 5H6a2 2 0 0 0-2 2v9" />
                    </svg>
                  </button>
                  {i === idxUltimaResposta && !rodando && (
                    <button
                      className="chat-acao-icone"
                      title="regenerar a resposta (refaz a última pergunta)"
                      aria-label="regenerar"
                      onClick={() => void regenerar()}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                        <path d="M20 12a8 8 0 1 1-2.3-5.6" />
                        <path d="M20 4v5h-5" />
                      </svg>
                    </button>
                  )}
                  {m.when && <span className="chat-hora">{fmtHora(m.when)}</span>}
                  {m.custo && Number(m.custo.tok_out ?? 0) > 0 && (
                    <span
                      className="chat-hora"
                      data-testid="custoTurno"
                      title={
                        (m.custo.tok_in ? `${m.custo.tok_in} tok de entrada · ` : "") +
                        "tokens da resposta" +
                        velocidadeTitulo(m.custo)
                      }
                    >
                      {Number(m.custo.tok_out)} tok
                      <span data-testid="custoVelocidade">{velocidadeTexto(m.custo)}</span>
                    </span>
                  )}
                  {m.provedor && (
                    <span className="chat-hora" title={m.modelo ? "modelo: " + m.modelo : ""}>via {m.provedor}</span>
                  )}
                </div>
              ) : null}
              {m.aviso && <div className="sub2 mt-1">aviso: {m.aviso}</div>}
              {m.compacto && <div className="sub2 mt-1">{m.compacto}</div>}
              {/* v3.18 (T013): erro com botão de repetir visível — antes, a frase de erro
                 morava sozinha na tela e a pessoa recomeçava do zero sem saber */}
              {m.falha && (
                <div className="chat-acoes">
                  <button className="btn btn-mini" onClick={repetirUltima}>↻ tentar de novo</button>
                </div>
              )}
            </div>
          ))}
          {rodando && !msgs.some((m) => m.escrevendo) && (
            <div className="msg msg-ia">
              pensando… {espera}s
              {naFila > 0 && <span className="sub2"> · {naFila} na fila</span>}
            </div>
          )}
          </div>
          {/* botão para descer: aparece só quando você subiu para ler algo */}
          {!noFundo && (
            <button
              id="chatIrAoFim"
              className="btn btn-mini absolute bottom-[116px] left-1/2 z-10 -translate-x-1/2 rounded-full px-3 shadow-md"
              title="rolar até o fim da conversa"
              onClick={irParaOFim}
            >
              {"↓ fim"}
              {novoAbaixo ? " · chegou coisa nova" : ""}
            </button>
          )}
        </div>
        {/* v3.16 — pé da conversa: "nova conversa" mudou de lado e desceu para a linha do
            campo, oposto ao enviar (ação perto do dedo, nada de reset no topo). A dica de
            teclado saiu da tela — vive no título (hover) do campo. */}
        <div className="chat-piso" id="chatPiso">
          {/* v3.68 (dono): o aviso agora é honesto. Com a aba VISÍVEL e o stream assistindo
              ao vivo, nada está em segundo plano — o trabalho aparece na tela e o selo não
              mente por cima dela. Ele só aparece quando a janela não está acompanhando o
              turno (aba de fundo, outra tela do app) — e com o tempo decorrido, para
              distinguir "trabalhando" de "preso". */}
          {rodando && seloDeFundo && (
            <p className="chat-segundo-plano" id="chatSegundoPlano" title="a tarefa continua no servidor mesmo se você fechar a aba">
              · trabalhando em segundo plano{espera >= 60 ? ` · ${Math.floor(espera / 60)} min` : espera > 0 ? ` · ${espera}s` : ""}{naFila > 0 ? ` · ${naFila} na fila` : ""}
            </p>
          )}
          <div className="chat-piso-linha">
            <div
              className="chat-composer"
              onClick={(e) => {
                /* no celular o alvo de toque e a pilula inteira (62px), nao a linha de 34px do campo */
                if (e.target === e.currentTarget) campoRef.current?.focus();
              }}
              /* v3.41 — os três jeitos de trazer imagem entram no compositor, não só no textarea:
                 colar (Ctrl+V), arrastar e soltar, e o botão de clipe abaixo. */
              onPaste={(e) => {
                const itens = Array.from(e.clipboardData?.items ?? [])
                  .filter((it) => it.type.startsWith("image/"))
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => Boolean(f));
                if (!itens.length) return;
                e.preventDefault();
                void lerImagens(itens);
              }}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
              }}
              onDrop={(e) => {
                const todos = Array.from(e.dataTransfer?.files ?? []);
                const fs = todos.filter((f) => f.type.startsWith("image/"));
                const grandes = todos.filter((f) => !f.type.startsWith("image/"));
                if (!fs.length && !grandes.length) return;
                e.preventDefault();
                if (fs.length) void lerImagens(fs);
                if (grandes.length) void subirArquivos(grandes);
              }}
            >
              {arquivos.length > 0 && (
                <div className="chat-anexos" data-testid="chatArquivos">
                  {arquivos.map((a) => (
                    <div className="chat-anexo chat-anexo-arquivo" key={a.id} title={`${a.nome} — ${(a.bytes / 1048576).toFixed(1)} MB`}>
                      <span className="chat-anexo-nome">{a.nome}</span>
                      <span className="chat-anexo-tam">{(a.bytes / 1048576).toFixed(1)} MB</span>
                      <button
                        className="chat-anexo-x"
                        title="remover arquivo"
                        aria-label="remover arquivo"
                        onClick={(e) => {
                          e.stopPropagation();
                          setArquivos((atual) => atual.filter((x) => x.id !== a.id));
                        }}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              {subindo && (
                <div className="chat-subindo" data-testid="chatSubindo" title={`enviando ${subindo.nome}`}>
                  <span className="chat-anexo-nome">{subindo.nome}</span>
                  <span className="chat-anexo-tam">{Math.round(subindo.pct * 100)}%</span>
                  <div className="chat-subindo-barra"><i style={{ width: `${Math.round(subindo.pct * 100)}%` }} /></div>
                </div>
              )}
              {anexos.length > 0 && (
                <div className="chat-anexos" data-testid="chatAnexos">
                  {anexos.map((a, i) => (
                    <div className="chat-anexo" key={i} title={a.nome || "imagem colada"}>
                      <img src={`data:${a.mime};base64,${a.base64}`} alt={a.nome || "imagem colada"} />
                      <button
                        className="chat-anexo-x"
                        title="remover imagem"
                        aria-label="remover imagem"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAnexos((atual) => atual.filter((_, k) => k !== i));
                        }}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                id="chatPergunta"
                ref={campoRef}
                className="chat-campo"
                rows={1}
                placeholder={editando !== null ? "reenviar pergunta editada… (Enter)" : rodando ? "próxima pergunta… (Enter fila)" : "pergunte qualquer coisa…"}
                title={editando !== null ? "Enter reenvia · Esc cancela a edição" : "Enter envia · Shift+Enter quebra linha"}
                enterKeyHint="send"
                value={pergunta}
              onChange={(e) => {
                setPergunta(e.target.value);
                ajustarAltura(e.currentTarget);
              }}

              onKeyDown={(e) => {
                /* v3.18 (T005): Enter QUE ACEITA AUTOCORREÇÃO do teclado não envia — no celular
                   isso mandava a pergunta pela metade (o evento vem com isComposing, e em teclado
                   antigo com keyCode 229). Igual ao truque do Hermes/Open WebUI. */
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (editando !== null) void confirmarEdicao();
                  else enviar();
                } else if (e.key === "Escape" && editando !== null) {
                  cancelarEdicao();
                }
              }}
            />
            {/* v3.48 (T049) — UM seletor para tudo: png/jpeg/webp até 4 MB vira imagem inline
                (o modelo enxerga); qualquer outro arquivo, ou imagem maior, sobe por blocos. */}
            <input
              ref={arquivoRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (!fs.length) return;
                const ehImagem = (f: File) =>
                  /^image\/(png|jpeg|webp)$/.test(f.type) && f.size <= 4 * 1024 * 1024;
                const imagens = fs.filter(ehImagem);
                const resto = fs.filter((f) => !ehImagem(f));
                if (imagens.length) void lerImagens(imagens);
                if (resto.length) void subirArquivos(resto);
              }}
            />
            <button
              id="chatAnexar"
              className="chat-acao-icone"
              title="anexar imagem ou arquivo (ou cole com Ctrl+V, ou arraste)"
              aria-label="anexar imagem ou arquivo"
              disabled={Boolean(subindo)}
              onClick={() => arquivoRef.current?.click()}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" />
              </svg>
            </button>
            {/* v3.18 (T022): ditado por voz do próprio navegador */}
            <button
              id="chatMic"
              className={"chat-acao-icone" + (ditando ? " chat-mic-vivo" : "")}
              title={ditando ? "parar de ditar" : "ditar a pergunta (voz)"}
              aria-label="ditar"
              onClick={alternarDitado}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
            {editando !== null && (
              <button className="btn btn-mini" title="cancelar a edição (Esc)" onClick={cancelarEdicao}>
                ✕<span className="chat-editar-rotulo"> editar</span>
              </button>
            )}
            {/* v3.22 (preview aprovado): "parar" continua existindo — vira o próprio botão de
               enviar enquanto a resposta chega (quadrado). v3.62: o botão obedece ao CAMPO —
               assim que a pessoa escreve, ele volta a ser o enviar (a fala entra no rastro);
               com o campo vazio ele é o parar. Os dois ganchos do E2E seguem vivos. */}
            <button
              id={botaoParar ? "chatParar" : "chatEnviar"}
              className={"chat-enviar" + (botaoParar ? " chat-enviar-parando" : "")}
              disabled={botaoParar ? snap.parando : !pergunta.trim()}
              title={
                botaoParar
                  ? snap.parando
                    ? "parando…"
                    : "parar esta resposta"
                  : editando !== null
                    ? "reenviar editada"
                    : rodando
                      ? "mandar agora, no meio da resposta"
                      : "enviar"
              }
              aria-label={botaoParar ? "parar a resposta" : "enviar"}
              onClick={botaoParar ? pararResposta : editando !== null ? confirmarEdicao : enviar}
            >
              {botaoParar ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5" />
                  <path d="M5 12l7-7 7 7" />
                </svg>
              )}
            </button>
            </div>
          </div>
          {/* v3.73 (T054): medidor de contexto DO ÚLTIMO ENVIO, colado abaixo do campo — o dono
              não precisa abrir Configurações para saber quanto da janela aquele envio usou. */}
          {snap.contexto && <MedidorContexto ctx={snap.contexto} />}
        </div>
      </div>
    </section>
  );
}
