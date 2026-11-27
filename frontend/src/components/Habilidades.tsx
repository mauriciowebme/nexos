/* v3.84 — HABILIDADES (atalhos da conta).
 *
 * A pessoa escreve o pedido uma vez, com as palavras dela, e marca como favorita: o cartão
 * aparece na tela inicial do chat. Sem isso, os cartões eram fixos no código e a frase que
 * ia para o agente era suposição de quem escreveu a tela — o dono reclamou, com razão:
 * "o agente não vai entender bem, é muito genérico".
 *
 * Cada habilidade tem três campos, e cada um tem um dono:
 *   nome        → título do cartão (curto);
 *   quando_usar → uma linha que entra no índice do prompt (o agente sabe QUANDO vale);
 *   corpo       → o pedido/instrução completo, lido sob demanda pela tool `ler_habilidade`.
 */
import { useEffect, useState } from "react";
import { del, get, patch, post } from "../services/api";

type Habilidade = {
  id: number;
  nome: string;
  quando_usar: string;
  corpo: string;
  favorita: boolean;
  ordem: number;
};

const VAZIA = { nome: "", quando_usar: "", corpo: "", favorita: false };

export function Habilidades() {
  const [lista, setLista] = useState<Habilidade[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [form, setForm] = useState<typeof VAZIA>(VAZIA);
  const [editando, setEditando] = useState<number | null>(null);
  const [confirmando, setConfirmando] = useState<number | null>(null);

  async function carregar() {
    setCarregando(true);
    try {
      const r = await get<{ habilidades: Habilidade[] }>("/habilidades");
      setLista(r.habilidades ?? []);
      setErro("");
    } catch (e) {
      setErro((e as Error).message || "não consegui carregar as habilidades");
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    void carregar();
  }, []);

  function limpar() {
    setForm(VAZIA);
    setEditando(null);
  }

  async function salvar(ev: React.FormEvent) {
    ev.preventDefault();
    setErro("");
    setAviso("");
    try {
      if (editando !== null) {
        const h = await patch<Habilidade>(`/habilidades/${editando}`, form);
        setLista((l) => l.map((x) => (x.id === h.id ? h : x)));
        setAviso(`"${h.nome}" salva`);
      } else {
        const h = await post<Habilidade>("/habilidades", form);
        setLista((l) => [h, ...l]);
        setAviso(`"${h.nome}" criada`);
      }
      limpar();
    } catch (e) {
      setErro((e as Error).message || "não consegui salvar");
    }
  }

  async function favoritar(h: Habilidade) {
    try {
      const novo = await post<Habilidade>(`/habilidades/${h.id}/favorita`, { favorita: !h.favorita });
      setLista((l) => l.map((x) => (x.id === novo.id ? novo : x)));
    } catch (e) {
      setErro((e as Error).message || "não consegui mudar o favorito");
    }
  }

  async function remover(h: Habilidade) {
    try {
      await del(`/habilidades/${h.id}`);
      setLista((l) => l.filter((x) => x.id !== h.id));
      setConfirmando(null);
      if (editando === h.id) limpar();
      setAviso(`"${h.nome}" removida`);
    } catch (e) {
      setErro((e as Error).message || "não consegui remover");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5" id="telaHabilidades">
      <div>
        <h1 className="text-[19px] font-[650] text-txt">Habilidades</h1>
        <p className="mt-1 max-w-[640px] text-[12.5px] text-txt3">
          Atalhos escritos por você. O que estiver marcado como favorito aparece como cartão na
          tela inicial do chat, e o agente lê o conteúdo quando o pedido combina.
        </p>
      </div>

      <form onSubmit={salvar} className="flex max-w-[720px] flex-col gap-2 rounded-[12px] border border-borda bg-sup p-3">
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.05em] text-txt3">
          nome (título do cartão)
          <input
            id="habNome"
            className="rounded-[9px] border border-borda bg-bg px-2.5 py-[7px] text-[13px] normal-case tracking-normal text-txt outline-none focus:border-bordaforte"
            value={form.nome}
            maxLength={60}
            placeholder="notícias de ia em painel"
            onChange={(e) => setForm({ ...form, nome: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.05em] text-txt3">
          quando usar (uma linha — entra no prompt)
          <input
            id="habQuando"
            className="rounded-[9px] border border-borda bg-bg px-2.5 py-[7px] text-[13px] normal-case tracking-normal text-txt outline-none focus:border-bordaforte"
            value={form.quando_usar}
            maxLength={200}
            placeholder="quando pedirem notícias de ia com fontes"
            onChange={(e) => setForm({ ...form, quando_usar: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.05em] text-txt3">
          o pedido (o que o agente deve fazer, nas suas palavras)
          <textarea
            id="habCorpo"
            className="min-h-[92px] resize-y rounded-[9px] border border-borda bg-bg px-2.5 py-[7px] text-[13px] normal-case tracking-normal text-txt outline-none focus:border-bordaforte"
            value={form.corpo}
            maxLength={8000}
            placeholder="pesquise na web as notícias de hoje sobre IA local, abra as 3 mais relevantes e monte um painel em HTML com título, data e link de cada uma"
            onChange={(e) => setForm({ ...form, corpo: e.target.value })}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-txt2">
            <input
              id="habFavorita"
              type="checkbox"
              checked={form.favorita}
              onChange={(e) => setForm({ ...form, favorita: e.target.checked })}
            />
            mostrar como cartão na tela inicial
          </label>
          <span className="flex-1" />
          {editando !== null && (
            <button type="button" className="btn btn-mini" onClick={limpar}>
              cancelar
            </button>
          )}
          <button id="habSalvar" type="submit" className="btn btn-mini btn-primario">
            {editando !== null ? "salvar" : "criar habilidade"}
          </button>
        </div>
        {erro && <p className="text-[12px] text-vermelho" role="alert">{erro}</p>}
        {aviso && <p className="text-[12px] text-verde" role="status">{aviso}</p>}
      </form>

      <div className="flex max-w-[720px] flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-txt3">
          minhas habilidades <span className="text-txt3">· {lista.length}</span>
        </div>
        {carregando && <p className="text-[12.5px] text-txt3">carregando…</p>}
        {!carregando && lista.length === 0 && (
          <p className="rounded-[10px] border border-dashed border-borda px-3 py-4 text-[12.5px] text-txt3">
            nenhuma ainda. Escreva o pedido acima, com as suas palavras — é ele que vai para o agente.
          </p>
        )}
        {lista.map((h) => (
          <div key={h.id} className="rounded-[10px] border border-borda bg-sup px-3 py-2.5" data-habilidade={h.nome}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] text-txt">{h.nome}</span>
              {h.favorita && (
                <span className="rounded-[6px] border border-verde/40 bg-verde/10 px-1.5 py-[1px] text-[10.5px] text-verde">
                  cartão na home
                </span>
              )}
              <span className="flex-1" />
              <button className="btn btn-mini" onClick={() => favoritar(h)} title="mostrar ou esconder o cartão da tela inicial">
                {h.favorita ? "tirar do início" : "pôr no início"}
              </button>
              <button
                className="btn btn-mini"
                onClick={() => {
                  setEditando(h.id);
                  setForm({ nome: h.nome, quando_usar: h.quando_usar, corpo: h.corpo, favorita: h.favorita });
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                editar
              </button>
              {confirmando === h.id ? (
                <>
                  <button className="btn btn-mini btn-perigo" onClick={() => remover(h)}>
                    confirmar remoção
                  </button>
                  <button className="btn btn-mini" onClick={() => setConfirmando(null)}>
                    não
                  </button>
                </>
              ) : (
                <button className="btn btn-mini" onClick={() => setConfirmando(h.id)}>
                  remover
                </button>
              )}
            </div>
            {h.quando_usar && <p className="mt-1 text-[11.5px] text-txt3">quando usar: {h.quando_usar}</p>}
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12.5px] text-txt2">{h.corpo}</p>
          </div>
        ))}
      </div>
    </div>
  );
}