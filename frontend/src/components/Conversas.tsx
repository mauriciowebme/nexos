/** v3.81 — coluna de CONVERSAS (a lateral do chat, no desenho aprovado em 26/11).
 *  Lista agrupada por data, busca que também acha dentro do texto, e nada que apague:
 *  arquivar tira da lista, o histórico continua no banco. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "./Toast";
import { arquivarConversa, listarConversas, renomearConversa, type ConversaMeta } from "../lib/conversas";

type Props = {
  tenant: string;
  operador: boolean;
  memoria: string;
  selecionada: number | null;
  /** muda quando o chat grava um turno — a lista recarrega (título, data, prévia) */
  recarga: number;
  onSelecionar: (id: number) => void;
  onNova: () => void;
  onFechar?: () => void;
};

const dia = (iso: string): string => String(iso ?? "").slice(0, 10);
const hojeISO = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ontemISO = (): string => {
  const d = new Date(Date.now() - 86400000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function quandoCurto(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mesmoDia = dia(iso) === hojeISO();
  const hora = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (mesmoDia) return hora;
  if (dia(iso) === ontemISO()) return `ontem ${hora}`;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function Conversas({ tenant, operador, memoria, selecionada, recarga, onSelecionar, onNova, onFechar }: Props) {
  const { toast } = useToast();
  const [lista, setLista] = useState<ConversaMeta[]>([]);
  const [contagem, setContagem] = useState({ ativas: 0, arquivadas: 0 });
  const [busca, setBusca] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [editando, setEditando] = useState<number | null>(null);
  const [tituloNovo, setTituloNovo] = useState("");
  const [menu, setMenu] = useState<number | null>(null);
  const buscaRef = useRef<number | null>(null);

  const carregar = useCallback(
    async (termo = "") => {
      setCarregando(true);
      try {
        const r = await listarConversas({
          memoria,
          busca: termo,
          tenant: operador && tenant ? tenant : undefined,
        });
        setLista(r.conversas ?? []);
        setContagem(r.contagem ?? { ativas: 0, arquivadas: 0 });
      } catch (e) {
        toast("conversas: " + (e as Error).message, "erro");
      } finally {
        setCarregando(false);
      }
    },
    [memoria, operador, tenant, toast],
  );

  useEffect(() => {
    void carregar(busca);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoria, recarga, tenant]);

  /* busca com respiro: cada letra não vira uma requisição */
  const buscar = (termo: string) => {
    setBusca(termo);
    if (buscaRef.current) window.clearTimeout(buscaRef.current);
    buscaRef.current = window.setTimeout(() => void carregar(termo.trim()), 250);
  };

  const salvarTitulo = async (c: ConversaMeta) => {
    const t = tituloNovo.trim();
    setEditando(null);
    if (!t || t === c.titulo) return;
    try {
      await renomearConversa(c.id, t, operador && tenant ? tenant : undefined);
      setLista((l) => l.map((x) => (x.id === c.id ? { ...x, titulo: t } : x)));
    } catch (e) {
      toast("renomear: " + (e as Error).message, "erro");
    }
  };

  const arquivar = async (c: ConversaMeta) => {
    setMenu(null);
    if (!window.confirm(`Arquivar “${c.titulo}”?\n\nEla sai da lista e o histórico continua guardado — nada é apagado.`)) return;
    try {
      await arquivarConversa(c.id, operador && tenant ? tenant : undefined);
      setLista((l) => l.filter((x) => x.id !== c.id));
      setContagem((n) => ({ ...n, ativas: Math.max(0, n.ativas - 1), arquivadas: n.arquivadas + 1 }));
    } catch (e) {
      toast("arquivar: " + (e as Error).message, "erro");
    }
  };

  const grupos: { rotulo: string; itens: ConversaMeta[] }[] = [
    { rotulo: "hoje", itens: lista.filter((c) => dia(c.atualizado_em) === hojeISO()) },
    {
      rotulo: "ontem",
      itens: lista.filter((c) => dia(c.atualizado_em) === ontemISO()),
    },
    {
      rotulo: "anteriores",
      itens: lista.filter((c) => dia(c.atualizado_em) !== hojeISO() && dia(c.atualizado_em) !== ontemISO()),
    },
  ].filter((g) => g.itens.length > 0);

  return (
    <aside className="conv-painel" aria-label="conversas">
      <div className="conv-painel-topo">
        <button className="conv-nova" onClick={onNova} title="começar uma conversa nova (nada é apagado)">
          <span aria-hidden="true">＋</span> nova conversa
        </button>
        {onFechar && (
          <button className="conv-fechar" onClick={onFechar} aria-label="fechar lista de conversas">
            ✕
          </button>
        )}
      </div>

      <input
        className="conv-busca"
        type="search"
        value={busca}
        placeholder="buscar nas conversas…"
        aria-label="buscar nas conversas"
        onChange={(e) => buscar(e.target.value)}
      />

      <div className="conv-lista">
        {carregando && !lista.length && <p className="conv-vazio">carregando…</p>}
        {!carregando && !lista.length && (
          <p className="conv-vazio">{busca ? "nada encontrado nesta busca" : "nenhuma conversa ainda — mande a primeira mensagem"}</p>
        )}
        {grupos.map((g) => (
          <div key={g.rotulo} className="conv-grupo">
            <div className="conv-grupo-rotulo">{g.rotulo}</div>
            {g.itens.map((c) => (
              <div key={c.id} className={"conv-item" + (c.id === selecionada ? " conv-item-on" : "")}>
                {editando === c.id ? (
                  <input
                    className="conv-renomear"
                    autoFocus
                    value={tituloNovo}
                    onChange={(e) => setTituloNovo(e.target.value)}
                    onBlur={() => void salvarTitulo(c)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void salvarTitulo(c);
                      if (e.key === "Escape") setEditando(null);
                    }}
                  />
                ) : (
                  <button
                    className="conv-item-corpo"
                    onClick={() => {
                      setMenu(null);
                      onSelecionar(c.id);
                    }}
                    title={c.titulo}
                  >
                    <span className="conv-item-titulo">{c.titulo}</span>
                    <span className="conv-item-previa">{c.previa || "—"}</span>
                    <span className="conv-item-meta">
                      {c.mensagens} mensagen{c.mensagens === 1 ? "" : "s"} · {quandoCurto(c.atualizado_em)}
                      {c.compactado_ate ? " · compactada" : ""}
                    </span>
                  </button>
                )}
                <button
                  className="conv-item-menu"
                  aria-label={`ações de ${c.titulo}`}
                  title="renomear / arquivar"
                  onClick={() => setMenu((m) => (m === c.id ? null : c.id))}
                >
                  ⋯
                </button>
                {menu === c.id && (
                  <div className="conv-menu" role="menu">
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        setTituloNovo(c.titulo);
                        setEditando(c.id);
                      }}
                    >
                      renomear
                    </button>
                    <button role="menuitem" onClick={() => void arquivar(c)}>
                      arquivar
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="conv-rodape">
        {contagem.arquivadas > 0 ? `${contagem.ativas} ativas · ${contagem.arquivadas} arquivadas` : `${contagem.ativas} conversa${contagem.ativas === 1 ? "" : "s"}`}
      </div>
    </aside>
  );
}