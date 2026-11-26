import { useCallback, useState } from "react";
import { ApiErro, definirChave, get } from "../services/api";
import type { GavetasResp } from "../types";

const TTL_MS = 12 * 3600 * 1000; // sessão expira em 12h

export type Sessao = {
  nome: string;
  chave: string;
  operador: boolean;
  tenant: string;
  memoria: string;
};

const vazia: Sessao = { nome: "", chave: "", operador: false, tenant: "", memoria: "" };

function lerStorage(): Sessao {
  const chave = sessionStorage.getItem("mr_key") || "";
  const nome = sessionStorage.getItem("mr_nome") || "";
  const ts = Number(sessionStorage.getItem("mr_ts") || 0);
  if (!chave || !nome || Date.now() - ts >= TTL_MS) return vazia;
  definirChave(chave);
  return {
    nome,
    chave,
    operador: sessionStorage.getItem("mr_op") === "1",
    tenant: sessionStorage.getItem("mr_tenant") || nome,
    memoria: sessionStorage.getItem("mr_mem") || "",
  };
}

export function useSessao() {
  const [sessao, setSessao] = useState<Sessao>(vazia);
  const [restaurando, setRestaurando] = useState(() => !!sessionStorage.getItem("mr_key"));
  const [erro, setErro] = useState("");

  const guardar = useCallback((s: Sessao) => {
    definirChave(s.chave);
    sessionStorage.setItem("mr_nome", s.nome);
    sessionStorage.setItem("mr_key", s.chave);
    sessionStorage.setItem("mr_op", s.operador ? "1" : "0");
    sessionStorage.setItem("mr_tenant", s.tenant);
    sessionStorage.setItem("mr_mem", s.memoria);
    sessionStorage.setItem("mr_ts", String(Date.now()));
    setSessao(s);
  }, []);

  const entrar = useCallback(
    /** v3.78: entra SÓ com a chave — quem eu sou vem do servidor (`/gavetas` devolve `nome`). */
    async (chave: string): Promise<void> => {
      if (!chave) {
        setErro("informe a chave de acesso");
        return;
      }
      definirChave(chave);
      try {
        const g = await get<GavetasResp>("/gavetas");
        setErro("");
        const nome = g.nome || "";
        guardar({ nome, chave, operador: !!g.operador, tenant: nome, memoria: "" });
      } catch (e) {
        setErro((e as Error).message);
        throw e;
      }
    },
    [guardar],
  );

  const restaurar = useCallback(async (): Promise<void> => {
    const s = lerStorage();
    if (!s.chave) {
      setRestaurando(false);
      setErro(sessionStorage.getItem("mr_key") ? "sessão passou de 12h — entre de novo" : "");
      sessionStorage.clear();
      return;
    }
    try {
      const g = await get<GavetasResp>("/gavetas");
      /* v3.78: o nome verdadeiro vem do servidor; o tenant já escolhido na aba (operador
         navegando numa conta) continua valendo. */
      const nome = g.nome || s.nome;
      setSessao({ ...s, nome, operador: !!g.operador, tenant: s.tenant || nome });
      setRestaurando(false);
    } catch {
      sessionStorage.clear();
      definirChave("");
      setSessao(vazia);
      setErro("sessão expirada ou chave inválida");
      setRestaurando(false);
    }
  }, []);

  const sair = useCallback((msg = "") => {
    sessionStorage.clear();
    definirChave("");
    setSessao(vazia);
    setErro(msg);
  }, []);

  /** v2.7: quando o painel gera chave nova, a sessão passa a usar a nova. */
  const trocarChave = useCallback((nova: string) => {
    definirChave(nova);
    sessionStorage.setItem("mr_key", nova);
    sessionStorage.setItem("mr_ts", String(Date.now()));
    setSessao((s) => ({ ...s, chave: nova }));
  }, []);

  const escopo = useCallback(
    (tenant: string, memoria: string) => {
      setSessao((s) => {
        const nova = { ...s, tenant, memoria };
        sessionStorage.setItem("mr_tenant", nova.tenant);
        sessionStorage.setItem("mr_mem", nova.memoria);
        return nova;
      });
    },
    [],
  );

  return { sessao, logado: !!sessao.chave, restaurando, erro, setErro, entrar, sair, escopo, restaurar, trocarChave } as const;
}

export type SessaoApi = ReturnType<typeof useSessao>;
export { ApiErro };