/**
 * v3.85 — EXPLORADOR DA CONTA (aba "Meus arquivos"), igual à maquete aprovada pelo dono:
 * árvore de pastas SEM máquinas dentro, colunas ordenáveis, seleção, menu de contexto,
 * barra de status e a LIXEIRA como vista — excluir nunca apaga na hora (30 dias para voltar).
 *
 * Máquina é destino, não lugar: só aparece no menu "Enviar para máquina…".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { baixar, del, get, patch, post, qs, subirAnexo } from "../services/api";
import { fmtData } from "../lib/fmt";
import { useToast } from "./Toast";
import { tipoDoAnexo } from "./tipoAnexo";
import type { Escopo } from "../types";

type Pasta = { id: number; nome: string; pai_id: number | null; arquivos: number };
type Arq = {
  id: string;
  nome: string;
  mime: string;
  bytes: number;
  host: string;
  pasta_id: number | null;
  favorita: boolean;
  completo: boolean;
  criado_em: string;
  excluido_em: string | null;
};
type Usados = { arquivos: number; bytes: number; lixeira_itens: number; lixeira_bytes: number; pastas: number };
type Vista = "todos" | "favoritos" | "recentes" | "lixeira";
type Coluna = "nome" | "tamanho" | "enviado" | "excluido";
type Menu = { x: number; y: number; arq?: Arq; pasta?: Pasta };
type Alvo = { ids: string[]; pastaId?: number; modo: "mover" | "copiar" | "mover-pasta" };

function bytesLegiveis(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function desde(excluido: string | null): string {
  if (!excluido) return "";
  const dias = Math.floor((Date.now() - new Date(excluido).getTime()) / 86400000);
  return dias <= 0 ? "hoje" : `há ${dias} dia${dias > 1 ? "s" : ""}`;
}

function nivelDe(p: Pasta, todas: Pasta[]): number {
  const porId = new Map(todas.map((x) => [x.id, x]));
  let n = 0;
  let atual = p.pai_id;
  for (let i = 0; i < 40 && atual !== null; i++) {
    const pai = porId.get(atual);
    if (!pai) break;
    n++;
    atual = pai.pai_id;
  }
  return n;
}

const seta = (atual: Coluna, c: Coluna, asc: boolean) => (atual === c ? (asc ? "▲" : "▼") : "");

export function Explorador({ escopo }: { escopo: Escopo }) {
  const { toast } = useToast();
  const [pastas, setPastas] = useState<Pasta[]>([]);
  const [lixoPastas, setLixoPastas] = useState<Pasta[]>([]);
  const [arqs, setArqs] = useState<Arq[]>([]);
  const [vista, setVista] = useState<Vista>("todos");
  const [pasta, setPasta] = useState<number | null>(null);
  const [busca, setBusca] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [ordem, setOrdem] = useState<Coluna>("nome");
  const [crescente, setCrescente] = useState(true);
  const [abertas, setAbertas] = useState<Set<number>>(new Set());
  const [carregando, setCarregando] = useState(true);
  const [usados, setUsados] = useState<Usados>({ arquivos: 0, bytes: 0, lixeira_itens: 0, lixeira_bytes: 0, pastas: 0 });
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editando, setEditando] = useState<{ tipo: "arquivo" | "pasta"; id: string | number } | null>(null);
  const [nomeNovo, setNomeNovo] = useState("");
  const [alvo, setAlvo] = useState<Alvo | null>(null);
  const [enviando, setEnviando] = useState<{ arq: Arq; maquinas: Array<{ host: string; online: boolean }> } | null>(null);
  const [prop, setProp] = useState<Arq | null>(null);
  const [subindo, setSubindo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<number | null>(null);

  const naLixeira = vista === "lixeira";
  const t = escopo.tenant;

  const recarregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await get<{ arquivos: Arq[] }>(
        "/arquivos?" +
          qs({
            pasta: vista === "todos" && !busca.trim() ? (pasta ?? "raiz") : undefined,
            q: busca.trim(),
            lixeira: vista === "lixeira" ? 1 : undefined,
            favoritos: vista === "favoritos" ? 1 : undefined,
            recentes: vista === "recentes" ? 1 : undefined,
            limit: 500,
            tenant: t,
          }),
      );
      setArqs(r.arquivos);
    } catch (e) {
      toast(`não consegui listar: ${(e as Error).message}`, "erro");
      setArqs([]);
    }
    try {
      const [pl, ul] = await Promise.all([
        get<{ pastas: Pasta[] }>("/pastas?" + qs({ tenant: t })),
        get<Usados>("/arquivos/usados?" + qs({ tenant: t })),
      ]);
      setPastas(pl.pastas);
      setUsados(ul);
    } catch {
      /* a árvore que falhar não pode apagar a lista que já está na tela */
    }
    if (vista === "lixeira") {
      const lp = await get<{ pastas: Pasta[] }>("/pastas?" + qs({ lixeira: 1, tenant: t })).catch(() => ({ pastas: [] as Pasta[] }));
      setLixoPastas(lp.pastas);
    }
    setCarregando(false);
  }, [vista, pasta, busca, t, toast]);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  /* o menu de contexto morre em clique fora, ESC e rolagem; F2 renomeia a seleção única */
  useEffect(() => {
    const fechar = () => setMenu(null);
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", fechar);
    window.addEventListener("scroll", fechar, true);
    window.addEventListener("keydown", tecla);
    return () => {
      window.removeEventListener("click", fechar);
      window.removeEventListener("scroll", fechar, true);
      window.removeEventListener("keydown", tecla);
    };
  }, []);

  const filhos = useMemo(() => {
    const m = new Map<number | null, Pasta[]>();
    for (const p of pastas) m.set(p.pai_id, [...(m.get(p.pai_id) ?? []), p]);
    for (const lista of m.values()) lista.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return m;
  }, [pastas]);

  const caminho = useMemo(() => {
    const porId = new Map(pastas.map((p) => [p.id, p]));
    const trilha: Pasta[] = [];
    let atual: number | null = pasta;
    for (let i = 0; i < 40 && atual !== null; i++) {
      const p = porId.get(atual);
      if (!p) break;
      trilha.unshift(p);
      atual = p.pai_id;
    }
    return trilha;
  }, [pasta, pastas]);

  const linhas = useMemo(() => {
    const cmp = (a: Arq, b: Arq): number => {
      if (ordem === "tamanho") return a.bytes - b.bytes;
      if (ordem === "enviado") return new Date(a.criado_em).getTime() - new Date(b.criado_em).getTime();
      if (ordem === "excluido") return new Date(a.excluido_em ?? 0).getTime() - new Date(b.excluido_em ?? 0).getTime();
      return a.nome.localeCompare(b.nome, "pt-BR", { numeric: true });
    };
    return [...arqs].sort((a, b) => (crescente ? cmp(a, b) : -cmp(a, b)));
  }, [arqs, ordem, crescente]);

  const nomeDe = (id: number | null) => (id === null ? "raiz da conta" : pastas.find((p) => p.id === id)?.nome ?? "—");

  function marcar(id: string, on: boolean) {
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  function coluna(c: Coluna) {
    if (c === ordem) setCrescente(!crescente);
    else {
      setOrdem(c);
      setCrescente(c === "nome");
    }
  }

  function novaPasta() {
    setMenu(null);
    setEditando({ tipo: "pasta", id: 0 });
    setNomeNovo("");
  }

  function renomearArquivo(a: Arq) {
    setMenu(null);
    setSel(new Set([a.id]));
    setEditando({ tipo: "arquivo", id: a.id });
    setNomeNovo(a.nome);
  }

  function renomearPasta(p: Pasta) {
    setMenu(null);
    setEditando({ tipo: "pasta", id: p.id });
    setNomeNovo(p.nome);
  }

  async function confirmarEdicao() {
    const e = editando;
    const nome = nomeNovo.trim();
    setEditando(null);
    if (!e || !nome) return;
    try {
      if (e.tipo === "pasta") {
        if (e.id === 0) await post("/pastas", { nome, pai_id: pasta ?? 0, tenant: t });
        else await patch(`/pastas/${e.id}`, { nome, tenant: t });
        toast(e.id === 0 ? `pasta "${nome}" criada` : "pasta renomeada", "sucesso");
      } else {
        await patch(`/arquivos/${e.id}`, { nome, tenant: t });
        toast("renomeado", "sucesso");
      }
      void recarregar();
    } catch (err) {
      toast((err as Error).message, "erro");
    }
  }

  async function abrirPasta(p: Pasta) {
    setMenu(null);
    setVista("todos");
    setPasta(p.id);
    setSel(new Set());
    setAbertas((s) => new Set(s).add(p.id));
  }

  async function apagarPasta(id: number, definitivo: boolean) {
    setMenu(null);
    try {
      const r = await del<{ pastas: number; arquivos: number }>(`/pastas/${id}?` + qs({ definitivo: definitivo ? 1 : undefined, tenant: t }));
      toast(definitivo ? `${r.pastas} pasta(s) apagadas de vez` : `pasta na lixeira (${r.arquivos} arquivo(s) junto)`, "sucesso");
      void recarregar();
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function restaurarPasta(id: number) {
    setMenu(null);
    try {
      const r = await post<{ pasta: string; para: string; arquivos: number; aviso: string }>(`/pastas/${id}/restaurar`, { tenant: t });
      toast(`"${r.pasta}" voltou para ${r.para} · ${r.arquivos} arquivo(s)${r.aviso ? " · " + r.aviso : ""}`, "sucesso");
      void recarregar();
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function excluir(ids: string[], definitivo: boolean) {
    if (!ids.length) return toast("marque o que quer excluir", "erro");
    setMenu(null);
    try {
      const r = await post<{ excluidos: number; lixeira: boolean }>("/arquivos/excluir", { ids, definitivo, tenant: t });
      toast(r.lixeira ? `${r.excluidos} item(ns) na lixeira — 30 dias para voltar` : `${r.excluidos} item(ns) apagados de vez`, "sucesso");
      setSel(new Set());
      void recarregar();
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function restaurar(ids: string[]) {
    if (!ids.length) return toast("marque o que quer restaurar", "erro");
    try {
      const r = await post<{ restaurados: number; aviso: string }>("/arquivos/restaurar", { ids, tenant: t });
      toast(`${r.restaurados} de volta${r.aviso ? " · " + r.aviso : ""}`, "sucesso");
      setSel(new Set());
      void recarregar();
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function esvaziar() {
    try {
      const r = await del<{ arquivos: number; pastas: number }>("/arquivos/lixeira?" + qs({ tenant: t }));
      toast(`lixeira vazia: ${r.arquivos} arquivo(s) e ${r.pastas} pasta(s) liberados`, "sucesso");
      setSel(new Set());
      void recarregar();
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function baixarSel(ids: string[]) {
    if (!ids.length) return toast("marque o que quer baixar", "erro");
    setMenu(null);
    try {
      if (ids.length === 1) {
        const a = arqs.find((x) => x.id === ids[0]);
        await baixar(`/anexos/${encodeURIComponent(ids[0])}`, a?.nome || "arquivo");
      } else {
        await baixar(`/arquivos/zip?` + qs({ ids: ids.join(","), tenant: t }), "arquivos.zip");
        toast(`${ids.length} arquivos em um .zip`, "sucesso");
      }
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function aplicarAlvo(para: number | null) {
    const a = alvo;
    setAlvo(null);
    if (!a) return;
    try {
      if (a.modo === "copiar") {
        const r = await post<{ copiados: string[] }>("/arquivos/copiar", { ids: a.ids, pasta: para ?? 0, tenant: t });
        toast(`${r.copiados.length} copiado(s) para ${nomeDe(para)}`, "sucesso");
      } else if (a.modo === "mover-pasta") {
        await patch(`/pastas/${a.pastaId}`, { pai_id: para ?? 0, tenant: t });
        toast("pasta movida", "sucesso");
      } else {
        for (const id of a.ids) await patch(`/arquivos/${id}`, { pasta_id: para ?? 0, tenant: t });
        toast(`${a.ids.length} movido(s) para ${nomeDe(para)}`, "sucesso");
      }
      setSel(new Set());
      void recarregar();
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function favoritar(a: Arq) {
    setMenu(null);
    try {
      await patch(`/arquivos/${a.id}`, { favorita: !a.favorita, tenant: t });
      void recarregar();
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function escolher(files: FileList | null) {
    if (!files || !files.length) return;
    for (const f of Array.from(files)) {
      setSubindo(`${f.name} · 0%`);
      try {
        const a = await subirAnexo(f, (feito, total) => setSubindo(`${f.name} · ${Math.round((feito / Math.max(total, 1)) * 100)}%`));
        if (pasta !== null) await patch(`/arquivos/${a.id}`, { pasta_id: pasta, tenant: t });
      } catch (e) {
        toast(`falha em ${f.name}: ${(e as Error).message}`, "erro");
      }
    }
    setSubindo("");
    void recarregar();
  }

  async function abrirEnvio(a: Arq) {
    setMenu(null);
    try {
      const r = await get<{ maquinas: Array<{ host: string; online: boolean }> }>("/maquinas?" + qs({ tenant: t }));
      setEnviando({ arq: a, maquinas: r.maquinas ?? [] });
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  async function enviarParaMaquina(host: string) {
    const a = enviando?.arq;
    setEnviando(null);
    if (!a) return;
    try {
      await post("/arquivos/para-maquina", { anexo_id: a.id, host, tenant: t });
      toast(`"${a.nome}" seguindo para ${host} (cai em Downloads da máquina)`, "sucesso");
    } catch (e) {
      toast((e as Error).message, "erro");
    }
  }

  function aoDireito(e: React.MouseEvent, arq?: Arq, p?: Pasta) {
    e.preventDefault();
    e.stopPropagation();
    if (arq) setSel(new Set([arq.id]));
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 270),
      y: Math.min(e.clientY, window.innerHeight - 360),
      arq,
      pasta: p,
    });
  }

  function aoColarF2(e: React.KeyboardEvent) {
    if (e.key !== "F2" || sel.size !== 1 || editando) return;
    const a = arqs.find((x) => x.id === [...sel][0]);
    if (a) renomearArquivo(a);
  }

  const todosSel = linhas.length > 0 && linhas.every((a) => sel.has(a.id));
  const bytesSel = linhas.filter((a) => sel.has(a.id)).reduce((s, a) => s + a.bytes, 0);

  function linhaArvore(p: Pasta, nivel: number): ReactElement[] {
    const kids = filhos.get(p.id) ?? [];
    const open = abertas.has(p.id);
    const saida: ReactElement[] = [
      <div
        key={`p${p.id}`}
        className={"no" + (pasta === p.id && vista === "todos" ? " on" : "")}
        style={{ paddingLeft: 8 + nivel * 13 }}
        onClick={() => void abrirPasta(p)}
        onContextMenu={(e) => aoDireito(e, undefined, p)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && void abrirPasta(p)}
      >
        <span
          className="chev"
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            setAbertas((s) => {
              const n = new Set(s);
              if (n.has(p.id)) n.delete(p.id);
              else n.add(p.id);
              return n;
            });
          }}
        >
          {kids.length ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="ic" aria-hidden="true">
          📁
        </span>
        <span className="nm" title={p.nome}>
          {p.nome}
        </span>
        <span className="qt">{p.arquivos || ""}</span>
      </div>,
    ];
    if (open) for (const k of kids) saida.push(...linhaArvore(k, nivel + 1));
    return saida;
  }

  return (
    <section className="explorador" aria-label="explorador de arquivos da conta" onKeyDown={aoColarF2}>
      <aside className="col-lado">
        <div className="grupo">estes arquivos</div>
        {(
          [
            ["todos", "📁", "Todos", String(usados.arquivos || "")],
            ["favoritos", "⭐", "Favoritos", ""],
            ["recentes", "🕘", "Recentes", ""],
            ["lixeira", "🗑", "Lixeira", String(usados.lixeira_itens || "")],
          ] as Array<[Vista, string, string, string]>
        ).map(([v, icone, rotulo, badge]) => (
          <div
            key={v}
            className={"no" + (vista === v ? " on" : "")}
            role="button"
            tabIndex={0}
            onClick={() => {
              setVista(v);
              setSel(new Set());
            }}
            onKeyDown={(e) => e.key === "Enter" && setVista(v)}
          >
            <span className="chev" aria-hidden="true" />
            <span className="ic" aria-hidden="true">
              {icone}
            </span>
            <span className="nm">{rotulo}</span>
            {badge && <span className="qt">{badge}</span>}
          </div>
        ))}

        <div className="grupo com-acao">
          <span>pastas</span>
          <button className="btn-mini" onClick={novaPasta} title="nova pasta nesta pasta" aria-label="nova pasta">
            +
          </button>
        </div>
        <div
          className={"no" + (vista === "todos" && pasta === null ? " on" : "")}
          role="button"
          tabIndex={0}
          onClick={() => {
            setVista("todos");
            setPasta(null);
          }}
        >
          <span className="chev" aria-hidden="true" />
          <span className="ic" aria-hidden="true">
            🏠
          </span>
          <span className="nm">raiz da conta</span>
        </div>
        {(filhos.get(null) ?? []).flatMap((p) => linhaArvore(p, 0))}
        {!usados.pastas && <p className="dica-arvore">nenhuma pasta ainda — o que chega das máquinas cai na raiz</p>}

        {naLixeira && !!lixoPastas.length && (
          <>
            <div className="grupo">pastas na lixeira</div>
            {lixoPastas.map((p) => (
              <div key={`lp${p.id}`} className="no" onContextMenu={(e) => aoDireito(e, undefined, p)}>
                <span className="chev" aria-hidden="true" />
                <span className="ic" aria-hidden="true">
                  🗑
                </span>
                <span className="nm">{p.nome}</span>
                <button className="btn-mini" onClick={() => void restaurarPasta(p.id)} aria-label={`restaurar pasta ${p.nome}`}>
                  voltar
                </button>
              </div>
            ))}
          </>
        )}
      </aside>

      <div className="col-main">
        <div className="toolbar">
          <button className="btn btn-primario" onClick={() => fileRef.current?.click()} disabled={naLixeira} title="enviar um arquivo para esta pasta">
            Novo
          </button>
          <button className="btn" onClick={novaPasta} disabled={naLixeira}>
            Nova pasta
          </button>
          <span className="sep" />
          <button className="btn" onClick={() => void baixarSel([...sel])} disabled={!sel.size}>
            Baixar
          </button>
          {!naLixeira ? (
            <>
              <button
                className="btn"
                onClick={() => (sel.size ? setAlvo({ ids: [...sel], modo: "mover" }) : toast("marque o que mover", "erro"))}
                disabled={!sel.size}
              >
                Mover para…
              </button>
              <button className="btn btn-sutil" onClick={() => void excluir([...sel], false)} disabled={!sel.size}>
                Excluir
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-reviver" onClick={() => void restaurar([...sel])} disabled={!sel.size}>
                Restaurar
              </button>
              <button className="btn btn-perigo" onClick={() => void excluir([...sel], true)} disabled={!sel.size}>
                Excluir definitivamente
              </button>
            </>
          )}
          {subindo && <span className="subindo">{subindo}</span>}
        </div>

        <input ref={fileRef} type="file" multiple hidden onChange={(e) => void escolher(e.target.files)} aria-label="escolher arquivos" />

        <div className="migalhas">
          <button
            className="lig"
            onClick={() => {
              setVista("todos");
              setPasta(null);
            }}
          >
            Estes arquivos
          </button>
          {caminho.map((p, i) => (
            <span key={p.id} className="trilho">
              <span className="tra">›</span>
              <button className={"lig" + (i === caminho.length - 1 ? " atual" : "")} onClick={() => void abrirPasta(p)}>
                {p.nome}
              </button>
            </span>
          ))}
          {naLixeira && <span className="tra">›</span>}
          {naLixeira && <span className="lig atual">Lixeira</span>}
          <span className="espaço" />
          <input
            className="campo busca"
            placeholder="buscar nesta conta…"
            aria-label="buscar arquivo"
            value={busca}
            onChange={(e) => {
              const v = e.target.value;
              if (debounce.current) window.clearTimeout(debounce.current);
              debounce.current = window.setTimeout(() => setBusca(v), 300);
            }}
          />
        </div>

        <table className="tabela lista">
          <thead>
            <tr>
              <th className="chk">
                <input
                  type="checkbox"
                  aria-label="selecionar tudo"
                  checked={todosSel}
                  onChange={(e) => setSel(e.target.checked ? new Set(linhas.map((a) => a.id)) : new Set())}
                />
              </th>
              <th className="ord" onClick={() => coluna("nome")}>
                Nome {seta(ordem, "nome", crescente)}
              </th>
              <th>Origem</th>
              <th className="ord num" onClick={() => coluna("tamanho")}>
                Tamanho {seta(ordem, "tamanho", crescente)}
              </th>
              {!naLixeira ? (
                <th className="ord" onClick={() => coluna("enviado")}>
                  Enviado {seta(ordem, "enviado", crescente)}
                </th>
              ) : (
                <th className="ord" onClick={() => coluna("excluido")}>
                  Excluído em {seta(ordem, "excluido", crescente)}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {carregando && (
              <tr>
                <td colSpan={5} className="text-txt3">
                  carregando…
                </td>
              </tr>
            )}
            {!carregando && !linhas.length && (
              <tr>
                <td colSpan={5} className="text-txt3">
                  {busca.trim()
                    ? `nada com "${busca.trim()}" nesta conta`
                    : naLixeira
                      ? "a lixeira está vazia — apagar um arquivo traz ele para cá por 30 dias"
                      : pasta === null
                        ? "raiz vazia — envie um arquivo ou crie uma pasta"
                        : "pasta vazia"}
                </td>
              </tr>
            )}
            {!carregando &&
              linhas.map((a) => {
                const ic = tipoDoAnexo(a.mime);
                return (
                  <tr
                    key={a.id}
                    className={"linha" + (sel.has(a.id) ? " sel" : "")}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).tagName === "INPUT") return;
                      if (e.ctrlKey || e.metaKey) marcar(a.id, !sel.has(a.id));
                      else setSel(new Set([a.id]));
                    }}
                    onDoubleClick={() => (naLixeira ? void restaurar([a.id]) : void baixarSel([a.id]))}
                    onContextMenu={(e) => aoDireito(e, a)}
                  >
                    <td className="chk">
                      <input type="checkbox" aria-label={`selecionar ${a.nome}`} checked={sel.has(a.id)} onChange={(e) => marcar(a.id, e.target.checked)} />
                    </td>
                    <td>
                      <div className="nomelim">
                        <span className="ico" style={{ background: ic.cor + "1f", color: ic.cor }} aria-hidden="true">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d={ic.d} />
                          </svg>
                        </span>
                        <span className="nm-arq" title={a.nome}>
                          {a.nome}
                        </span>
                        {!naLixeira && (
                          <button
                            className={"estrela" + (a.favorita ? " on" : "")}
                            onClick={(e) => {
                              e.stopPropagation();
                              void favoritar(a);
                            }}
                            aria-label={a.favorita ? `tirar ${a.nome} dos favoritos` : `favoritar ${a.nome}`}
                            title={a.favorita ? "tirar dos favoritos" : "favoritar"}
                          >
                            {a.favorita ? "★" : "☆"}
                          </button>
                        )}
                        {!a.completo && <span className="chip">incompleto</span>}
                        {naLixeira && <span className="chip">na lixeira</span>}
                      </div>
                      <div className="sub-nome">
                        {ic.rotulo}
                        {a.pasta_id ? ` · ${nomeDe(a.pasta_id)}` : " · raiz"}
                      </div>
                    </td>
                    <td>
                      <span className="tcode">{a.host || "web"}</span>
                    </td>
                    <td className="num">{bytesLegiveis(a.bytes)}</td>
                    {!naLixeira ? (
                      <td className="data">{fmtData(a.criado_em)}</td>
                    ) : (
                      <td className="data">
                        {fmtData(a.excluido_em)} <span className="sub2">({desde(a.excluido_em)})</span>
                      </td>
                    )}
                  </tr>
                );
              })}
          </tbody>
        </table>

        <div className="statusbar">
          <span>
            {linhas.length} item{linhas.length === 1 ? "" : "s"}
          </span>
          <span className="tra">·</span>
          <span>
            {sel.size} selecionado{sel.size === 1 ? "" : "s"} ({bytesLegiveis(bytesSel)})
          </span>
          <span className="tra">·</span>
          <span>{bytesLegiveis(usados.bytes)} usados nesta conta</span>
          {!!usados.lixeira_itens && (
            <>
              <span className="tra">·</span>
              <span>
                {bytesLegiveis(usados.lixeira_bytes)} na lixeira ({usados.lixeira_itens})
              </span>
            </>
          )}
          <span className="espaço" />
          <span className="sub2">
            {naLixeira ? "restaurar devolve para a pasta de origem · esvaziar libera o espaço na hora" : "excluir vai para a lixeira (30 dias)"}
          </span>
          {naLixeira && (
            <button className="btn btn-perigo" onClick={() => void esvaziar()} disabled={!usados.lixeira_itens && !lixoPastas.length}>
              Esvaziar lixeira
            </button>
          )}
        </div>
      </div>

      {menu && (
        <div className="menu-contexto" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.pasta ? (
            naLixeira ? (
              <button onClick={() => void restaurarPasta(menu.pasta!.id)}>Restaurar</button>
            ) : (
              <>
                <button onClick={() => void abrirPasta(menu.pasta!)}>Abrir</button>
                <button onClick={() => renomearPasta(menu.pasta!)}>Renomear</button>
                <button
                  onClick={() => {
                    const id = menu.pasta!.id;
                    setMenu(null);
                    setAlvo({ ids: [], pastaId: id, modo: "mover-pasta" });
                  }}
                >
                  Mover para…
                </button>
                <button onClick={() => void apagarPasta(menu.pasta!.id, false)}>Excluir</button>
                <button className="perigo" onClick={() => void apagarPasta(menu.pasta!.id, true)}>
                  Excluir definitivamente
                </button>
              </>
            )
          ) : menu.arq ? (
            naLixeira ? (
              <>
                <button onClick={() => void restaurar([menu.arq!.id])}>Restaurar</button>
                <button className="perigo" onClick={() => void excluir([menu.arq!.id], true)}>
                  Excluir definitivamente
                </button>
              </>
            ) : (
              <>
                <button onClick={() => void baixarSel([menu.arq!.id])}>Abrir / Baixar</button>
                <button onClick={() => void abrirEnvio(menu.arq!)}>Enviar para máquina…</button>
                <button onClick={() => renomearArquivo(menu.arq!)}>
                  Renomear <span className="atalho">F2</span>
                </button>
                <button
                  onClick={() => {
                    const id = menu.arq!.id;
                    setMenu(null);
                    setAlvo({ ids: [id], modo: "copiar" });
                  }}
                >
                  Copiar para…
                </button>
                <button
                  onClick={() => {
                    const id = menu.arq!.id;
                    setMenu(null);
                    setAlvo({ ids: [id], modo: "mover" });
                  }}
                >
                  Mover para…
                </button>
                <button onClick={() => void favoritar(menu.arq!)}>{menu.arq.favorita ? "Tirar dos favoritos" : "Favoritar"}</button>
                <button
                  onClick={() => {
                    setProp(menu.arq!);
                    setMenu(null);
                  }}
                >
                  Propriedades
                </button>
                <hr />
                <button className="perigo" onClick={() => void excluir([menu.arq!.id], false)}>
                  Excluir
                </button>
                <p className="dica-menu">vai para a lixeira, volta depois</p>
              </>
            )
          ) : null}
        </div>
      )}

      {editando && (
        <div className="veu" role="dialog" aria-modal="true" aria-label={editando.tipo === "pasta" ? "pasta" : "renomear arquivo"}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editando.tipo === "pasta" ? (editando.id === 0 ? "Nova pasta" : "Renomear pasta") : "Renomear arquivo"}</h3>
            <input
              className="campo"
              autoFocus
              value={nomeNovo}
              onChange={(e) => setNomeNovo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void confirmarEdicao()}
              placeholder="nome"
              aria-label="nome"
            />
            {editando.tipo === "pasta" && editando.id === 0 && (
              <p className="sub2">dentro de: {caminho.length ? caminho[caminho.length - 1].nome : "raiz da conta"}</p>
            )}
            <div className="rodape-modal">
              <button className="btn" onClick={() => setEditando(null)}>
                Cancelar
              </button>
              <button className="btn btn-primario" onClick={() => void confirmarEdicao()}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {alvo && (
        <div className="veu" role="dialog" aria-modal="true" aria-label="escolher pasta de destino">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{alvo.modo === "copiar" ? "Copiar para…" : "Mover para…"}</h3>
            <button className="no" onClick={() => void aplicarAlvo(null)}>
              🏠 raiz da conta
            </button>
            {pastas
              .filter((p) => p.id !== alvo.pastaId)
              .map((p) => (
                <button key={`d${p.id}`} className="no" style={{ paddingLeft: 8 + nivelDe(p, pastas) * 13 }} onClick={() => void aplicarAlvo(p.id)}>
                  📁 {p.nome}
                </button>
              ))}
            <div className="rodape-modal">
              <button className="btn" onClick={() => setAlvo(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {enviando && (
        <div className="veu" role="dialog" aria-modal="true" aria-label="enviar para máquina">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              Enviar “{enviando.arq.nome}” para…
            </h3>
            {!enviando.maquinas.length && <p className="sub2">nenhuma máquina pareada nesta conta</p>}
            {enviando.maquinas.map((m) => (
              <button key={m.host} className="no" onClick={() => void enviarParaMaquina(m.host)} disabled={!m.online}>
                💻 {m.host} <span className="qt">{m.online ? "on-line" : "desligada"}</span>
              </button>
            ))}
            <p className="sub2">a máquina busca o arquivo e grava na pasta Downloads dela</p>
            <div className="rodape-modal">
              <button className="btn" onClick={() => setEnviando(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {prop && (
        <div className="veu" role="dialog" aria-modal="true" aria-label="propriedades" onClick={() => setProp(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{prop.nome}</h3>
            <dl className="props">
              <dt>tipo</dt>
              <dd>
                {tipoDoAnexo(prop.mime).rotulo} · {prop.mime || "—"}
              </dd>
              <dt>tamanho</dt>
              <dd>{bytesLegiveis(prop.bytes)}</dd>
              <dt>enviado</dt>
              <dd>{fmtData(prop.criado_em)}</dd>
              <dt>origem</dt>
              <dd>{prop.host || "web"}</dd>
              <dt>pasta</dt>
              <dd>{nomeDe(prop.pasta_id)}</dd>
              <dt>id</dt>
              <dd className="mono">{prop.id}</dd>
            </dl>
            <div className="rodape-modal">
              <button className="btn" onClick={() => setProp(null)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

