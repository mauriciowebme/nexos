import { useState, type FormEvent } from "react";
import type { SessaoApi } from "../hooks/useSessao";

export function Login({ sessao }: { sessao: SessaoApi }) {
  const [chave, setChave] = useState("");
  const [ver, setVer] = useState(false);
  const [indo, setIndo] = useState(false);

  async function enviar(ev: FormEvent) {
    ev.preventDefault();
    setIndo(true);
    try {
      await sessao.entrar(chave.trim());
    } catch {
      /* a mensagem já está em sessao.erro */
    } finally {
      setIndo(false);
    }
  }

  return (
    <form id="formLogin" className="cartao mx-auto mt-[8vh] w-full max-w-[420px]" autoComplete="on" onSubmit={enviar}>
      <div className="mb-2 text-[13px] font-semibold text-verde">◆ Nexos</div>
      <h1 className="mb-2">Entrar</h1>
      <p className="dica">
        A chave identifica a conta. Chave de tenant vê só as gavetas dela; chave <b>operador</b> vê todas.
      </p>

      <label className="rotulo">
        Chave de acesso
        <span className="relative mt-[5px] block">
          <input
            id="loginKey"
            className="campo pr-[64px]"
            type={ver ? "text" : "password"}
            autoComplete="current-password"
            placeholder="a chave do serviço"
            autoFocus
            value={chave}
            onChange={(e) => setChave(e.target.value)}
          />
          <button
            type="button"
            id="btnOlho"
            className="btn btn-sutil absolute right-1 top-1/2 h-7 -translate-y-1/2"
            title={ver ? "ocultar segredo" : "mostrar segredo"}
            aria-label={ver ? "ocultar segredo" : "mostrar segredo"}
            onClick={() => setVer((v) => !v)}
          >
            {ver ? "ocultar" : "ver"}
          </button>
        </span>
      </label>

      <p id="loginErro" role="alert" className="mb-3 min-h-[18px] text-[13px] text-vermelho">
        {sessao.erro}
      </p>

      <button type="submit" id="btnEntrar" className="btn btn-primario w-full" disabled={indo}>
        {indo ? "entrando…" : "Entrar"}
      </button>

      <p className="mt-3 text-[12px] text-txt3">
        A sessão vive só nesta aba, por 12 horas. Chave errada repetida demais é bloqueada pelo servidor.
      </p>
    </form>
  );
}