import { useCallback, useEffect, useMemo, useState } from "react";
import { baixar, del, get, post, put, qs } from "../services/api";
import { fmtData, slug } from "../lib/fmt";
import { useToast } from "./Toast";
import type { DecayResp, Gaveta, GavetasResp, RemoverUsuarioResp, UsuarioItem } from "../types";

/** Plural certo: 1 usuário / 2 usuários. */
function pl(n: number, um: string, muitos: string): string {
  return `${n} ${n === 1 ? um : muitos}`;
}

/** Identificador técnico de gaveta (p:<uuid>), usado pelo IA_GO. */
function ehTecnica(m: string): boolean {
  return /^p:[0-9a-f-]{20,}$/i.test(m);
}

/** Trecho legível do identificador técnico. */
function curto(m: string): string {
  return `p:${m.slice(2, 10)}…`;
}

type Ordem = "nome" | "docs" | "recente";

const PAGINA = 9; // usuários por página
const PAGINA_GAVETAS = 20; // gavetas por página dentro do usuário

function cmpH(a: Gaveta, b: Gaveta): number {
  /* v3.18 (T019): fixada primeiro; dentro do mesmo grupamento, a ordem de sempre */
  return Number(Boolean(b.fixada)) - Number(Boolean(a.fixada)) || (a.memoria || "").localeCompare(b.memoria || "");
}

function ordemGaveta(a: Gaveta, b: Gaveta, ordem: Ordem): number {
  if (ordem === "docs") return b.docs - a.docs || cmpH(a, b);
  if (ordem === "recente") {
    const x = a.ultimo_ingress ?? "";
    const y = b.ultimo_ingress ?? "";
    return y.localeCompare(x) || cmpH(a, b);
  }
  return cmpH(a, b);
}

const GAVETA_VAZIA: Gaveta = {
  tenant: "",
  memoria: "",
  chunks: 0,
  docs: 0,
  chunks_arquivados: 0,
  primeiro_ingress: null,
  ultimo_ingress: null,
};

type Props = {
  operador: boolean;
  /** tenant do login (usado pelo usuário comum) */
  tenant: string;
  /** usuário aberto pelo operador (null = lista de usuários) */
  usuario: string | null;
  onAbrirUsuario: (tenant: string) => void;
  onVoltar: () => void;
  onAbrir: (tenant: string, memoria: string) => void;
};

