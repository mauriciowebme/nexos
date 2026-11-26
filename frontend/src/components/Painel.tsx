import { useCallback, useEffect, useState } from "react";
import { get, qs } from "../services/api";
import { fmtData } from "../lib/fmt";
import { useToast } from "./Toast";
import type { DashboardResp } from "../types";

/** Painel: números do acervo em uma chamada (GET /dashboard). */
export function Painel({ tenant, operador }: { tenant: string; operador: boolean }) {
  const { toast } = useToast();
  const [d, setD] = useState<DashboardResp | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await get<DashboardResp>("/dashboard" + (operador && tenant ? "?" + qs({ tenant }) : ""));
      setD(r);
    } catch (e) {
      toast("painel: " + (e as Error).message, "erro");
    } finally {
      setCarregando(false);
    }
  }, [operador, tenant, toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (!d) {
    return <p className="dica">{carregando ? "carregando números…" : "não consegui carregar"}</p>;
  }

  const n = d.numeros;
  const maior = Math.max(1, ...d.por_usuario.map((u) => u.documentos));
  const pendentes = (d.fila.na_fila ?? 0) + (d.fila.processando ?? 0);

  return (
    <section className="flex flex-col gap-4" id="telaPainel">
      <div className="barra">
        <div>
          <h1>Painel</h1>
          <div className="mt-1 text-[12.8px] text-txt3">visão geral do acervo</div>
        </div>
        <span className="flex-1" />
        <button className="btn btn-sutil" title="recarregar números" onClick={() => void carregar()}>
          ⟳
        </button>
      </div>

      <div className="grade-kpi" id="kpis">
        <div className="kpi">
          <div className="kpi-rot">usuários</div>
          <div className="kpi-val">{n.usuarios}</div>
          <div className="kpi-pe">{n.operadores === 1 ? "1 administrador" : `${n.operadores} administradores`}</div>
        </div>
        <div className="kpi">
          <div className="kpi-rot">gavetas</div>
          <div className="kpi-val">{n.gavetas}</div>
          <div className="kpi-pe">{n.gavetas === 1 ? "1 gaveta" : `${n.gavetas} gavetas`}</div>
        </div>
        <div className="kpi">
          <div className="kpi-rot">documentos</div>
          <div className="kpi-val">{n.documentos}</div>
          <div className="kpi-pe">originais guardados</div>
        </div>
        <div className="kpi">
          <div className="kpi-rot">trechos indexados</div>
          <div className="kpi-val">{n.chunks}</div>
          <div className="kpi-pe">
            {n.chunks_arquivados ? `${n.chunks_arquivados} arquivados` : `${d.saude.dim} dimensões`}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-rot">fila</div>
          <div className="kpi-val">{pendentes}</div>
          <div className="kpi-pe">{d.fila.concluido ?? 0} concluídos</div>
        </div>
        <div className="kpi">
          <div className="kpi-rot">buscas hoje</div>
          <div className="kpi-val">{d.buscas_hoje}</div>
          <div className="kpi-pe">{d.chats_hoje} no chat</div>
        </div>
      </div>

      <div className="grade-2">
        <div className="cartao">
          <h2 className="mb-3 text-[13px] font-semibold text-txt2">
            Documentos por usuário <span className="sub2">— {n.documentos} no total</span>
          </h2>
          {d.por_usuario.length === 0 ? (
            <p className="dica m-0">nenhum documento ainda</p>
          ) : (
            d.por_usuario.map((u) => (
              <div className="linha-barra" key={u.tenant}>
                <span className="nome">{u.tenant}</span>
                <span className="trilho">
                  <span className="fill" style={{ width: `${Math.max(2, (u.documentos / maior) * 100)}%` }} />
                </span>
                <span className="n">{u.documentos}</span>
              </div>
            ))
          )}
        </div>

        <div className="cartao">
          <h2 className="mb-3 text-[13px] font-semibold text-txt2">Saúde do sistema</h2>
          <div className="saude">
            <div className="it">
              <span className={"dot" + (d.saude.embedder === "ok" ? "" : " ruim")} /> motor de busca
              <span className="v">{d.saude.embedder} · {d.saude.dim}</span>
            </div>
            <div className="it">
              <span className={"dot" + (d.saude.ocr === "ok" ? "" : " ruim")} /> leitor de imagem
              <span className="v">{d.saude.ocr === "ok" ? "ok · PP-OCRv6" : d.saude.ocr}</span>
            </div>
            <div className="it">
              <span className={"dot" + (d.saude.provider === "nao configurado" ? " cinza" : "")} /> provider do chat
              <span className="v">
                {d.saude.provider === "nao configurado" ? (
                  <span className="chip chip-ambar">não configurado</span>
                ) : (
                  <span className="chip chip-verde">{d.saude.provider}</span>
                )}
              </span>
            </div>
            <div className="it">
              <span className="dot cinza" /> fila
              <span className="v">
                {pendentes ? `${pendentes} pendente(s)` : "nada pendente"}
              </span>
            </div>
            <div className="it borda-topo">
              versão <span className="v mono">{d.versao}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="cartao">
        <h2 className="mb-3 text-[13px] font-semibold text-txt2">
          Últimos envios <span className="sub2">— {n.documentos} documento(s) no acervo</span>
        </h2>
        {d.ultimos.length === 0 ? (
          <p className="dica m-0">nenhum arquivo enviado ainda</p>
        ) : (
          <div className="tabela-wrap">
            <table className="tabela">
              <thead>
                <tr>
                  <th>documento</th>
                  <th>usuário</th>
                  <th>gaveta</th>
                  <th>tipo</th>
                  <th>quando</th>
                </tr>
              </thead>
              <tbody>
                {d.ultimos.map((u) => (
                  <tr key={`${u.tenant}|${u.memoria}|${u.doc_id}`}>
                    <td data-rot="documento">
                      <b>{u.doc_id}</b>
                    </td>
                    <td data-rot="usuário">{u.tenant}</td>
                    <td data-rot="gaveta" className="mono">
                      {u.memoria || "padrão"}
                    </td>
                    <td data-rot="tipo">
                      <span className="chip">{(u.ext || u.tipo || "?").toUpperCase()}</span>{" "}
                      {u.ocr && <span className="chip chip-azul">OCR</span>}
                    </td>
                    <td data-rot="quando">{fmtData(u.quando)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}