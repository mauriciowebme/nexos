import { useCallback, useEffect, useState } from "react";
import { useSessao } from "./hooks/useSessao";
import { Login } from "./components/Login";
import { Gavetas } from "./components/Gavetas";
import { Arquivos } from "./components/Arquivos";
import { Editor } from "./components/Editor";
import { Painel } from "./components/Painel";
import { Chat } from "./components/Chat";
import { Conversas } from "./components/Conversas";
import { criarConversa, listarConversas } from "./lib/conversas";
import { Config, SECOES_CFG, type Aba } from "./components/Config";
import { Maquinas } from "./components/Maquinas";
import { Mcp } from "./components/Mcp";
import { get, qs } from "./services/api";
import type { GavetasResp, HealthResp, ProviderResp, Vista } from "./types";

/* A ordem é do dono (27/10, v3.26.1): Chat é o PRINCIPAL (primeiro item, é a porta
   de entrada do app); Painel logo abaixo. Usuários/Gavetas em cima de Configurações.
   Arquivos e Editor são passos internos (usuário → gaveta → arquivos → nota). */
/* v3.49 — o menu deixa os emojis (cada um de um tamanho e cor) e passa a usar
   o mesmo traço dos ícones do resto do sistema. */
const IC = {
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.3-.5L3 21l1.6-4.7A8.2 8.2 0 0 1 3.6 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8.4 8.4z" />,
  painel: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  maquinas: <><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  mcp: <><path d="M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-10 0V9zM12 17v4" /></>,
  arquivos: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2h7.3A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9z" />,
  gavetas: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></>,
  config: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
};

const MENU: { id: Vista; rotulo: string; icone: keyof typeof IC }[] = [
  { id: "chat", rotulo: "Chat", icone: "chat" },
  { id: "painel", rotulo: "Painel", icone: "painel" },
  { id: "maquinas", rotulo: "Máquinas", icone: "maquinas" },
  /* v3.36 — onde o usuário vê que a conta dele pode ser servidor MCP e escolhe o que liberar */
  { id: "mcp", rotulo: "MCP", icone: "mcp" },
  /* v3.48 (T050): Buscar e Fila viraram DENTRO da tela Arquivos (aba RAG) */
  { id: "arquivos", rotulo: "Arquivos", icone: "arquivos" },
  { id: "gavetas", rotulo: "Gavetas", icone: "gavetas" },
  { id: "config", rotulo: "Configurações", icone: "config" },
];

const DENTRO_DO_CAMINHO = new Set<Vista>(["gavetas", "arquivos", "editor"]);

/* v3.27 (dono, 27/10): a tela mora no ENDEREÇO (#/chat, #/painel, #/buscar...).
   O app é servido na raiz e o hash diz onde o usuário está: sobrevive ao F5,
   funciona no voltar/avançar e o link pode ser copiado com a tela certa. */
const VISTAS_TODAS: Vista[] = [
  "chat", "painel", "maquinas", "mcp", "buscar", "jobs", "gavetas", "config", "arquivos", "editor",
];

