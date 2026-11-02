import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post, put, qs } from "../services/api";
import { useToast } from "./Toast";
import type {
  ConfigResp,
  HealthResp,
  ProviderResp,
  Provedor,
  ServidorMcp,
  ServidoresResp,
  TesteMcpResp,
} from "../types";

export type Aba = "provider" | "comportamento" | "ferramentas" | "conta" | "limites" | "esquecimento" | "sistema";

/* v3.19.1: as seções vivem aqui, mas o MENU PRINCIPAL também as conhece —
   o item "Configurações" abre submenu com estas mesmas entradas (política do
   dono, 26/10: seção nova entra como FILHO no menu, nunca só como aba interna).
   v3.21.1: "Provider do chat" + "Provedores nomeados" viraram UMA seção —
   provider único com tabela (a linha 1 é o padrão da casa). */
export const SECOES_CFG: [Aba, string][] = [
  ["provider", "Providers"],
  ["comportamento", "Comportamento do agente"],
  ["ferramentas", "Ferramentas (MCP)"],
  ["conta", "Conta e chave"],
  ["limites", "Limites"],
  ["esquecimento", "Esquecimento"],
  ["sistema", "Sistema"],
];

/** Configurações: provider do chat, ferramentas (MCP), conta, limites, esquecimento e sistema. */
export function Config({
  nome,
  operador,
  tenant,
  onChaveNova,
  onControleMaquinas,
  aba,
}: {
  nome: string;
  operador: boolean;
  tenant: string;
  onChaveNova: (chave: string) => void;
  /** v3.69: o atalho "ver no painel" saiu de Providers; o App continua passando — mantido no contrato */
  onIrPainel?: () => void;
  onControleMaquinas?: (v: boolean) => void;
  aba: Aba;
}) {
  const SECOES = SECOES_CFG;
  const CORPO: Record<Aba, import("react").ReactNode> = {
    provider: <Provider operador={operador} />,
    comportamento: <Comportamento operador={operador} tenant={tenant} />,
    ferramentas: <Ferramentas operador={operador} tenant={tenant} onControleMaquinas={onControleMaquinas} />,
    conta: <Conta nome={nome} operador={operador} onChaveNova={onChaveNova} />,
    limites: <Limites />,
    esquecimento: <Esquecimento />,
    sistema: <Sistema />,
  };

  return (
    <section className="flex flex-col gap-3" id="telaConfig">
      <div className="barra">
        <div>
          <h1>Configurações</h1>
          <div className="mt-1 text-[12.8px] text-txt3">{SECOES.find(([id]) => id === aba)?.[1] ?? ""}</div>
        </div>
      </div>
      {/* v3.21: sem accordion interno — a seção vem da lateral (data-menu-filho).
          A tela só exibe o conteúdo da seção ativa. */}
      <div className="min-w-0">{CORPO[aba]}</div>
    </section>
  );
}

/* ------------------------------------------------------------- provider */

/** v3.21.1: a seção Provider é UMA: tabela com o padrão da casa (linha 1) + os
 *  providers nomeados; o form de cada linha abre aqui embaixo. O que era
 *  "Provider do chat" virou o form da linha padrão; o que era "Provedores
 *  nomeados" virou as demais linhas. No chat o usuário escolhe provider+modelo. */
/* v3.69 (pedido do dono): a tela de Providers fala SÓ do serviço (URL, chave, modelo,
   público/padrão). Instruções, rodadas, memória e compactação — o COMPORTAMENTO — moram
   na seção própria (Comportamento), da CONTA, valendo para todos os provedores. */