export function Gavetas({ operador, tenant, usuario, onAbrirUsuario, onVoltar, onAbrir }: Props) {
  const { toast } = useToast();
  const [dados, setDados] = useState<GavetasResp | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [filtro, setFiltro] = useState("");
  const [ordem, setOrdem] = useState<Ordem>("nome");
  const [todos, setTodos] = useState(false);
  const [novaAberta, setNovaAberta] = useState(false);
  const [novoNome, setNovoNome] = useState("");
  const [criando, setCriando] = useState(false);
  /* v2.7: criar usuário pela tela — a chave aparece UMA vez */
  const [modalUsuario, setModalUsuario] = useState(false);
  const [novoUsuarioNome, setNovoUsuarioNome] = useState("");
  const [novoUsuarioPapel, setNovoUsuarioPapel] = useState<"usuario" | "operador">("usuario");
  const [chaveGerada, setChaveGerada] = useState<{ nome: string; chave: string } | null>(null);
  /* v3.5: apagar usuário = AGENDAR exclusão (janela configurável). Cartão tem
     botão em duas fases (primeiro clique arma, segundo confirma) e rótulo do prazo. */
  const [contas, setContas] = useState<Record<string, UsuarioItem>>({});
  const [confirmarApagar, setConfirmarApagar] = useState<string | null>(null);
  /* v3.18 (T021): buscar DENTRO do histórico de conversas (texto das mensagens) */
  const [termoBusca, setTermoBusca] = useState("");
  const [achados, setAchados] = useState<{ id: number; memoria: string; papel: string; trecho: string; quando: string }[] | null>(null);
  const [buscando, setBuscando] = useState(false);

  /** meta da gaveta (T015 renomear / T019 fixar-arquivar): rótulo e flags, nunca o nome técnico */
  async function metaGaveta(g: Gaveta, mud: { titulo?: string; fixada?: boolean; arquivada?: boolean }, brinde: string) {
    try {
      await put("/gavetas/meta", { tenant: g.tenant, memoria: g.memoria, ...mud });
      toast(brinde, "sucesso");
      void carregar();
    } catch (e) {
      toast("gaveta: " + (e as Error).message, "erro");
    }
  }

  function renomearGaveta(g: Gaveta) {
    const t = window.prompt("Novo rótulo da gaveta (o nome técnico não muda):", g.titulo ?? g.memoria);
    if (t === null) return;
    void metaGaveta(g, { titulo: t.trim() }, "rótulo salvo");
  }

  async function buscarHistorico(e: { preventDefault(): void }) {
    e.preventDefault();
    const q = termoBusca.trim();
    if (q.length < 2) {
      setAchados(null);
      return;
    }
    setBuscando(true);
    try {
      const r = await get<{ resultados: { id: number; memoria: string; papel: string; trecho: string; quando: string }[] }>(
        "/chat/mensagens?" + qs({ q, ...(alvo ? { tenant: alvo } : {}) }),
      );
      setAchados(r.resultados ?? []);
    } catch (err) {
      toast("buscar: " + (err as Error).message, "erro");
    } finally {
      setBuscando(false);
    }
  }

  /* operador começa escolhendo o usuário; quem entra com login comum já vê as suas gavetas */
  const modoUsuarios = operador && usuario === null;
  const alvo = operador ? usuario ?? "" : tenant;

  async function criarUsuario() {
    const nome = novoUsuarioNome.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(nome)) {
      toast("nome inválido: 2-32 caracteres, sem acento nem espaço", "erro");
      return;
    }
    setCriando(true);
    try {
      const r = await post<{ nome: string; chave: string; aviso?: string }>("/usuarios", { nome, papel: novoUsuarioPapel });
      setChaveGerada({ nome: r.nome, chave: r.chave });
      await carregar();
      toast(r.aviso && r.aviso.includes("DESFEITA") ? "recriado: exclusão desfeita, dados voltaram" : `usuário ${r.nome} criado`, "sucesso");
    } catch (e) {
      toast("criar: " + (e as Error).message, "erro");
    } finally {
      setCriando(false);
    }
  }

  /* v3.5: apagar usuário = desliga o login na hora e AGENDA a morte dos dados. */
  async function apagarConta(nome: string) {
    try {
      const r = await del<RemoverUsuarioResp>(`/usuarios/${encodeURIComponent(nome)}`);
      toast(`login de ${r.nome} desligado; os dados somem em ${r.carencia_dias} dia(s) — recriar o nome desfaz`, "sucesso");
      await carregar();
    } catch (e) {
      toast("apagar: " + (e as Error).message, "erro");
    }
  }

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setDados(await get<GavetasResp>("/gavetas"));
      if (operador && usuario === null) {
        /* v3.5: a lista de contas dá o mapa de "agendado para exclusão" e papel dos
           cartões do nível 1; o nível funciona mesmo se essa chamada falhar */
        try {
          const u = await get<{ usuarios: UsuarioItem[] }>("/usuarios");
          setContas(Object.fromEntries(u.usuarios.map((x) => [x.nome, x])));
        } catch {
          setContas({});
        }
      }
    } catch (e) {
      setDados(null);
      toast("gavetas: " + (e as Error).message, "erro");
    } finally {
      setCarregando(false);
    }
  }, [toast, operador, usuario]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /* filtra/ordena as gavetas do usuário; gaveta vazia continua aparecendo (para receber documento) */
  const grupos = useMemo(() => {
    const mapa = new Map<string, Gaveta[]>();
    for (const t of dados?.usuarios ?? []) if (!mapa.has(t)) mapa.set(t, []);
    for (const g of dados?.gavetas ?? []) {
      const atual = mapa.get(g.tenant);
      if (atual) atual.push(g);
      else mapa.set(g.tenant, [g]);
    }

    const f = filtro.trim().toLowerCase();
    return [...mapa.entries()]
      .map(([t, gavetas]) => {
        const ordenadas = [...gavetas].sort((a, b) => ordemGaveta(a, b, ordem));
        return {
          tenant: t,
          vazio: !ordenadas.some((g) => g.docs > 0 || g.chunks > 0),
          qtdGavetas: ordenadas.length,
          gavetas: ordenadas.length ? ordenadas : [{ ...GAVETA_VAZIA, tenant: t }],
          docs: ordenadas.reduce((s, g) => s + g.docs, 0),
          ultimo: ordenadas.reduce((m, g) => ((g.ultimo_ingress ?? "") > m ? g.ultimo_ingress ?? "" : m), ""),
        };
      })
      .filter((linha) => {
        if (!f) return true;
        if (!modoUsuarios && linha.tenant !== alvo) return false;
        if (linha.tenant.toLowerCase().includes(f)) return true;
        return linha.gavetas.some((g) => (g.memoria || "padrão").toLowerCase().includes(f));
      })
      .sort((a, b) => {
        if (ordem === "docs") return b.docs - a.docs || a.tenant.localeCompare(b.tenant);
        if (ordem === "recente") return b.ultimo.localeCompare(a.ultimo) || a.tenant.localeCompare(b.tenant);
        return a.tenant.localeCompare(b.tenant);
      });
  }, [dados, filtro, ordem, modoUsuarios, alvo]);

  const doUsuario = useMemo(() => {
    const achado = grupos.find((g) => g.tenant === alvo);
    if (achado) return achado;
    return {
      tenant: alvo,
      vazio: true,
      qtdGavetas: 0,
      gavetas: [{ ...GAVETA_VAZIA, tenant: alvo }],
      docs: 0,
      ultimo: "",
    };
  }, [grupos, alvo]);

  const visiveis = modoUsuarios && !todos ? grupos.slice(0, PAGINA) : grupos;
  const restantesUsuarios = modoUsuarios && !todos ? grupos.length - visiveis.length : 0;
  const gavetasVisiveis = modoUsuarios ? [] : todos ? doUsuario.gavetas : doUsuario.gavetas.slice(0, PAGINA_GAVETAS);
  const restantesGavetas = modoUsuarios ? 0 : doUsuario.gavetas.length - gavetasVisiveis.length;


  const totalDocs = dados?.documentos_fonte ?? 0;

  async function exportar(t: string, memoria: string) {
    try {
      await baixar(
        `/gavetas/${encodeURIComponent(memoria)}/export.zip?${qs({ tenant: operador ? t : undefined })}`,
        slug(memoria || "gaveta") + ".zip",
      );
      toast("zip gerado ✓", "sucesso");
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function apagar(t: string, memoria: string, docs: number) {
    const rotulo = (operador ? `${t} ▸ ` : "") + (memoria || "padrão");
    if (!confirm(`APAGAR a gaveta ${rotulo} inteira (${docs} arquivo(s), chunks, fontes e jobs na fila)?`)) return;
    if (!confirm("Tem certeza? Isso NÃO tem como desfazer no painel.")) return;
    try {
      const r = await del<{ chunks_apagados: number; fontes_apagadas: number }>(
        `/gavetas/${encodeURIComponent(memoria)}?${qs({ tenant: operador ? t : undefined })}`,
      );
      toast(`gaveta apagada: ${r.chunks_apagados} chunks, ${r.fontes_apagadas} fontes`, "sucesso");
      void carregar();
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  /* criação de gaveta sem prompt do navegador: campo na própria tela */
  async function criarGaveta(t: string) {
    const memoria = novoNome.trim();
    if (!memoria) {
      toast("digite o nome da gaveta", "erro");
      return;
    }
    setCriando(true);
    try {
      await post("/gavetas", { memoria, tenant: operador ? t : undefined });
      toast(`gaveta "${memoria}" criada`, "sucesso");
      setNovaAberta(false);
      setNovoNome("");
      void carregar();
    } catch (e) {
      toast("não deu para criar: " + (e as Error).message, "erro");
    } finally {
      setCriando(false);
    }
  }

  async function arquivarEsquecidos() {
    const escopoNome = operador ? "todas as gavetas" : "a tua gaveta";
    const ok = confirm(
      `Arquivar os documentos sem uso há 30 dias ou mais em ${escopoNome}?\n\n` +
        "Nada é apagado: eles só saem da busca e podem ser revividos depois.",
    );
    if (!ok) return;
    try {
      const r = await post<DecayResp>("/decay");
      toast(
        `${r.docs_arquivados_agora} documento(s) arquivado(s) agora · ` +
          `${r.ativos} ativo(s) · ${r.arquivados} arquivado(s)`,
        "sucesso",
      );
      void carregar();
    } catch (e) {
      toast("não deu para arquivar: " + (e as Error).message, "erro");
    }
  }

  /* ------------------------------------------------ nível 1: usuários */
  if (modoUsuarios) {
    return (
      <section>
        <div className="barra">
          <div>
            <h1>Usuários</h1>
            <div className="mt-1 text-[12.8px] text-txt3">cada pessoa tem a própria pasta de memória</div>
          </div>
          <span className="flex-1" />
          <button
            id="btnNovoUsuario"
            className="btn btn-primario"
            onClick={() => {
              setNovoUsuarioNome("");
              setNovoUsuarioPapel("usuario");
              setChaveGerada(null);
              setModalUsuario(true);
            }}
          >
            ＋ novo usuário
          </button>
          <button id="btnAtualizarGav" className="btn btn-sutil" title="recarregar a lista" onClick={() => void carregar()}>
            <span aria-hidden="true">⟳</span>
            atualizar
          </button>
          <button
            id="btnDecay"
            className="btn"
            title="arquiva (sem apagar) os documentos sem uso; padrão 6 meses, ajustável em Configurações → Esquecimento"
            onClick={() => void arquivarEsquecidos()}
          >
            arquivar esquecidos
          </button>
        </div>

        <div className="faixa">
          <input
            id="gavFiltro"
            className="campo max-w-[260px]"
            placeholder="filtrar por usuário…"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
          />
          <label className="flex items-center gap-2 text-[13px] text-txt2">
            ordenar por
            <select id="gavOrdem" className="campo max-w-[190px]" value={ordem} onChange={(e) => setOrdem(e.target.value as Ordem)}>
              <option value="nome">nome (A-Z)</option>
              <option value="docs">mais documentos</option>
              <option value="recente">mais recente</option>
            </select>
          </label>
          {filtro && (
            <button className="btn btn-sutil btn-mini" onClick={() => setFiltro("")}>
              limpar filtro
            </button>
          )}
        </div>

        <div id="gavetasInfo" className="dica">
          {dados
            ? `${pl(grupos.length, "usuário", "usuários")} · ${pl(totalDocs, "documento", "documentos")}` +
              (filtro ? ` · filtro: ${grupos.length} de ${(dados?.usuarios ?? []).length}` : "") +
              " · clique num usuário para ver as gavetas dele"
            : ""}
        </div>

        <div id="gavetasGrid" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {carregando && <p className="dica">carregando…</p>}
          {!carregando && grupos.length === 0 && (
            <div className="vazio col-span-full">
              <div className="tit">Nenhum usuário ainda</div>
              Crie uma nota ou envie um arquivo na aba Arquivos.
            </div>
          )}
          {!carregando &&
            visiveis.map(({ tenant: t, docs, qtdGavetas, vazio, ultimo }) => (
              <div
                key={t}
                id={`usuario-${slug(t)}`}
                role="button"
                tabIndex={0}
                className="cursor-pointer rounded-cartao border border-borda bg-sup px-3.5 py-3 transition-colors hover:bg-sup2 focus-visible:bg-sup2 focus-visible:outline-none"
                onClick={() => onAbrirUsuario(t)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onAbrirUsuario(t)}
              >
                <div className="flex items-baseline gap-2">
                  <h3 className="truncate text-[14px] font-semibold">👤 {t}</h3>
                  <span className="ml-auto text-[16px] text-txt3" aria-hidden="true">
                    ›
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-txt3">
                  {vazio ? (
                    "nenhuma gaveta ainda"
                  ) : (
                    <>
                      <b className="text-txt2">{pl(qtdGavetas, "gaveta", "gavetas")}</b> ·{" "}
                      {pl(docs, "documento", "documentos")}
                    </>
                  )}
                </div>
                <div className="mt-0.5 text-[12px] text-txt3">
                  {vazio ? "clique para abrir e enviar o primeiro documento" : `último documento ${fmtData(ultimo)}`}
                </div>
                {/* v3.5: apagar a conta (duas fases) e o aviso de exclusão agendada */}
                <div className="mt-1.5 flex min-h-[28px] items-center gap-2" onClick={(ev) => ev.stopPropagation()}>
                  {contas[t]?.agendado_exclusao_em ? (
                    <span className="chip text-[11px]" title="login desligado; os dados serão apagados nesta data — recriar o nome desfaz">
                      ⏳ some em {new Date(String(contas[t]?.agendado_exclusao_em)).toLocaleDateString("pt-BR")} — recriar desfaz
                    </span>
                  ) : (
                    <button
                      id={`btnApagarUsuario-${slug(t)}`}
                      className={"btn btn-mini btn-sutil" + (confirmarApagar === t ? " btn-perigo" : "")}
                      onClick={() => {
                        if (confirmarApagar !== t) {
                          setConfirmarApagar(t);
                          return;
                        }
                        setConfirmarApagar(null);
                        void apagarConta(t);
                      }}
                    >
                      {confirmarApagar === t ? "apagar de verdade?" : "apagar"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          {!carregando && restantesUsuarios > 0 && (
            <div className="col-span-full flex justify-center pt-1">
              <button id="gavMais" className="btn" onClick={() => setTodos(true)}>
                mostrar mais {restantesUsuarios} usuário(s)
              </button>
            </div>
          )}
        </div>

        {modalUsuario && (
          <div className="veu" role="dialog" aria-modal="true" aria-label="novo usuário" onClick={() => setModalUsuario(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>◆ {chaveGerada ? "Usuário criado" : "Novo usuário"}</h3>
              {chaveGerada ? (
                <div className="flex flex-col gap-3 p-4">
                  <p className="m-0 text-[13px] text-txt2">
                    <b>{chaveGerada.nome}</b> já pode usar o painel. Entregue esta chave:
                  </p>
                  <div className="mono select-all break-all rounded-lg border border-borda bg-sup2 p-2 text-[13px]" id="chaveGerada">
                    {chaveGerada.chave}
                  </div>
                  <p className="m-0 text-[12px] text-txt3">ela não aparece de novo — se perder, gere outra em Conta e chave.</p>
                  <div className="flex justify-end gap-2">
                    <button
                      className="btn"
                      onClick={() => {
                        void navigator.clipboard?.writeText(chaveGerada.chave);
                        toast("chave copiada", "sucesso");
                      }}
                    >
                      copiar
                    </button>
                    <button className="btn btn-primario" onClick={() => setModalUsuario(false)}>
                      fechar
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-3 p-4">
                    <label className="rotulo m-0">
                      nome do usuário
                      <input
                        id="novoUsuarioNome"
                        className="campo mt-1"
                        placeholder="ex.: financeiro"
                        value={novoUsuarioNome}
                        autoFocus
                        onChange={(e) => setNovoUsuarioNome(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void criarUsuario()}
                      />
                    </label>
                    <label className="rotulo m-0">
                      papel
                      <select
                        id="novoUsuarioPapel"
                        className="campo mt-1"
                        value={novoUsuarioPapel}
                        onChange={(e) => setNovoUsuarioPapel(e.target.value as "usuario" | "operador")}
                      >
                        <option value="usuario">usuário</option>
                        <option value="operador">administrador (vê todas as contas)</option>
                      </select>
                    </label>
                    <div className="aviso">
                      <span>A chave é gerada pelo sistema e aparece <b>uma única vez</b>, logo depois de criar.</span>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 border-t border-borda p-3">
                    <button className="btn" onClick={() => setModalUsuario(false)}>
                      cancelar
                    </button>
                    <button id="btnCriarUsuario" className="btn btn-primario" disabled={criando} onClick={() => void criarUsuario()}>
                      {criando ? "criando…" : "criar usuário"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    );
  }

  /* ------------------------------------------------ nível 2: gavetas do usuário */
  return (
    <section>
      <div className="barra">
        {operador && (
          <button id="btnVoltarUsuarios" className="btn btn-sutil btn-mini" title="voltar para a lista de usuários" onClick={onVoltar}>
            ← usuários
          </button>
        )}
        <h2>{operador ? `👤 ${alvo}` : "As tuas gavetas"}</h2>
        <span className="flex-1" />
        <button id="btnAtualizarGav" className="btn btn-sutil" title="recarregar a lista" onClick={() => void carregar()}>
          <span aria-hidden="true">⟳</span>
          atualizar
        </button>
        <button
          id="btnDecay"
          className="btn"
          title="arquiva (sem apagar) os documentos sem uso; padrão 6 meses, ajustável em Configurações → Esquecimento"
          onClick={() => void arquivarEsquecidos()}
        >
          arquivar esquecidos
        </button>
      </div>

      <div className="faixa">
        <input
          id="gavFiltro"
          className="campo max-w-[260px]"
          placeholder="filtrar gaveta…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
        />
        <label className="flex items-center gap-2 text-[13px] text-txt2">
          ordenar por
          <select id="gavOrdem" className="campo max-w-[190px]" value={ordem} onChange={(e) => setOrdem(e.target.value as Ordem)}>
            <option value="nome">nome (A-Z)</option>
            <option value="docs">mais documentos</option>
            <option value="recente">mais recente</option>
          </select>
        </label>
        {filtro && (
          <button className="btn btn-sutil btn-mini" onClick={() => setFiltro("")}>
            limpar filtro
          </button>
        )}
        <span className="flex-1" />
        <button
          id="btnNovaGaveta"
          className="btn btn-sutil btn-mini"
          title="criar uma gaveta nova neste usuário"
          onClick={() => {
            setNovoNome("");
            setNovaAberta(true);
          }}
        >
          ＋ gaveta
        </button>
      </div>

      <div id="gavetasInfo" className="dica">
        {dados
          ? doUsuario.vazio
            ? "nenhuma gaveta com documento ainda · clique na gaveta para enviar o primeiro"
            : `${pl(doUsuario.qtdGavetas, "gaveta", "gavetas")} · ${pl(doUsuario.docs, "documento", "documentos")} · clique numa gaveta para ver os arquivos`
          : ""}
      </div>

      <div id="gavetasGrid">
        {carregando && <p className="dica">carregando…</p>}
        {novaAberta && !modoUsuarios && (
          <form
            id="formNovaGaveta"
            className="mb-2 flex flex-wrap items-center gap-2 rounded-cartao border border-borda bg-sup px-3.5 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void criarGaveta(alvo);
            }}
          >
            <label htmlFor="gavNovaNome" className="text-[13px] text-txt2">
              nome da nova gaveta
            </label>
            <input
              id="gavNovaNome"
              className="campo max-w-[220px]"
              autoFocus
              value={novoNome}
              placeholder="vendas, suporte, contratos…"
              onChange={(e) => setNovoNome(e.target.value)}
            />
            <button id="gavNovaCriar" type="submit" className="btn btn-primario btn-mini" disabled={criando}>
              {criando ? "criando…" : "criar"}
            </button>
            <button
              type="button"
              className="btn btn-sutil btn-mini"
              onClick={() => {
                setNovaAberta(false);
                setNovoNome("");
              }}
            >
              cancelar
            </button>
          </form>
        )}
        {/* v3.18 (T021): buscar DENTRO do histórico de conversas — o que a Gaveta mostra
            são documentos; isto aqui acha a frase que você disse numa conversa qualquer. */}
        {!modoUsuarios && (
          <form className="flex items-center gap-2 pb-2" onSubmit={buscarHistorico}>
            <input
              id="gavHistoricoQ"
              className="campo min-w-0 flex-1"
              value={termoBusca}
              onChange={(e) => {
                setTermoBusca(e.target.value);
                if (!e.target.value.trim()) setAchados(null);
              }}
              placeholder="buscar dentro das conversas…"
              title="procura nas mensagens (não nos documentos)"
            />
            <button id="gavHistoricoBtn" className="btn btn-sutil" disabled={buscando}>
              {buscando ? "buscando…" : "buscar"}
            </button>
          </form>
        )}
        {achados && (
          <ul className="mb-2 divide-y divide-borda/60 overflow-hidden rounded-cartao border border-borda bg-sup">
            {achados.length === 0 ? (
              <li className="px-3 py-2 text-[12px] text-txt3">nenhuma conversa contém “{termoBusca.trim()}”</li>
            ) : (
              achados.map((r) => (
                <li key={r.id}>
                  <button
                    className="w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left transition-colors hover:bg-sup2"
                    onClick={() => onAbrir(alvo, r.memoria)}
                    title={r.trecho}
                  >
                    <div className="flex gap-2 text-[11px] text-txt3">
                      <span className="font-semibold text-txt2">{r.memoria || "padrão"}</span>
                      <span>{r.papel === "user" ? "você" : "Nexos"}</span>
                      <span>{fmtData(r.quando)}</span>
                    </div>
                    <p className="truncate text-[12px]">{r.trecho}</p>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
        {!carregando && (
          <ul className="divide-y divide-borda/60 overflow-hidden rounded-cartao border border-borda bg-sup">
            {gavetasVisiveis.map((g) => (
              <li key={g.tenant + "|" + g.memoria}>
                <div
                  role="button"
                  tabIndex={0}
                  className="flex cursor-pointer items-center gap-2 px-3.5 py-3 transition-colors hover:bg-sup2 focus-visible:bg-sup2 focus-visible:outline-none"
                  onClick={() => onAbrir(g.tenant, g.memoria)}
                  onKeyDown={(e) => e.key === "Enter" && onAbrir(g.tenant, g.memoria)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold" title={g.titulo || g.memoria || "padrão"}>
                        {g.titulo || (ehTecnica(g.memoria) ? "gaveta do perfil" : g.memoria || "padrão")}
                      </span>
                      {/* v3.18 (T019/T016): rótulo automático/fixada/arquivada aparecem na linha */}
                      {g.fixada && (
                        <span className="chip" title="fixada no topo">📌 fixada</span>
                      )}
                      {g.arquivada && (
                        <span className="chip" title="fora da barra lateral; ainda abre por aqui">arquivada</span>
                      )}
                      {ehTecnica(g.memoria) && (
                        <span className="chip" title={g.memoria}>
                          {curto(g.memoria)}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[12px] text-txt3">
                      {g.docs === 0 && g.chunks === 0 ? (
                        <span className="text-txt3">vazia — clique para enviar o primeiro documento</span>
                      ) : (
                        <>
                          <b className="text-txt2">{g.docs}</b> {g.docs === 1 ? "arquivo" : "arquivos"} ·{" "}
                          <b className="text-txt2">{g.chunks}</b> {g.chunks === 1 ? "chunk" : "chunks"} ·{" "}
                          {g.chunks_arquivados ? `${g.chunks_arquivados} arquiv.` : "tudo ativo"} · último{" "}
                          {fmtData(g.ultimo_ingress)}
                        </>
                      )}
                    </div>
                  </div>

                  {g.docs === 0 && g.chunks === 0 ? (
                    <div className="flex shrink-0 items-center gap-1">
                      {/* v3.18 (T015/T019): rótulo, fixar e arquivar — a gaveta vazia (só conversa) também existe */}
                      <button
                        className="btn btn-sutil btn-mini"
                        title="renomear (rótulo; o nome técnico não muda)"
                        onClick={(e) => {
                          e.stopPropagation();
                          renomearGaveta(g);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="btn btn-sutil btn-mini"
                        title={g.fixada ? "desafixar do topo" : "fixar no topo"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void metaGaveta(g, { fixada: !g.fixada }, g.fixada ? "desafixada" : "fixada no topo");
                        }}
                      >
                        📌
                      </button>
                      <button
                        className="btn btn-sutil btn-mini"
                        title={g.arquivada ? "devolver do arquivo" : "arquivar (some da barra lateral)"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void metaGaveta(g, { arquivada: !g.arquivada }, g.arquivada ? "devolvida" : "arquivada");
                        }}
                      >
                        🗄
                      </button>
                      <span className="btn btn-primario btn-mini">＋ documento</span>
                      <button
                        className="btn btn-perigo btn-mini"
                        title="apagar esta gaveta (está vazia)"
                        onClick={(e) => {
                          e.stopPropagation();
                          void apagar(g.tenant, g.memoria, g.docs);
                        }}
                      >
                        apagar
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 gap-1">
                      {/* v3.18 (T015/T019): rótulo, fixar, arquivar */}
                      <button
                        className="btn btn-sutil btn-mini"
                        title="renomear (rótulo; o nome técnico não muda)"
                        onClick={(e) => {
                          e.stopPropagation();
                          renomearGaveta(g);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="btn btn-sutil btn-mini"
                        title={g.fixada ? "desafixar do topo" : "fixar no topo"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void metaGaveta(g, { fixada: !g.fixada }, g.fixada ? "desafixada" : "fixada no topo");
                        }}
                      >
                        📌
                      </button>
                      <button
                        className="btn btn-sutil btn-mini"
                        title={g.arquivada ? "devolver do arquivo" : "arquivar (some da barra lateral)"}
                        onClick={(e) => {
                          e.stopPropagation();
                          void metaGaveta(g, { arquivada: !g.arquivada }, g.arquivada ? "devolvida" : "arquivada");
                        }}
                      >
                        🗄
                      </button>
                      <button
                        className="btn btn-sutil btn-mini"
                        title="baixar esta gaveta em zip"
                        onClick={(e) => {
                          e.stopPropagation();
                          void exportar(g.tenant, g.memoria);
                        }}
                      >
                        ⬇ zip
                      </button>
                      <button
                        className="btn btn-perigo btn-mini"
                        title="apagar a gaveta inteira"
                        onClick={(e) => {
                          e.stopPropagation();
                          void apagar(g.tenant, g.memoria, g.docs);
                        }}
                      >
                        apagar
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!carregando && restantesGavetas > 0 && (
          <div className="flex justify-center pt-2">
            <button id="gavMais" className="btn" onClick={() => setTodos(true)}>
              mostrar mais {restantesGavetas} gaveta(s)
            </button>
          </div>
        )}
      </div>
    </section>
  );
}