function vistaDoHash(): Vista | null {
  const bruto = window.location.hash.replace(/^#\/?/, "").trim();
  /* v3.48 (T050) — Buscar e Fila viraram abas de Arquivos: link salvo cai na tela nova */
  if (bruto === "buscar" || bruto === "fila" || bruto === "jobs") return "arquivos";
  return (VISTAS_TODAS as string[]).includes(bruto) ? (bruto as Vista) : null;
}

/* v3.4 (política do dono, 21/10): o usuário comum só tem três lugares na tela —
   Chat, Buscar e Fila. Painel, Usuários/Gavetas e Configurações são do admin.
   A parede de verdade está na API (dashboard/config gravam exigem operador);
   o filtro aqui é a consequência visual, não a segurança. */
const VISTAS_DO_COMUM: Vista[] = ["chat", "maquinas", "mcp", "arquivos"];

const TITULOS: Record<Vista, string> = {
  painel: "Painel",
  gavetas: "Usuários",
  arquivos: "Arquivos",
  editor: "Editor",
  chat: "Chat",
  buscar: "Buscar",
  jobs: "Fila",
  maquinas: "Máquinas",
  mcp: "MCP",
  config: "Configurações",
};

export default function App() {
  const sessao = useSessao();
  const [vista, setVista] = useState<Vista>(() => vistaDoHash() ?? "chat");
  const [usuarioAberto, setUsuarioAberto] = useState<string | null>(null);
  const [docAberto, setDocAberto] = useState<string | null>(null);
  const [novoNome, setNovoNome] = useState<string | null>(null);
  const [versao, setVersao] = useState("");
  const [sujo, setSujo] = useState(false);
  const [recarregarArquivos, setRecarregarArquivos] = useState(0);
  const [menuAberto, setMenuAberto] = useState(false);
  /* v3.19.1 (dono, 26/10): Configurações no menu principal é PAI com submenu —
     a aba interna do Config passou a viver aqui em cima para o filho marcado
     refletir a seção aberta, e navegar para o filho cair direto nela. */
  const [cfgAberto, setCfgAberto] = useState(false);
  const [abaConfig, setAbaConfig] = useState<Aba>("provider");

  /* v3.14.1 — no celular o chat ocupa a tela toda e o ☰ virou a única porta de saída da
     conversa: Esc fecha a gaveta (antes só fechava clicando no fundo escuro). */
  useEffect(() => {
    if (!menuAberto) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuAberto(false);
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [menuAberto]);
  /* v3.6.1: a aba Máquinas vive e morre com o interruptor de Controle das máquinas
     (Configurações → Ferramentas), igual à tela do túnel — desligado, some a aba. */
  const [controleMaq, setControleMaq] = useState(true);

  /* v3.16: o contexto da conversa (gaveta em uso + modelo) passou a morar na lateral.
     As buscas viviam dentro do Chat, na pílula do topo; com o bloco compartilhado,
     quem é dono da lateral (App) busca e o Chat recebe por props. */
  const [gavetas, setGavetas] = useState<{ memoria: string; rotulo: string; fixada: boolean }[]>([{ memoria: "", rotulo: "padrão", fixada: false }]);
  const [provider, setProvider] = useState<ProviderResp | null>(null);
  useEffect(() => {
    if (!sessao.logado) return;
    const t = sessao.sessao.tenant;
    const op = sessao.sessao.operador;
    void (async () => {
      try {
        const g = await get<GavetasResp>("/gavetas" + (t ? "?" + qs({ tenant: t }) : ""));
        /* v3.18 (T015/T016/T019): rótulo (manual ou automático) na barra, fixada no topo,
           arquivada FORA da barra — quem arquiva ainda vê e devolve pela página Gavetas. */
        const porMemoria = new Map<string, { memoria: string; rotulo: string; fixada: boolean }>();
        for (const x of g.gavetas) {
          if (x.arquivada || porMemoria.has(x.memoria)) continue;
          porMemoria.set(x.memoria, { memoria: x.memoria, rotulo: x.titulo || x.memoria || "padrão", fixada: Boolean(x.fixada) });
        }
        const lista = [...porMemoria.values()].sort(
          (a, b) => Number(b.fixada) - Number(a.fixada) || a.rotulo.localeCompare(b.rotulo),
        );
        setGavetas(lista.length ? lista : [{ memoria: "", rotulo: "padrão", fixada: false }]);
      } catch {
        /* segue com a gaveta padrão */
      }
      try {
        setProvider(await get<ProviderResp>("/config/provider" + (t && op ? "?" + qs({ tenant: t }) : "")));
      } catch {
        setProvider(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao.logado, sessao.sessao.tenant, vista]);

  useEffect(() => {
    void sessao.restaurar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessao.logado) return;
    setUsuarioAberto(null);
    /* v3.26.0 (dono, 27/10): TODO mundo aterrissa no Chat — antes o operador caía
       no Painel e o comum no Chat. O Painel segue no menu, só não é mais a porta.
       v3.27: se o endereço já traz a tela (#/painel etc.), ele manda — F5 continua onde estava. */
    const alvo = vistaDoHash();
    setVista(alvo && (sessao.sessao.operador || VISTAS_DO_COMUM.includes(alvo)) ? alvo : "chat");
    get<HealthResp>("/sistema")
      .then((h) => setVersao(h.versao || "?"))
      .catch(() => undefined);
    get<{ controle_maquinas?: boolean }>("/config/mcp")
      .then((r) => setControleMaq(r.controle_maquinas !== false))
      .catch(() => undefined);
  }, [sessao.logado]);

  /* v3.27 — o endereço acompanha a tela. replaceState (e não pushState) pra não
     encher o histórico com cada clique de menu; a URL fica copiável e sobrevive ao F5. */
  useEffect(() => {
    const destino = "#/" + vista;
    if (window.location.hash !== destino) window.history.replaceState(null, "", destino);
  }, [vista]);

  /* v3.27 — link com hash e voltar/avançar do navegador caem na tela certa */
  useEffect(() => {
    const aplicar = () => {
      const v = vistaDoHash();
      if (!v) return;
      setVista(v);
      /* v3.48 — link antigo (#/buscar, #/fila) abre a tela nova e a URL se corrige */
      const destino = "#/" + v;
      if (window.location.hash !== destino) window.history.replaceState(null, "", destino);
    };
    window.addEventListener("hashchange", aplicar);
    return () => window.removeEventListener("hashchange", aplicar);
  }, []);

  useEffect(() => {
    function antesDeSair(e: BeforeUnloadEvent) {
      if (sujo) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", antesDeSair);
    return () => window.removeEventListener("beforeunload", antesDeSair);
  }, [sujo]);

  const abrirEditor = useCallback((docId: string | null, nomeNovo: string | null = null) => {
    setDocAberto(docId);
    setNovoNome(nomeNovo);
    setVista("editor");
  }, []);

  const fecharEditor = useCallback(() => {
    setSujo(false);
    setDocAberto(null);
    setNovoNome(null);
    setRecarregarArquivos((n) => n + 1);
    setVista("arquivos");
  }, []);

  const navegar = useCallback(
    (destino: Vista) => {
      /* v3.4: se o comum tentar ir a módulo de admin (por qualquer caminho), fica no Chat */
      if (sessao.logado && !sessao.sessao.operador && !VISTAS_DO_COMUM.includes(destino)) destino = "chat";
      /* máquina desligada na config não tem aba: admin cai na Configurações (o interruptor mora lá) */
      if (destino === "maquinas" && !controleMaq) destino = operador ? "config" : "chat";
      if (sujo && !confirm("descartar o que você digitou no editor?")) return;
      setSujo(false);
      setVista(destino);
      setMenuAberto(false);
    },
    [sujo, sessao.logado, sessao.sessao.operador, controleMaq],
  );

  const cliqueConfig = useCallback(() => {
    if (vista === "config") setCfgAberto((v) => !v);
    else {
      navegar("config");
      setCfgAberto(true);
    }
  }, [vista, navegar]);

  /* v3.81 — estado das conversas: hooks ANTES do return do login (ordem de hooks fixa) */
  /* v3.81 — a conversa aberta. null = rascunho (a primeira mensagem cria a conversa no
     servidor); trocar de gaveta zera a escolha, porque a conversa é de uma gaveta. */
  const [conversaSel, setConversaSel] = useState<number | null>(null);
  const [recargaConversas, setRecargaConversas] = useState(0);
  const [resetChat, setResetChat] = useState(0);
  const [listaAberta, setListaAberta] = useState(false);
  useEffect(() => {
    setConversaSel(null);
  }, [sessao.sessao.tenant, sessao.sessao.memoria]);

  /* "+ nova conversa": cria a conversa no servidor e abre (nada é apagado) */
  const novaConversa = useCallback(() => {
    const t = sessao.sessao;
    const tenantArg = t.operador && t.tenant ? t.tenant : undefined;
    void criarConversa(t.memoria, tenantArg)
      .then((id) => {
        setConversaSel(id);
        setResetChat((n) => n + 1);
        setRecargaConversas((n) => n + 1);
        setListaAberta(false);
      })
      .catch(() => undefined);
  }, [sessao.sessao.memoria, sessao.sessao.tenant, sessao.sessao.operador]);

  /* abriu o chat sem conversa escolhida: volta na mais recente da gaveta (ou cria a primeira) */
  useEffect(() => {
    if (!sessao.logado || vista !== "chat" || conversaSel !== null) return;
    let vivo = true;
    const t = sessao.sessao;
    const tenantArg = t.operador && t.tenant ? t.tenant : undefined;
    void (async () => {
      const r = await listarConversas({ memoria: t.memoria, tenant: tenantArg, limit: 1 });
      const id = r.conversas?.[0]?.id ?? (await criarConversa(t.memoria, tenantArg));
      if (vivo) setConversaSel(id);
    })().catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [sessao.logado, vista, conversaSel, sessao.sessao.memoria, sessao.sessao.tenant, sessao.sessao.operador]);

  /* um turno terminou: a lista atualiza; se a conversa nasceu agora, ela vira a aberta */
  const turnoGravado = useCallback(() => {
    setRecargaConversas((n) => n + 1);
    setConversaSel((atual) => {
      if (atual !== null) return atual;
      void listarConversas({ memoria: sessao.sessao.memoria, tenant: sessao.sessao.operador && sessao.sessao.tenant ? sessao.sessao.tenant : undefined, limit: 1 })
        .then((r) => {
          const nova = r.conversas?.[0];
          if (nova) setConversaSel(nova.id);
        })
        .catch(() => undefined);
      return atual;
    });
  }, [sessao.sessao.memoria, sessao.sessao.operador, sessao.sessao.tenant]);

  if (!sessao.logado) {
    return (
      <div className="min-h-[100dvh]">
        <Login sessao={sessao} />
        {sessao.restaurando && <p className="mt-4 text-center text-[13px] text-txt3">restaurando sessão…</p>}
      </div>
    );
  }

  const { tenant, memoria, operador, nome } = sessao.sessao;
  const titulo = vista === "gavetas" && !operador ? "Gavetas" : TITULOS[vista];
  const lateral = (
    <aside className="rail" aria-label="menu">
      <div className="rail-logo" title="nexos">
        ◆
      </div>

      {/* Um menu só, na ordem do dono. No trilho o item é ícone; o nome vive no title
          (e no aria-label) — a lista de conversas ao lado é que carrega texto. */}
      {MENU.filter((m) => (operador || VISTAS_DO_COMUM.includes(m.id)) && (m.id !== "maquinas" || controleMaq)).map((m) => {
        const ativo =
          m.id === "gavetas"
            ? vista === "gavetas" || (DENTRO_DO_CAMINHO.has(vista) && Boolean(usuarioAberto))
            : vista === m.id;
        const rotulo = m.id === "gavetas" ? (operador ? "Usuários" : "Gavetas") : m.rotulo;
        const botao = (
          <button
            key={m.id}
            data-menu={m.id}
            aria-current={ativo ? "page" : undefined}
            aria-expanded={m.id === "config" ? cfgAberto : undefined}
            aria-label={rotulo}
            title={rotulo}
            className={"nav-item" + (ativo ? (m.id === "config" && cfgAberto ? " nav-item-suave" : " nav-item-on") : "")}
            onClick={() => (m.id === "config" ? cliqueConfig() : navegar(m.id))}
          >
            <svg
              className="h-4 w-4 flex-none opacity-80"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {IC[m.icone]}
            </svg>
            {rotulo}
          </button>
        );
        if (m.id !== "config") return botao;
        /* as seções de Configurações abrem como flyout à direita do trilho */
        return (
          <div key="config-grupo" className="rail-grupo">
            {botao}
            {cfgAberto && (
              <div className="nav-rail">
                {SECOES_CFG.map(([id, secRotulo]) => (
                  <button
                    key={"cfg-filho-" + id}
                    data-menu-filho={id}
                    aria-current={vista === "config" && abaConfig === id ? "page" : undefined}
                    className={"nav-filho" + (vista === "config" && abaConfig === id ? " nav-filho-on" : "")}
                    onClick={() => {
                      navegar("config");
                      setAbaConfig(id);
                    }}
                  >
                    {secRotulo}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="rail-user">
        <div
          className="rail-avatar"
          title={`${nome} · ${operador ? "administrador" : "usuário"}${operador && tenant ? ` · foco: ${tenant}` : ""}`}
        >
          {(nome || "?").slice(0, 2).toUpperCase()}
        </div>
        <button id="btnSair" className="rail-sair" title="sair da sessão" aria-label="sair" onClick={() => sessao.sair()}>
          ⏻
        </button>
        {versao && (
          <div id="ver" className="rail-versao" title={`versão ${versao}`}>
            {versao}
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-[100dvh]">
      <div className="sticky top-0 hidden h-[100dvh] lg:block">{lateral}</div>

      {/* v3.81: no Chat, a coluna de conversas mora entre o trilho e a conversa */}
      {vista === "chat" && (
        <div className="sticky top-0 hidden h-[100dvh] lg:block">
          <Conversas
            tenant={tenant}
            operador={operador}
            memoria={memoria}
            selecionada={conversaSel}
            recarga={recargaConversas}
            onSelecionar={(id) => {
              setConversaSel(id);
              setListaAberta(false);
            }}
            onNova={novaConversa}
          />
        </div>
      )}

      {vista === "chat" && listaAberta && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setListaAberta(false)} />
          <div className="absolute inset-y-0 left-0">
            <Conversas
              tenant={tenant}
              operador={operador}
              memoria={memoria}
              selecionada={conversaSel}
              recarga={recargaConversas}
              onSelecionar={(id) => {
                setConversaSel(id);
                setListaAberta(false);
              }}
              onNova={novaConversa}
              onFechar={() => setListaAberta(false)}
              /* v3.82: o menu do app passa a morar DENTRO da gaveta (um ☰ só no topo) */
              onAbrirMenu={() => {
                setListaAberta(false);
                setMenuAberto(true);
              }}
            />
          </div>
        </div>
      )}

      {menuAberto && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMenuAberto(false)} />
          <div className="absolute inset-y-0 left-0 border-r border-borda bg-sup shadow-painel">{lateral}</div>
        </div>
      )}

      {/* v3.14 — no Chat, o painel é a janela inteira: sem isso a conversa tinha altura
          chutada no css e o campo de escrita encostava (e às vezes passava) do fim da tela */}
      <div className={"flex min-w-0 flex-1 flex-col" + (vista === "chat" ? " chat-janela h-[100dvh]" : "")}>
        <header
          className={
            "sticky top-0 z-20 flex items-center gap-3 border-b border-borda bg-bg/95 px-4 py-2.5 backdrop-blur sm:px-6" +
            (vista === "chat" ? " hidden" : "")
          }
        >
          <button className="btn btn-sutil btn-mini lg:hidden" aria-label="abrir menu" onClick={() => setMenuAberto(true)}>
            ☰
          </button>
          <span className="text-[12.5px] font-medium text-txt3">
            nexos <span className="mx-[5px] text-[#4a5462]">/</span> <span className="text-txt2">{titulo}</span>
          </span>
          <span className="flex-1" />
          {operador && tenant && (
            <span className="chip" title="usuário em foco">
              <span aria-hidden="true">◉</span> {tenant}
            </span>
          )}
        </header>

        <main
          className={
            "mx-auto w-full max-w-[1180px] px-4 pt-5 sm:px-6 " +
            (vista === "chat"
              ? "flex min-h-0 flex-1 flex-col pb-2 max-[720px]:px-0 max-[720px]:pt-0 max-[720px]:pb-0"
              : "pb-12")
          }
        >
          {vista === "painel" && <Painel tenant={tenant} operador={operador} />}

          {vista === "gavetas" && (
            <Gavetas
              operador={operador}
              tenant={tenant}
              usuario={usuarioAberto}
              onAbrirUsuario={(t) => {
                setUsuarioAberto(t);
                setVista("gavetas");
              }}
              onVoltar={() => {
                setUsuarioAberto(null);
                setVista("gavetas");
              }}
              onAbrir={(t, m) => {
                sessao.escopo(t, m);
                setUsuarioAberto(t); // mantém o nível: voltar cai nas gavetas DESTE usuário
                setVista("arquivos");
              }}
            />
          )}

          {vista === "arquivos" && (
            <Arquivos
              key={`${tenant}|${memoria}|${recarregarArquivos}`}
              escopo={{ tenant, memoria }}
              operador={operador}
              onAbrirEditor={(docId, nomeNovo) => abrirEditor(docId, nomeNovo ?? null)}
              onVoltar={usuarioAberto ? () => setVista("gavetas") : undefined}
              onEscopoVazio={() => {
                if (operador && usuarioAberto) {
                  setVista("gavetas");
                  return;
                }
                setUsuarioAberto(null);
                sessao.escopo(nome, "");
                setVista("gavetas");
              }}
            />
          )}

          {vista === "editor" && (docAberto !== null || novoNome !== null) && (
            <Editor
              key={docAberto ?? novoNome ?? "novo"}
              escopo={{ tenant, memoria }}
              operador={operador}
              docId={docAberto}
              novoNome={novoNome}
              onFechar={fecharEditor}
              onSalvo={() => setRecarregarArquivos((n) => n + 1)}
              onDirty={setSujo}
            />
          )}

          {vista === "chat" && (
            <Chat
              escopo={{ tenant, memoria }}
              operador={operador}
              provider={provider}
              onProviderConfirmado={() => setProvider((p) => (p ? { ...p, configurado: true } : p))}
              onIrConfig={() => navegar("config")}
              onAbrirConversas={() => setListaAberta(true)}
              conversaId={conversaSel}
              onTurnoFim={turnoGravado}
              gavetas={gavetas}
              onTrocarGaveta={(m) => sessao.escopo(tenant, m)}
              resetSinal={resetChat}
            />
          )}

          {vista === "maquinas" && <Maquinas />}
          {vista === "mcp" && <Mcp versao={versao} />}
          {vista === "config" && (
            <Config
              nome={nome}
              operador={operador}
              tenant={tenant}
              onChaveNova={(c) => sessao.trocarChave(c)}
              onIrPainel={() => navegar("painel")}
              onControleMaquinas={setControleMaq}
              aba={abaConfig}
            />
          )}
        </main>

        <footer
          id="rodape"
          className={
            "mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-3 px-4 pb-8 text-[12px] text-txt3 sm:px-6" +
            (vista === "chat" ? " hidden" : "")
          }
        >
          {/* v3.16: o chip de versão saiu do rodapé — a lateral é a casa única dela */}
          <span>
            <kbd className="rounded border border-borda px-1">Ctrl</kbd>+<kbd className="rounded border border-borda px-1">S</kbd> salva ·{" "}
            <kbd className="rounded border border-borda px-1">Esc</kbd> fecha o editor
          </span>
          <span className="flex-1" />
          <span>nexos · memória de documentos com busca semântica</span>
        </footer>
      </div>
    </div>
  );
}