function Provider({ operador }: { operador: boolean }) {
  const { toast } = useToast();
  const [lista, setLista] = useState<Provedor[]>([]);
  /* form dos providers nomeados (novo ou edição) */
  const [novo, setNovo] = useState({ nome: "", tipo: "openai", base_url: "", chave: "", modelo: "", paraTodos: true, publico: true, padrao: false, escopoOrig: "global" });
  const [editando, setEditando] = useState<string | null>(null);
  const [formNomeadoAberto, setFormNomeadoAberto] = useState(false);
  const [rodando, setRodando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    /* v3.69: Providers fala SÓ do serviço — o comportamento (instruções, rodadas,
       compactação) saiu para a seção própria; aqui só a lista de linhas. */
    try {
      const r = await get<{ provedores: Provedor[] }>("/provedores");
      setLista(r.provedores);
    } catch (e) {
      toast("provedores: " + (e as Error).message, "erro");
    }
  }, [toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /* v3.60: a antiga linha "padrão da casa" saiu — todo provedor é uma linha da lista.
     v3.69: o formulário antigo (legado de provider_config) também saiu da tela: o
     comportamento do agente vive na seção Comportamento, e o serviço em cada linha. */

  /* v3.69: testar/salvar o "padrão da casa" e salvarInstruções saíram daqui —
     o comportamento (instruções, rodadas, memória, compactação) vive na seção
     Comportamento; o teste de conexão por linha usa "modelos" (mesmo serviço). */

  function preencherNomeado(pr: Provedor) {
    setEditando(pr.nome);
    setNovo({ nome: pr.nome, tipo: pr.tipo === "ollama" ? "ollama" : "openai", base_url: pr.base_url, chave: "", modelo: pr.modelo, paraTodos: pr.escopo === "*", publico: pr.publico, padrao: pr.padrao, escopoOrig: pr.escopo === "*" ? "global" : pr.escopo });
    setFormNomeadoAberto(true);
  }

  async function salvarNomeado() {
    setRodando("form");
    try {
      await put("/provedores", {
        nome: novo.nome.trim(),
        tipo: novo.tipo,
        base_url: novo.base_url.trim(),
        modelo: novo.modelo.trim(),
        /* "conta do operador" = escopo global; desmarcado = mantém o escopo original da linha.
           v3.60: quem vê é o `publico`, não o escopo. */
        tenant: novo.paraTodos ? "global" : novo.escopoOrig,
        publico: novo.publico,
        padrao: novo.padrao,
        ...(novo.chave ? { chave: novo.chave } : {}),
      });
      toast(editando ? "provedor atualizado" : "provedor cadastrado — descubra os modelos para o chat escolher", "sucesso");
      setNovo({ nome: "", tipo: "openai", base_url: "", chave: "", modelo: "", paraTodos: true, publico: true, padrao: false, escopoOrig: "global" });
      setEditando(null);
      setFormNomeadoAberto(false);
      await carregar();
    } catch (e) {
      toast("salvar provedor: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  /** AUTO-DESCOBERTA: o serviço devolve a lista dele (GET /models; Ollama: /api/tags). */
  async function descobrir(pr: Provedor) {
    setRodando(pr.nome);
    try {
      const r = await post<{ modelos: string[]; aviso?: string }>("/provedores/modelos", { id: pr.id });
      toast(
        r.modelos.length
          ? `${pr.nome}: ${r.modelos.length} modelo(s) descobertos`
          : (r.aviso ?? "descobrir modelos: o serviço não devolveu lista"),
      r.modelos.length ? "sucesso" : "erro",
      );
      await carregar();
    } catch (e) {
      toast("descobrir modelos: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  async function definirPadrao(pr: Provedor) {
    setRodando(pr.nome);
    try {
      await patch("/provedores/padrao", { id: pr.id });
      toast(`"${pr.nome}" agora é o padrão — vale para quem não escolhe nada na conversa`, "sucesso");
      await carregar();
    } catch (e) {
      toast("definir padrão: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  async function alternar(pr: Provedor) {
    setRodando(pr.nome);
    try {
      /* chave "***" = mantém a gravada (nunca reenviar segredo do formulário) */
      await put("/provedores", {
        nome: pr.nome,
        tipo: pr.tipo,
        base_url: pr.base_url,
        modelo: pr.modelo,
        chave: "***",
        /* preserva o escopo da linha: sem tenant, o servidor reatribui a linha ao
           próprio operador (uma global viraria "só do op" no meio do toggle) */
        tenant: pr.escopo === "*" ? "global" : pr.escopo,
        ativo: !pr.ativo,
      });
      await carregar();
    } catch (e) {
      toast("ligar/desligar: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  /** v3.60 — alterna público/privado sem passar pelo formulário (é o interruptor do dono). */
  async function alternarPublico(pr: Provedor) {
    setRodando(pr.nome);
    try {
      await put("/provedores", {
        nome: pr.nome,
        tipo: pr.tipo,
        base_url: pr.base_url,
        modelo: pr.modelo,
        chave: "***",
        tenant: pr.escopo === "*" ? "global" : pr.escopo,
        publico: !pr.publico,
      });
      toast(
        pr.publico
          ? `"${pr.nome}" agora é privado — só esta conta vê`
          : `"${pr.nome}" agora é público — todas as contas veem e podem escolher`,
        "sucesso",
      );
      await carregar();
    } catch (e) {
      toast("público/privado: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  async function apagarNomeado(pr: Provedor) {
    if (!confirm(`apagar o provedor "${pr.nome}"? quem estava usando cai no provedor padrão (ou o chat some, se não houver outro).`)) return;
    setRodando(pr.nome);
    try {
      await del(`/provedores/${pr.id}`);
      toast("provedor removido", "sucesso");
      await carregar();
    } catch (e) {
      toast("remover: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  return (
    <div className="cartao">
      <h2 className="mb-1 text-[13px] font-semibold text-txt2">
        Providers
        <span className="sub2 block font-normal">
          crie, edite e apague providers — no chat você escolhe o <b>provider</b> e o <b>modelo</b> de cada conversa
        </span>
      </h2>

      <table className="tabela mt-3" id="listaProviders">
        <thead>
          <tr>
            <th>provider</th>
            <th>tipo · URL base</th>
            <th>modelo(s)</th>
            <th>status</th>
            {operador && <th></th>}
          </tr>
        </thead>
        <tbody>
          {/* v3.60 — a lista é UMA: todo provedor é uma linha, com público/privado e padrão.
              O antigo "padrão da casa" foi migrado para uma linha normal (Clauricio). */}
          {lista.length === 0 && (
            <tr>
              <td colSpan={5}>
                <span className="sub2">
                  nenhum provedor cadastrado — sem provedor visível para esta conta o chat não aparece
                </span>
              </td>
            </tr>
          )}
          {lista.map((pr) => (
            <tr key={pr.id} id={"prov-" + pr.nome} className={pr.ativo ? "" : "op-60"}>
              <td>
                <b className="mono">{pr.nome}</b>
                <span className="sub2 block">
                  {pr.publico ? "público — todo mundo vê" : "privado — só quem é desta conta"} ·{" "}
                  {pr.escopo === "*" ? "conta do operador" : `escopo: ${pr.escopo}`}
                </span>
              </td>
              <td className="mono break-all">
                {pr.tipo === "ollama" ? "ollama" : "openai"} · {pr.base_url}
              </td>
              <td className="mono break-all">
                {pr.modelos.length ? pr.modelos.join(" · ") : pr.modelo || "—"}
              </td>
              <td>
                {pr.padrao ? (
                  <span className="chip chip-verde">padrão</span>
                ) : pr.ativo ? (
                  <span className="chip chip-verde">ativo</span>
                ) : (
                  <span className="chip">inativo</span>
                )}
                <span className="chip">{pr.publico ? "público" : "privado"}</span>
                {pr.chave_mascarada ? <span className="chip">{pr.chave_mascarada}</span> : null}
              </td>
              {operador && (
                <td className="text-right">
                  <button className="btn btn-mini" disabled={rodando === pr.nome} onClick={() => void descobrir(pr)}>
                    modelos
                  </button>
                  {!pr.padrao && (
                    <button className="btn btn-mini ml-1" disabled={rodando === pr.nome} onClick={() => void definirPadrao(pr)}>
                      padrão
                    </button>
                  )}
                  <button
                    className="btn btn-mini ml-1"
                    title={pr.publico ? "tornar privado (só esta conta vê)" : "tornar público (todos veem)"}
                    disabled={rodando === pr.nome}
                    onClick={() => void alternarPublico(pr)}
                  >
                    {pr.publico ? "tornar privado" : "tornar público"}
                  </button>
                  <button className="btn btn-mini ml-1" disabled={rodando === pr.nome} onClick={() => void alternar(pr)}>
                    {pr.ativo ? "desligar" : "ligar"}
                  </button>
                  <button className="btn btn-mini ml-1" disabled={rodando === pr.nome} onClick={() => preencherNomeado(pr)}>
                    {editando === pr.nome && formNomeadoAberto ? "editando…" : "editar"}
                  </button>
                  <button className="btn btn-mini ml-1" disabled={rodando === pr.nome} onClick={() => void apagarNomeado(pr)}>
                    apagar
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {operador && !formNomeadoAberto && (
        <button
          id="btnNovoProvedor"
          className="btn mt-3 self-start"
          onClick={() => {
            setEditando(null);
            setFormNomeadoAberto(true);
          }}
        >
          + novo provider
        </button>
      )}

      {/* form de criação/edição dos providers nomeados */}
      {formNomeadoAberto && operador && (
        <div className="mt-3 flex max-w-[560px] flex-col gap-3 border-t border-borda pt-3" id="formNovoProvedor">
          <label className="rotulo m-0">
            nome (é o que aparece no seletor do chat)
            <input id="provNome" className="campo mt-1" value={novo.nome} placeholder="ex.: claude, gemini, llama-local"
              disabled={Boolean(editando)} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
          </label>
          <label className="rotulo m-0">
            tipo
            <select id="provTipo" className="campo mt-1" value={novo.tipo} onChange={(e) => setNovo({ ...novo, tipo: e.target.value })}>
              <option value="openai">OpenAI compatível (llama.cpp, LiteLLM, vLLM...)</option>
              <option value="ollama">Ollama local</option>
            </select>
          </label>
          <label className="rotulo m-0">
            URL do serviço
            <input id="provUrlNomeado" className="campo mt-1 mono" value={novo.base_url} placeholder="https://gw.exemplo.com/v1"
              onChange={(e) => setNovo({ ...novo, base_url: e.target.value })} />
          </label>
          <label className="rotulo m-0">
            chave {editando ? "(deixe em branco para manter a atual)" : ""}
            <input id="provChaveNomeado" className="campo mt-1 mono" type="password" value={novo.chave} placeholder={editando ? "••••••" : "sk-…"}
              onChange={(e) => setNovo({ ...novo, chave: e.target.value })} />
          </label>
          <label className="rotulo m-0">
            modelo preferido (o chat pode trocar por outro descoberto)
            <input id="provModeloNomeado" className="campo mt-1 mono" value={novo.modelo} placeholder="ex.: claude-sonnet-4-20250514"
              onChange={(e) => setNovo({ ...novo, modelo: e.target.value })} />
          </label>
          <label className="check">
            <input id="provGlobal" type="checkbox" checked={novo.paraTodos}
              onChange={(e) => setNovo({ ...novo, paraTodos: e.target.checked })} />
            pertence à conta do operador (global) — desmarcado, fica no escopo desta conta
          </label>
          <label className="check">
            <input id="provPublico" type="checkbox" checked={novo.publico}
              onChange={(e) => setNovo({ ...novo, publico: e.target.checked })} />
            público — qualquer conta vê e pode escolher no chat (desmarcado: privado, só quem é desta conta)
          </label>
          <label className="check">
            <input id="provPadrao" type="checkbox" checked={novo.padrao}
              onChange={(e) => setNovo({ ...novo, padrao: e.target.checked })} />
            padrão — quem vê este provedor e não escolhe outro usa ele
          </label>
          <div>
            <button id="btnSalvarProvedor" className="btn" disabled={rodando === "form"} onClick={() => void salvarNomeado()}>
              {editando ? "salvar mudanças" : "cadastrar"}
            </button>
            <button className="btn btn-mini ml-2" onClick={() => { setFormNomeadoAberto(false); setEditando(null); setNovo({ nome: "", tipo: "openai", base_url: "", chave: "", modelo: "", paraTodos: true, publico: true, padrao: false, escopoOrig: "global" }); }}>
              fechar
            </button>
          </div>
        </div>
      )}

    </div>
  );
}


/* ------------------------------------------------------- comportamento do agente */

/** v3.69 (pedido do dono): seção própria para o COMPORTAMENTO da CONTA — instruções,
 *  rodadas, memória, intactas e compactação. Vale para TODO provedor: a linha do provedor
 *  define o SERVIÇO (URL, chave, modelo, público/padrão), a conta define o comportamento. */
function Comportamento({ operador, tenant }: { operador: boolean; tenant: string }) {
  const { toast } = useToast();
  const [p, setP] = useState<ProviderResp | null>(null);
  const [prompt, setPrompt] = useState("");
  const [rodadas, setRodadas] = useState("5");
  const [memoria, setMemoria] = useState("12");
  const [verbatim, setVerbatim] = useState("20");
  /* v3.56 — compactação com a mecânica do mini-compress (gatilho + tetos das partes A/B/C) */
  const [thresholdK, setThresholdK] = useState("200");
  const [percentual, setPercentual] = useState("90");
  const [tailCap, setTailCap] = useState("80000");
  const [pairsCap, setPairsCap] = useState("40000");
  const [summaryCap, setSummaryCap] = useState("12000");
  const [maxPairs, setMaxPairs] = useState("8");
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await get<ProviderResp>("/config/provider" + (operador && tenant ? "?" + qs({ tenant }) : ""));
      setP(r);
      /* v3.35.1: o cartão mostra o que o SERVIDOR tem, não o que sobrou de um clique anterior */
      setPrompt(r.system_prompt ?? "");
      setRodadas(String(r.max_rodadas));
      setMemoria(String(r.memoria_turnos ?? 12));
      setVerbatim(String(r.verbatim_turnos ?? 20));
      setThresholdK(String(r.comp?.thresholdK ?? 200));
      setPercentual(String(r.comp?.percentualJanela ?? 90));
      setTailCap(String(r.comp?.tailCharsCap ?? 80000));
      setPairsCap(String(r.comp?.pairsBlockCap ?? 40000));
      setSummaryCap(String(r.comp?.summaryCharsCap ?? 12000));
      setMaxPairs(String(r.comp?.maxPairs ?? 8));
    } catch (e) {
      toast("comportamento: " + (e as Error).message, "erro");
    }
  }, [operador, tenant, toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /** as instruções são da conta e salvam junto do resto do comportamento, sem tocar em provider */
  async function salvarInstrucoes(texto: string) {
    setOcupado(true);
    try {
      const r = await put<{
        system_prompt: string;
        tem_system_prompt: boolean;
        max_rodadas: number;
        memoria_turnos: number;
        verbatim_turnos: number;
        comp?: ProviderResp["comp"];
      }>("/config/instrucoes", {
        texto,
        max_rodadas: Number(rodadas),
        memoria_turnos: Number(memoria),
        verbatim_turnos: Number(verbatim),
        threshold_k: Number(thresholdK),
        compactacao_percent: Number(percentual),
        tail_chars_cap: Number(tailCap),
        pairs_block_cap: Number(pairsCap),
        summary_chars_cap: Number(summaryCap),
        max_pairs: Number(maxPairs),
        ...(operador && tenant ? { tenant } : {}),
      });
      setP((atual) =>
        atual
          ? {
              ...atual,
              system_prompt: r.system_prompt,
              tem_system_prompt: r.tem_system_prompt,
              max_rodadas: r.max_rodadas,
              memoria_turnos: r.memoria_turnos,
              verbatim_turnos: r.verbatim_turnos,
              ...(r.comp ? { comp: r.comp } : {}),
            }
          : atual,
      );
      toast("comportamento salvo — vale para todos os providers", "sucesso");
      await carregar();
    } catch (e) {
      toast("salvar instruções: " + (e as Error).message, "erro");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="cartao">
      <h2 className="mb-1 text-[13px] font-semibold text-txt2">
        Comportamento do agente
        <span className="sub2 block font-normal">
          o que a conta MANDA no modelo — vale para <b>todos</b> os providers; o chat obedece estes números, não a linha do provedor
        </span>
      </h2>

      <div className="mt-3 rounded-[10px] border border-borda p-3" id="cardInstrucoes">
        <div className="rotulo m-0">instruções e comportamento do modelo</div>
        <span className="sub2 block font-normal">
          valem para <b>todos</b> os providers e modelos desta conta — é exatamente o que o modelo recebe
        </span>
        <textarea
          id="provPrompt"
          className="campo mt-2 w-full"
          rows={8}
          value={prompt}
          disabled={!operador}
          placeholder="ex.: seu nome é Clauricio; responda curto, citando o documento."
          onChange={(e) => setPrompt(e.target.value)}
        />
        <span className="dica mt-1 block" id="provPromptDica">
          {`${prompt.length} caracteres`}
          {p?.tem_system_prompt ? " · em uso" : " · vazio = conversa pura"}
        </span>
        {/* v3.55: rodadas, memória e intactas são da CONTA (como as instruções) — saíram do
            formulário do provider, que passou a falar só do serviço e do modelo. */}
        <div className="grade-2 !gap-3 mt-3">
          <label className="rotulo m-0">
            rodadas do agente (loop de ferramentas; ao bater o teto ele para e avisa)
            <input
              id="provRodadas"
              className="campo mt-1"
              value={rodadas}
              disabled={!operador}
              onChange={(e) => setRodadas(e.target.value)}
            />
            <span className="dica mt-1 block">0 = nunca chamar ferramenta (0 a 60; padrão 5)</span>
          </label>
          <label className="rotulo m-0">
            memória da conversa (mensagens)
            <input
              id="provMemoria"
              className="campo mt-1"
              value={memoria}
              disabled={!operador}
              onChange={(e) => setMemoria(e.target.value)}
            />
            <span className="dica mt-1 block">quantas mensagens antigas desta gaveta voltam ao modelo · 0 = sem memória</span>
          </label>
        </div>
        <div className="grade-2 !gap-3 mt-3">
          <label className="rotulo m-0">
            últimas intactas na compactação
            <input
              id="provVerbatim"
              className="campo mt-1"
              value={verbatim}
              disabled={!operador}
              onChange={(e) => setVerbatim(e.target.value)}
            />
            <span className="dica mt-1 block">
              as últimas N vão verbatim para o modelo (0 a 50; padrão 20) — é o <span className="mono">protect_last_n</span>
            </span>
          </label>
        </div>

        {/* v3.56 — compactação com a MESMA mecânica do mini-compress do Hermes:
            gatilho por tamanho + cascata C (verbatim) / B (pares) / A (resumo). */}
        <div className="mt-4 rounded-[8px] border border-borda p-3" id="cardCompactacao">
          <div className="rotulo m-0">compactação de contexto</div>
          <span className="sub2 block font-normal">
            igual à do Hermes: <b>só age quando o gatilho é atingido</b> — abaixo dele, o histórico vai inteiro.
            Acima, cascata C → B → A (verbatim → pares → resumo), nada se perde.
          </span>
          <div className="grade-2 !gap-3 mt-3">
            <label className="rotulo m-0">
              gatilho (milhares de tokens)
              <input
                id="provThresholdK"
                className="campo mt-1"
                value={thresholdK}
                disabled={!operador}
                onChange={(e) => setThresholdK(e.target.value)}
              />
              <span className="dica mt-1 block">
                200 = 200k · 0 = nunca · vale o menor entre isto e 90% da janela do modelo (<span className="mono">threshold_k</span>)
              </span>
            </label>
            <label className="rotulo m-0">
              teto de segurança (% da janela)
              <input
                id="provPercentualJanela"
                className="campo mt-1"
                value={percentual}
                disabled={!operador}
                onChange={(e) => setPercentual(e.target.value)}
              />
              <span className="dica mt-1 block">
                o gatilho é o MENOR entre o número ao lado e esta fatia da janela (1 a 100; padrão 90)
              </span>
            </label>
          </div>
          <div className="grade-2 !gap-3 mt-3">
            <label className="rotulo m-0">
              pares pedido → conclusão
              <input
                id="provMaxPairs"
                className="campo mt-1"
                value={maxPairs}
                disabled={!operador}
                onChange={(e) => setMaxPairs(e.target.value)}
              />
              <span className="dica mt-1 block">quantos pares íntegros ficam no bloco B (0 a 20; padrão 8)</span>
            </label>
          </div>
          <div className="grade-2 !gap-3 mt-3">
            <label className="rotulo m-0">
              teto da cauda verbatim (caracteres)
              <input
                id="provTailCap"
                className="campo mt-1"
                value={tailCap}
                disabled={!operador}
                onChange={(e) => setTailCap(e.target.value)}
              />
              <span className="dica mt-1 block">parte C · 80000 = 20K tokens (<span className="mono">tail_chars_cap</span>)</span>
            </label>
            <label className="rotulo m-0">
              teto dos pares (caracteres)
              <input
                id="provPairsCap"
                className="campo mt-1"
                value={pairsCap}
                disabled={!operador}
                onChange={(e) => setPairsCap(e.target.value)}
              />
              <span className="dica mt-1 block">parte B · 40000 = 10K tokens (<span className="mono">pairs_block_cap</span>)</span>
            </label>
          </div>
          <div className="grade-2 !gap-3 mt-3">
            <label className="rotulo m-0">
              teto do resumo (caracteres)
              <input
                id="provSummaryCap"
                className="campo mt-1"
                value={summaryCap}
                disabled={!operador}
                onChange={(e) => setSummaryCap(e.target.value)}
              />
              <span className="dica mt-1 block">parte A · 12000 = 3K tokens (<span className="mono">summary_chars_cap</span>)</span>
            </label>
          </div>
        </div>
        {operador ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn btn-mini" id="provPromptSalvar" onClick={() => void salvarInstrucoes(prompt)} disabled={ocupado}>
              {ocupado ? "salvando…" : "salvar"}
            </button>
            {p?.regras_padrao && prompt.trim() !== p.regras_padrao.trim() ? (
              <button
                type="button"
                className="btn btn-mini"
                id="provPromptPadrao"
                onClick={() => {
                  setPrompt(p.regras_padrao ?? "");
                  void salvarInstrucoes(p.regras_padrao ?? "");
                }}
              >
                restaurar instruções padrão
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- ferramentas */

function Ferramentas({ operador, tenant, onControleMaquinas }: { operador: boolean; tenant: string; onControleMaquinas?: (v: boolean) => void }) {
  const { toast } = useToast();
  const [p, setP] = useState<ProviderResp | null>(null);
  const [servidores, setServidores] = useState<ServidorMcp[]>([]);
  const [novo, setNovo] = useState({ nome: "", url: "", cabecalho: "" });
  const [mostrarNovo, setMostrarNovo] = useState(false);
  const [rodando, setRodando] = useState<string | null>(null);
  const [controleMaq, setControleMaq] = useState(true);
  const [rodandoMaq, setRodandoMaq] = useState(false);
  const [mcpUsuarios, setMcpUsuarios] = useState(true);
  const [rodandoMcpUsuarios, setRodandoMcpUsuarios] = useState(false);
  const [resultado, setResultado] = useState<TesteMcpResp | null>(null);

  const carregar = useCallback(async () => {
    try {
      setP(await get<ProviderResp>("/config/provider" + (operador && tenant ? "?" + qs({ tenant }) : "")));
    } catch {
      setP(null);
    }
    try {
      const rMcp = await get<ServidoresResp>("/config/mcp");
      setServidores(rMcp.servidores);
      setControleMaq(rMcp.controle_maquinas !== false);
      setMcpUsuarios(rMcp.usuarios_habilitado !== false);
      onControleMaquinas?.(rMcp.controle_maquinas !== false);
    } catch (e) {
      toast("servidores MCP: " + (e as Error).message, "erro");
    }
  }, [operador, tenant, toast, onControleMaquinas]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function ligarMaquinasControle(valor: boolean) {
    setRodandoMaq(true);
    try {
      const r = await patch<{ controle_maquinas: boolean }>("/config/mcp/maquinas", { ativo: valor });
      setControleMaq(r.controle_maquinas);
      onControleMaquinas?.(r.controle_maquinas);
      toast(valor ? "controle das máquinas ligado" : "controle das máquinas desligado — ninguém executa (chat, MCP e REST)", "sucesso");
    } catch (e) {
      toast("controle das máquinas: " + (e as Error).message, "erro");
    } finally {
      setRodandoMaq(false);
    }
  }

  async function ligarMcpUsuarios(valor: boolean) {
    setRodandoMcpUsuarios(true);
    try {
      const r = await patch<{ usuarios_habilitado: boolean }>("/config/mcp/usuarios", { ativo: valor });
      setMcpUsuarios(r.usuarios_habilitado);
      toast(valor ? "contas liberadas para usar o MCP" : "MCP restrito ao operador", "sucesso");
    } catch (e) {
      toast("MCP para contas: " + (e as Error).message, "erro");
    } finally {
      setRodandoMcpUsuarios(false);
    }
  }

  /** o botão fica na config do provider — grava só este campo, preservando o resto */
  async function ligarInterno(valor: boolean) {
    if (!p) return;
    setRodando("interno");
    try {
      const r = await put<ProviderResp>("/config/provider", {
        tipo: p.tipo,
        base_url: p.base_url,
        modelo: p.modelo,
        temperatura: p.temperatura,
        max_rodadas: p.max_rodadas,
        ativo: p.ativo,
        global: operador && p.origem === "global",
        mcp_interno: valor,
      });
      setP(r);
      toast(valor ? "ferramentas do nexos ligadas no chat" : "ferramentas do nexos desligadas", "sucesso");
    } catch (e) {
      toast("mcp interno: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  async function adicionar() {
    setRodando("novo");
    try {
      await post<ServidorMcp>("/config/mcp", novo);
      setNovo({ nome: "", url: "", cabecalho: "" });
      setMostrarNovo(false);
      toast("servidor MCP cadastrado", "sucesso");
      await carregar();
    } catch (e) {
      toast("cadastrar: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  async function testar(nome: string) {
    setRodando(nome);
    setResultado(null);
    try {
      const r = await post<TesteMcpResp>("/config/mcp/testar", { nome });
      setResultado(r);
      toast(`${r.ferramentas} ferramenta(s) em ${r.nome} · ${r.ms} ms`, "sucesso");
      await carregar();
    } catch (e) {
      toast("testar: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  async function alternar(s: ServidorMcp) {
    setRodando(s.nome);
    try {
      await patch<ServidorMcp>(`/config/mcp/${encodeURIComponent(s.nome)}`, { ativo: !s.ativo });
      await carregar();
    } catch (e) {
      toast("ligar/desligar: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  async function apagar(s: ServidorMcp) {
    if (!confirm(`tirar o servidor MCP '${s.nome}'? o chat perde as ${s.ferramentas} ferramenta(s) dele.`)) return;
    setRodando(s.nome);
    try {
      await del(`/config/mcp/${encodeURIComponent(s.nome)}`);
      toast("servidor removido", "sucesso");
      await carregar();
    } catch (e) {
      toast("remover: " + (e as Error).message, "erro");
    } finally {
      setRodando(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="cartao">
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">MCP do próprio nexos</h2>
        <p className="dica mt-0 mb-3">
          ligado, o chat pode chamar as ferramentas deste servidor (buscar, listar, criar gaveta, ver documentos…).
          As ferramentas <b>executam direto</b>, sem pedir confirmação — o que foi chamado fica registrado embaixo da resposta.
        </p>
        <label className="check">
          <input
            id="mcpInterno"
            type="checkbox"
            checked={Boolean(p?.mcp_interno)}
            disabled={!p || rodando === "interno"}
            onChange={(e) => void ligarInterno(e.target.checked)}
          />
          dar as ferramentas do nexos ao chat
        </label>
        {p?.mcp_interno && <p className="dica mt-2 mb-0" id="mcpInternoAviso">Sem nenhuma ferramenta ligada, o modelo só conversa com o que sabe.</p>}
      </div>

      <div className="cartao">
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">Controle das máquinas</h2>
        <p className="dica mt-0 mb-3">
          ligado, o chat e as ferramentas MCP podem executar comandos nas máquinas cadastradas (aba Máquinas). Desligado,{' '}
          <b>ninguém executa</b>: chat, servidores MCP externos e a rota REST são barrados — as máquinas continuam online,
          a listagem e o histórico de execuções ficam preservados. {operador ? "" : "Só o operador liga e desliga."}
        </p>
        <label className="check">
          <input
            id="mcpControleMaquinas"
            type="checkbox"
            checked={controleMaq}
            disabled={!operador || rodandoMaq}
            onChange={(e) => void ligarMaquinasControle(e.target.checked)}
          />
          deixar as máquinas executarem comandos
        </label>
        {!controleMaq && (
          <p className="dica mt-2 mb-0" id="mcpControleMaquinasAviso">
            Controle desligado: a ferramenta de executar some do chat e da lista MCP, e o servidor recusa qualquer ordem —
            para voltar, marque de novo.
          </p>
        )}
      </div>

      {/* v3.36 — o dono decide se as contas comuns podem usar o nexos como SERVIDOR MCP
          (aba MCP do menu). Ligado por padrão para não calar os agentes que já conversam. */}
      <div className="cartao">
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">Usar o nexos como servidor MCP</h2>
        <p className="dica mt-0 mb-3">
          ligado, cada conta pode apontar o agente dela para o endereço MCP do nexos (aba <b>MCP</b> do menu) e
          escolher, na tela, quais ferramentas quer liberar. As ferramentas de operador continuam só do operador, e
          ferramenta nova nasce liberada. Desligado, <b>só o operador</b> usa o MCP. {operador ? "" : "Só o operador liga e desliga."}
        </p>
        <label className="check">
          <input
            id="mcpUsuariosHabilitado"
            type="checkbox"
            checked={mcpUsuarios}
            disabled={!operador || rodandoMcpUsuarios}
            onChange={(e) => void ligarMcpUsuarios(e.target.checked)}
          />
          deixar as contas usarem o nexos como servidor MCP
        </label>
        {!mcpUsuarios && (
          <p className="dica mt-2 mb-0" id="mcpUsuariosAviso">
            Desligado: as contas comuns recebem 403 no MCP; o operador continua entrando para poder reverter.
          </p>
        )}
      </div>

      <div className="cartao">
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">Servidores MCP externos</h2>
        <p className="dica mt-0 mb-3">
          cada servidor empresta as ferramentas dele ao chat, pelo endereço HTTP (protocolo MCP). O cabeçalho de acesso fica
          guardado no servidor e nunca volta em claro. {operador ? "" : "Só o operador cadastra."}
        </p>
        <table className="tabela" id="listaMcp">
          <thead>
            <tr>
              <th>servidor</th>
              <th>endereço</th>
              <th>ferramentas</th>
              <th>acesso</th>
              <th>estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {servidores.length === 0 && (
              <tr>
                <td colSpan={6} className="dica">
                  nenhum servidor cadastrado
                </td>
              </tr>
            )}
            {servidores.map((s) => (
              <tr key={s.nome} id={"mcp-" + s.nome}>
                <td>
                  <b className="mono">{s.nome}</b>
                </td>
                <td className="mono break-all">{s.url}</td>
                <td>
                  <b>{s.ferramentas}</b>
                  {s.nomes.length > 0 && (
                    <span className="sub2 mono block break-all">
                      {s.nomes.slice(0, 3).join(", ")}
                      {s.nomes.length > 3 ? ` +${s.nomes.length - 3}` : ""}
                    </span>
                  )}
                  {s.ferramentas === 0 && <span className="sub2 block">nenhuma listada ainda</span>}
                </td>
                <td className="mono">{s.tem_cabecalho ? s.cabecalho_mascarado : "sem cabeçalho"}</td>
                <td>
                  {s.ativo ? (
                    <span className="chip chip-verde">ligado</span>
                  ) : (
                    <span className="chip">desligado</span>
                  )}
                  {s.erro ? <span className="sub2 block">último erro: {s.erro.slice(0, 60)}</span> : null}
                </td>
                <td className="text-right">
                  {operador && (
                    <>
                      <button className="btn btn-mini" disabled={rodando === s.nome} onClick={() => void testar(s.nome)}>
                        atualizar ferramentas
                      </button>
                      <button className="btn btn-mini ml-1" disabled={rodando === s.nome} onClick={() => void alternar(s)}>
                        {s.ativo ? "desligar" : "ligar"}
                      </button>
                      <button className="btn btn-mini ml-1" disabled={rodando === s.nome} onClick={() => void apagar(s)}>
                        apagar
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {resultado && (
          <p className="text-[13px] text-verde mt-2 mb-0" id="mcpTesteResultado">
            ✓ {resultado.nome} respondeu em {resultado.ms} ms · {resultado.ferramentas} ferramenta(s):{" "}
            <span className="mono">{resultado.nomes.slice(0, 8).join(", ")}</span>
            {resultado.nomes.length > 8 ? "…" : ""}
          </p>
        )}

        {operador && !mostrarNovo && (
          <button id="btnNovoMcp" className="btn mt-3 self-start" onClick={() => setMostrarNovo(true)}>
            + adicionar servidor MCP
          </button>
        )}
        {operador && mostrarNovo && (
          <div className="mt-3 flex max-w-[560px] flex-col gap-3 border-t border-borda pt-3" id="formNovoMcp">
            <label className="rotulo m-0">
              nome (aparece na frente de cada ferramenta: nome__buscar)
              <input id="mcpNome" className="campo mt-1" value={novo.nome} placeholder="ex.: drive-prod" onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
            </label>
            <label className="rotulo m-0">
              endereço HTTP do servidor MCP
              <input id="mcpUrl" className="campo mt-1 mono" value={novo.url} placeholder="https://mcp.exemplo.com/mcp" onChange={(e) => setNovo({ ...novo, url: e.target.value })} />
            </label>
            <label className="rotulo m-0">
              cabeçalho de acesso (opcional)
              <input
                id="mcpCabecalho"
                type="password"
                autoComplete="new-password"
                className="campo mt-1 mono"
                value={novo.cabecalho}
                placeholder="Authorization: Bearer xxx ou só o token"
                onChange={(e) => setNovo({ ...novo, cabecalho: e.target.value })}
              />
            </label>
            <div className="flex gap-2">
              <button id="mcpAdicionar" className="btn btn-primario" disabled={rodando === "novo" || !novo.nome || !novo.url} onClick={() => void adicionar()}>
                cadastrar e listar ferramentas
              </button>
              <button className="btn btn-sutil" onClick={() => setMostrarNovo(false)}>
                cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- conta */

function Conta({ nome, operador, onChaveNova }: { nome: string; operador: boolean; onChaveNova: (c: string) => void }) {
  const { toast } = useToast();
  const [nova, setNova] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function gerar() {
    if (!confirm("gerar chave nova? a chave atual para de funcionar na hora.")) return;
    setOcupado(true);
    try {
      const r = await post<{ chave: string; aviso: string }>(`/usuarios/${encodeURIComponent(nome)}/chave`);
      setNova(r.chave);
      onChaveNova(r.chave);
      toast("chave trocada — guarde a nova", "sucesso");
    } catch (e) {
      toast("chave: " + (e as Error).message, "erro");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Conta e chave</h2>
      <div className="flex max-w-[520px] flex-col gap-3">
        <div className="it-linha">
          <span className="sub2">usuário</span>
          <b>{nome}</b>
        </div>
        <div className="it-linha">
          <span className="sub2">papel</span>
          <span>{operador ? "admin (vê tudo)" : "usuário"}</span>
        </div>
        <div className="it-linha">
          <span className="sub2">chave</span>
          <span className="mono">•••••••• (guardada com hash — não é possível mostrar)</span>
        </div>
        <div className="flex gap-2 border-t border-borda pt-3">
          <button id="btnNovaChave" className="btn" disabled={ocupado} onClick={() => void gerar()}>
            gerar chave nova
          </button>
        </div>
        {nova && (
          <div className="aviso" id="chaveNova">
            <div>
              <b>guarde agora — não aparece de novo:</b>
              <div className="mono mt-1 select-all break-all">{nova}</div>
            </div>
            <button
              className="btn btn-mini ml-auto"
              onClick={() => {
                void navigator.clipboard?.writeText(nova);
                toast("chave copiada", "sucesso");
              }}
            >
              copiar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- limites */

function Limites() {
  const { toast } = useToast();
  const [c, setC] = useState<ConfigResp | null>(null);

  useEffect(() => {
    void get<ConfigResp>("/config")
      .then(setC)
      .catch((e) => toast("config: " + (e as Error).message, "erro"));
  }, [toast]);

  if (!c) return <div className="cartao dica">carregando…</div>;
  const l = c.limites;
  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Limites em vigor</h2>
      <table className="tabela">
        <tbody>
          <tr><td>Tamanho de um documento</td><td><b>{l.max_content_chars.toLocaleString("pt-BR")}</b> caracteres</td></tr>
          <tr><td>Tamanho da pergunta</td><td><b>{l.max_query_chars.toLocaleString("pt-BR")}</b> caracteres</td></tr>
          <tr><td>Trechos por usuário (cota)</td><td><b>{l.max_chunks_tenant.toLocaleString("pt-BR")}</b></td></tr>
          <tr><td>Trechos por busca (padrão)</td><td><b>{l.top_k}</b></td></tr>
          <tr><td>Similaridade mínima</td><td><b>{l.min_score}</b></td></tr>
          <tr><td>Pedaço do documento</td><td><b>{l.chunk_palavras}</b> palavras ({l.chunk_sobreposicao} de sobreposição)</td></tr>
          <tr><td>Páginas por PDF escaneado</td><td><b>{l.ocr_paginas_max}</b> páginas</td></tr>
        </tbody>
      </table>
      <p className="dica mt-3 mb-0">estes números vêm do ambiente do servidor; para mudar, ajuste as variáveis e o operador redeploya</p>
    </div>
  );
}

/* ---------------------------------------------------------- esquecimento */

function Esquecimento() {
  const { toast } = useToast();
  const [c, setC] = useState<ConfigResp | null>(null);
  const [rodando, setRodando] = useState(false);
  /* v3.5: os três números (arquivar / morte do arquivado / carência) editáveis */
  const [form, setForm] = useState<{ dias_arquivar: string; dias_excluir_arquivado: string; dias_carencia: string } | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(() => {
    void get<ConfigResp>("/config")
      .then((r) => {
        setC(r);
        setForm({
          dias_arquivar: String(r.esquecimento.dias_arquivar),
          dias_excluir_arquivado: String(r.esquecimento.dias_excluir_arquivado),
          dias_carencia: String(r.esquecimento.dias_carencia),
        });
      })
      .catch((e) => toast("config: " + (e as Error).message, "erro"));
  }, [toast]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function salvar() {
    if (!form) return;
    setSalvando(true);
    try {
      const r = await put<{ efetivos: Record<string, number> }>("/config/esquecimento", {
        dias_arquivar: Number(form.dias_arquivar),
        dias_excluir_arquivado: Number(form.dias_excluir_arquivado),
        dias_carencia: Number(form.dias_carencia),
      });
      toast(`esquecimento salvo: arquiva em ${r.efetivos.dias_arquivar}d, apaga arquivado em ${r.efetivos.dias_excluir_arquivado}d, carência ${r.efetivos.dias_carencia}d`, "sucesso");
      carregar(); // prova de escrita: reler
    } catch (e) {
      toast("salvar esquecimento: " + (e as Error).message, "erro");
    } finally {
      setSalvando(false);
    }
  }

  async function rodar() {
    setRodando(true);
    try {
      const r = await post<{ docs_arquivados_agora: number; expurgo?: { usuarios_apagados: string[]; docs_expurgados: number } }>("/decay", {});
      const ex = r.expurgo;
      const extra = ex && (ex.usuarios_apagados.length || ex.docs_expurgados)
        ? ` · faxina: ${ex.usuarios_apagados.length} conta(s), ${ex.docs_expurgados} arquivado(s) apagado(s)`
        : "";
      toast(`arquivados agora: ${r.docs_arquivados_agora}${extra}`, "sucesso");
    } catch (e) {
      toast("esquecimento: " + (e as Error).message, "erro");
    } finally {
      setRodando(false);
    }
  }

  if (!c || !form) return <div className="cartao dica">carregando…</div>;
  const e = c.esquecimento;
  const campo = (chave: "dias_arquivar" | "dias_excluir_arquivado" | "dias_carencia", rotulo: string, dica: string) => (
    <label className="rotulo m-0">
      {rotulo}
      <input
        id={`esq-${chave}`}
        type="number"
        min={0}
        max={36500}
        className="campo mt-1"
        value={form[chave]}
        onChange={(ev) => setForm({ ...form, [chave]: ev.target.value })}
      />
      <span className="text-[11px] text-txt3">{dica}</span>
    </label>
  );
  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Esquecimento</h2>
      <div className="flex max-w-[560px] flex-col gap-3">
        <div className="it-linha"><span className="sub2">situação</span><b>{e.ativo ? "ligado" : "desligado"}</b></div>
        {campo("dias_arquivar", "dias sem uso até ARQUIVAR", "documento esquecido sai da busca mas revive ao ser usado (padrão 180 = 6 meses)")}
        {campo("dias_excluir_arquivado", "dias arquivado até APAGAR de vez", "arquivado encostado por mais que isto é excluído sem volta (padrão 365 = 1 ano)")}
        {campo("dias_carencia", "dias de carência ao apagar usuário", "janela para recriar o nome e desfazer; depois disto conta e dados somem (padrão 30)")}
        <div className="it-linha"><span className="sub2">origem dos valores</span><b>{Object.values(e.origem ?? {}).includes("tela") ? "tela (o que você salvar aqui)" : "padrão do servidor"}</b></div>
        <div className="it-linha"><span className="sub2">exige menos de</span><b>{e.min_acessos} acessos</b></div>
        <div className="it-linha"><span className="sub2">verifica a cada</span><b>{e.intervalo_minutos} minutos</b></div>
        <p className="dica m-0">arquivar não apaga: o documento volta ao ser usado. A exclusão definitiva só chega em quem já estava arquivado além da janela.</p>
        <div className="flex gap-2">
          <button id="btnSalvarEsquecimento" className="btn btn-primario self-start" disabled={salvando} onClick={() => void salvar()}>
            {salvando ? "salvando…" : "salvar"}
          </button>
          <button id="btnRodarDecay" className="btn self-start" disabled={rodando} onClick={() => void rodar()}>
            rodar agora (arquiva + faxina)
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- sistema */

function Sistema() {
  const { toast } = useToast();
  const [h, setH] = useState<HealthResp | null>(null);
  const [c, setC] = useState<ConfigResp | null>(null);

  useEffect(() => {
    void get<HealthResp>("/health").then(setH).catch((e) => toast("health: " + (e as Error).message, "erro"));
    void get<ConfigResp>("/config").then(setC).catch(() => undefined);
  }, [toast]);

  return (
    <div className="cartao">
      <h2 className="mb-3 text-[13px] font-semibold text-txt2">Sistema</h2>
      <div className="saude max-w-[520px]">
        <div className="it"><span className={"dot" + (h?.embedder === "ok" ? "" : " ruim")} /> motor de busca<span className="v">{h?.embedder ?? "?"}</span></div>
        <div className="it"><span className="dot" /> versão<span className="v mono">{h?.versao ?? c?.versao ?? "?"}</span></div>
        <div className="it"><span className="dot cinza" /> modelo de embedding<span className="v mono">{c?.modelo_embedding ?? "?"}</span></div>
      </div>
    </div>
  );
}
