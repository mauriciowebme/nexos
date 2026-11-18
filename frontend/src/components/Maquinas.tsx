import { useCallback, useEffect, useState } from "react";
import { baixarPorLink, del, get, patch, rodarAcao } from "../services/api";
import { useToast } from "./Toast";
import type { MaquinaLinha, MaquinasLogLinha, MaquinasResp } from "../types";

/* v3.6: máquinas do usuário (o túnel absorvido). Cada login comum vê e gerencia
   as SUAS; o admin vê todas (a tela só gera cliente para o usuário logado).
   A parede de verdade está na API (alvoMaquina escopa pelo login). */

function minutesAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "agora";
  if (s < 3600) return Math.floor(s / 60) + "min";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

export function Maquinas({ operador }: { operador: boolean }) {
  const { toast } = useToast();
  const [maquinas, setMaquinas] = useState<MaquinaLinha[]>([]);
  const [log, setLog] = useState<MaquinasLogLinha[]>([]);
  const [gerandoCli, setGerandoCli] = useState(false);
  /* v3.8: as ferramentas do vocabulário (túnel) também saem daqui, em modal */
  const [maqAcoes, setMaqAcoes] = useState<MaquinaLinha | null>(null);
  const [acaoSel, setAcaoSel] = useState<{ nome: string; desc: string; campos: string[] } | null>(null);
  const [argsAcao, setArgsAcao] = useState<Record<string, string>>({});
  const [rodandoAcao, setRodandoAcao] = useState(false);
  const [saidaAcao, setSaidaAcao] = useState<{ texto: string; erro: boolean } | null>(null);

  async function dispararAcao() {
    if (!maqAcoes || !acaoSel) return;
    setRodandoAcao(true);
    setSaidaAcao(null);
    const args: Record<string, unknown> = { host: maqAcoes.host };
    for (const [k, v] of Object.entries(argsAcao)) {
      const s = v.trim();
      if (!s) continue;
      /* a tela só conhece campos de texto: liga de volta os tipos que o schema cobra */
      if (k === "comandos") args[k] = s.split("\n").map((t) => t.trim()).filter(Boolean);
      else if (s === "true" || s === "false") args[k] = s === "true";
      else if (/^\d+$/.test(s)) args[k] = Number(s);
      else args[k] = s;
    }
    try {
      const texto = await rodarAcao(acaoSel.nome, args);
      setSaidaAcao({ texto, erro: false });
    } catch (e) {
      setSaidaAcao({ texto: (e as Error).message, erro: true });
    } finally {
      setRodandoAcao(false);
      carregar();
    }
  }

  async function gerarCliente(plat: "win" | "linux") {
    setGerandoCli(true);
    try {
      await baixarPorLink(plat);
      toast("cliente gerado — o download começou; o arquivo já é do teu usuário", "sucesso");
      carregar();
    } catch (e) {
      toast("gerar cliente: " + (e as Error).message, "erro");
    } finally {
      setGerandoCli(false);
    }
  }


  const carregar = useCallback(() => {
    void get<MaquinasResp>("/maquinas")
      .then((r) => {
        setMaquinas(r.maquinas);
      })
      .catch((e) => toast("máquinas: " + (e as Error).message, "erro"));
    void get<{ log: MaquinasLogLinha[] }>("/maquinas/log?limit=30")
      .then((r) => setLog(r.log))
      .catch(() => undefined);
  }, [toast]);

  useEffect(() => {
    carregar();
    const rel = setInterval(carregar, 8000);
    return () => clearInterval(rel);
  }, [carregar]);

  async function ativar(m: MaquinaLinha, ativo: boolean) {
    try {
      await patch(`/maquinas/${encodeURIComponent(m.host)}?tenant=${encodeURIComponent(m.tenant)}`, { ativo });
      toast(`${m.host} ${ativo ? "reativada" : "desativada"}`, "sucesso");
      carregar();
    } catch (e) {
      toast("interruptor: " + (e as Error).message, "erro");
    }
  }

  async function apagar(m: MaquinaLinha) {
    if (!window.confirm(`apagar a máquina ${m.host}? o cliente dela precisa ser re-pareado.`)) return;
    try {
      await del(`/maquinas/${encodeURIComponent(m.host)}?tenant=${encodeURIComponent(m.tenant)}`);
      toast(`${m.host} removida`, "sucesso");
      carregar();
    } catch (e) {
      toast("apagar: " + (e as Error).message, "erro");
    }
  }

  return (
    <section className="flex flex-col gap-3" id="telaMaquinas">
      <div className="barra">
        <div>
          <h1>Máquinas</h1>
          <div className="mt-1 text-[12.8px] text-txt3">{operador ? "todas as máquinas (admin)" : "as suas máquinas"}</div>
        </div>
      </div>

      <div className="cartao">
        <h3 className="mb-1 text-[13px] font-semibold text-txt2">Binários do cliente</h3>
        <p className="dica mt-0 mb-2">
          cada clique gera um cliente com a chave do teu usuário assada dentro: um arquivo só, dois cliques na
          máquina e pronto — e o mesmo arquivo serve para várias máquinas. A máquina se batiza sozinha com o nome real do computador. Clientes desta versão se auto-atualizam.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            id="btnGerarClienteWin"
            className="btn btn-primario"
            disabled={gerandoCli}
            onClick={() => void gerarCliente("win")}
          >
            {gerandoCli ? "gerando…" : "⬓ gerar meu cliente Windows"}
          </button>
          <button
            id="btnGerarClienteLinux"
            className="btn"
            disabled={gerandoCli}
            onClick={() => void gerarCliente("linux")}
          >
            ⬓ gerar meu cliente Linux
          </button>
        </div>
        <p className="dica mt-2 mb-0">
          primeiro acesso no Windows: o SmartScreen avisa (binário sem assinatura) — escolha Manter/mais
          informações e rode mesmo, é o seu próprio programa. <b>O mesmo arquivo instala em quantas máquinas
          você quiser</b> — cada uma aparece na tabela abaixo sozinha, e bloquear ou apagar é por linha.
        </p>
      </div>

      <table className="tabela" id="maquinasTabela">
        <thead>
          <tr>
            <th>máquina</th>
            {operador && <th>donos</th>}
            <th>sistema</th>
            <th className="num">estado</th>
            <th className="num">atividade</th>
            <th className="acoes">ações</th>
          </tr>
        </thead>
        <tbody>
          {maquinas.length === 0 && (
            <tr>
              <td colSpan={operador ? 6 : 5} className="py-3 text-center text-txt3">
                nenhuma máquina ainda — gere um token e rode o cliente nela
              </td>
            </tr>
          )}
          {maquinas.map((m) => (
            <tr key={m.tenant + "/" + m.host} id={"maq-" + m.host}>
              <td data-rot="máquina">
                <div className="font-medium">{m.host}</div>
                {m.nome && m.nome !== m.host && <div className="text-[11px] text-txt3">{m.nome}</div>}
              </td>
              {operador && (
                <td data-rot="donos">
                  <span className="chip">{m.tenant}</span>
                </td>
              )}
              <td data-rot="sistema">
                <div>{m.so || "—"}</div>
                {m.usuario_win ? <div className="text-[11px] text-txt3">{m.usuario_win}</div> : null}
              </td>
              <td className="num" data-rot="estado">
                {!m.ativo ? (
                  <span className="chip chip-vermelho" title="bloqueada: o servidor recusa a conexão; histórico e registros ficam">
                    ⛔ bloqueada
                  </span>
                ) : (
                  <span className={"chip " + (m.online ? "chip-verde" : "")} title={m.online ? "conectada agora" : "offline"}>
                    {m.online ? "● online" : "○ offline"}
                  </span>
                )}
              </td>
              <td className="num" data-rot="atividade">
                {/* v3.75: o que a máquina FEZ (comando) fica acima do aperto de mão (conexão),
                    que não se move enquanto o cano fica aberto — máquina trabalhando parecia parada */}
                <div className="whitespace-nowrap" title="último comando executado nesta máquina">
                  comando {minutesAgo(m.ultimo_comando_em)}
                </div>
                <div
                  className="whitespace-nowrap text-[11px] text-txt3"
                  title="abertura da conexão atual (aperto de mão do cliente)"
                >
                  conexão {minutesAgo(m.visto_em)}
                </div>
              </td>
              <td className="acoes">
                <label className="mr-2 inline-flex cursor-pointer items-center gap-1 text-[11px]" title="desligar barra comandos e derruba o cano da máquina">
                  <input
                    type="checkbox"
                    checked={m.ativo}
                    onChange={(e) => void ativar(m, e.target.checked)}
                  />
                  ativa
                </label>
                {m.online && (
                  <button
                    className="btn mr-1"
                    title="rodar uma ferramenta do vocabulário nesta máquina"
                    onClick={() => {
                      setMaqAcoes(m);
                      setAcaoSel(null);
                      setArgsAcao({});
                      setSaidaAcao(null);
                    }}
                  >
                    ferramentas
                  </button>
                )}
                <button className="btn btn-perigo" onClick={() => void apagar(m)}>
                  apagar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="cartao" id="maqLogCard">
        <h3 className="mb-2 text-[13px] font-semibold text-txt2">
          Histórico de execução <span className="sub2">— tudo o que foi rodado, sem máscara (auditoria)</span>
        </h3>
        {log.length === 0 ? (
          <div className="py-2 text-center text-[12px] text-txt3">nada rodou ainda</div>
        ) : (
          <table className="tabela" id="maqLogTabela">
            <thead>
              <tr>
                <th>quando</th>
                {operador && <th>donos</th>}
                <th>máquina</th>
                <th>comando</th>
                <th className="num">exit</th>
                <th className="num">ms</th>
                <th className="num">origem</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap text-[11px]">{new Date(l.criado_em).toLocaleString("pt-BR")}</td>
                  {operador && <td>{l.tenant}</td>}
                  <td>{l.host}</td>
                  <td className="max-w-[340px] truncate font-mono text-[11px]" title={(l.stdout || "") + (l.stderr ? "\n— stderr: " + l.stderr : "")}>
                    {l.cmd}
                  </td>
                  <td className={"num " + (l.exit === 0 ? "text-emerald-400" : "text-red-400")}>{l.exit}</td>
                  <td className="num">{l.ms}</td>
                  <td className="num">{l.origem}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {maqAcoes && (
        <div className="veu" role="dialog" aria-modal="true" aria-label="ferramentas da máquina" onClick={() => setMaqAcoes(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>ferramentas · {maqAcoes.nome || maqAcoes.host}</h3>
            <div className="flex flex-wrap gap-1 p-4">
              {ACOES_MAQUINA.map((a) => (
                <button
                  key={a.nome}
                  className={"btn btn-mini" + (acaoSel?.nome === a.nome ? " btn-primario" : "")}
                  title={a.desc}
                  onClick={() => {
                    setAcaoSel(a);
                    setArgsAcao({});
                    setSaidaAcao(null);
                  }}
                >
                  {a.nome}
                </button>
              ))}
            </div>
            {acaoSel && (
              <div className="px-4 pb-3">
                <div className="sub2 mb-2">{acaoSel.desc}</div>
                {acaoSel.campos.map((c) => (
                  <input
                    key={c}
                    className="campo mb-2"
                    placeholder={c}
                    value={argsAcao[c] ?? ""}
                    onChange={(e) => setArgsAcao((x) => ({ ...x, [c]: e.target.value }))}
                  />
                ))}
                <button className="btn btn-primario" disabled={rodandoAcao} onClick={() => void dispararAcao()}>
                  {rodandoAcao ? "rodando…" : "rodar"}
                </button>
              </div>
            )}
            {saidaAcao && (
              <pre
                className={
                  "m-4 max-h-56 overflow-auto whitespace-pre-wrap p-2 text-[11px]" + (saidaAcao.erro ? " text-red-400" : " text-txt2")
                }
              >
                {saidaAcao.texto.slice(0, 4000)}
              </pre>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* v3.8: o vocabulário do túnel, também clicável na tela (mesmas tools que o chat usa via MCP) */
const ACOES_MAQUINA: { nome: string; desc: string; campos: string[] }[] = [
  { nome: "listar_arquivos", desc: "lista uma pasta", campos: ["caminho", "padrao"] },
  { nome: "ler_arquivo", desc: "ler arquivo (texto ou base64)", campos: ["caminho", "offset", "limite"] },
  { nome: "escrever_arquivo", desc: "escrever arquivo de texto", campos: ["caminho", "conteudo"] },
  { nome: "buscar_arquivos", desc: "procurar arquivos por nome", campos: ["raiz", "nome"] },
  { nome: "grep_remoto", desc: "procurar dentro dos arquivos", campos: ["raiz", "padrao"] },
  { nome: "editar_no_local", desc: "editar arquivo na máquina", campos: ["caminho", "busca", "substituicao"] },
  { nome: "estado_maquina", desc: "SO, RAM, disco, IP", campos: [] },
  { nome: "processos", desc: "top processos por memória", campos: ["acao", "nome"] },
  { nome: "janelas", desc: "janelas visíveis", campos: ["acao", "titulo"] },
  { nome: "area_transferencia", desc: "ler a área de transferência", campos: ["acao", "texto"] },
  { nome: "falar", desc: "SAPI fala nos auto-falantes", campos: ["texto"] },
  { nome: "abrir", desc: "abrir como duplo-clique", campos: ["alvo"] },
  { nome: "servicos", desc: "serviços (listar/parar/iniciar)", campos: ["acao", "nome", "filtro"] },
  { nome: "eventos", desc: "eventos do Windows", campos: ["horas", "nivel"] },
  { nome: "rede", desc: "ping/DNS/portas a partir da máquina", campos: ["acao", "alvo"] },
  { nome: "esperar_arquivo", desc: "espera aparecer arquivo novo", campos: ["pasta", "padrao"] },
  { nome: "power", desc: "energia (recusa sem confirm)", campos: ["acao", "confirmar"] },
  { nome: "rodar_lote", desc: "vários comandos numa só ida", campos: ["comandos"] },
  { nome: "sessao", desc: "memória de pasta desta máquina", campos: ["acao", "nome", "pasta"] },
  { nome: "git_remoto", desc: "git numa pasta da máquina", campos: ["repo", "acao", "mensagem", "ref", "confirmar"] },
  { nome: "rodar_comando", desc: "shell cru no agente", campos: ["cmd", "timeout"] },
];
