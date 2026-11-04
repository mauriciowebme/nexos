/**
 * v3.70 — resgate de chamada de ferramenta escrita como TEXTO.
 *
 * O modelo, às vezes, não usa o campo `tool_calls` e escreve a chamada no próprio texto,
 * no formato do template:
 *
 *   <tool_call>
 *   <function=show_tela>
 *   <parameter=titulo>...</parameter>
 *   <parameter=html>...</parameter>
 *   </function>
 *   </tool_call>
 *
 * Como o nome pode não existir (caso real de 03/11/2026: `show_tela` em vez de
 * `mostrar_tela`), o provedor devolve tudo como CONTEÚDO e o HTML de 14 mil caracteres
 * ia parar na conversa em vez de virar card. Este módulo lê o bloco, resolve o nome e
 * devolve os argumentos prontos para executar.
 *
 * Só é usado quando a rodada NÃO trouxe chamada estruturada — o caminho normal não muda.
 */

export type ChamadaNoTexto = { nome: string; args: Record<string, unknown> };

/** Apelidos que o modelo inventa (tradução do nome em português) → nome real. */
export const APELIDOS: Record<string, string> = {
  show_tela: "mostrar_tela",
  show_screen: "mostrar_tela",
  show_panel: "mostrar_tela",
  display_screen: "mostrar_tela",
  render_screen: "mostrar_tela",
  run_python: "rodar_python",
  run_command: "rodar_comando",
  search_memory: "search",
};

/** Há um bloco de chamada no texto? (barato: só testa, não parseia) */
export function temBloco(texto: string): boolean {
  return /<tool_call>/i.test(texto) && /<function=/i.test(texto);
}

/** Lê todos os blocos de chamada do texto. Bloco sem `<function=...>` é ignorado. */
export function chamadasNoTexto(texto: string): ChamadaNoTexto[] {
  const achadas: ChamadaNoTexto[] = [];
  const bloco = /<tool_call>\s*<function=([\w.\-:]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/gi;
  for (const m of texto.matchAll(bloco)) {
    const args: Record<string, unknown> = {};
    const parametro = /<parameter=([\w.\-:]+)>([\s\S]*?)<\/parameter>/gi;
    for (const p of m[2].matchAll(parametro)) args[p[1].trim()] = p[2].trim();
    achadas.push({ nome: m[1].trim(), args });
  }
  return achadas;
}

/** Nome real da ferramenta: o próprio nome, se existir, ou o apelido conhecido. */
export function nomeReal(nome: string, existe: (n: string) => boolean): string | null {
  const limpo = String(nome ?? "").trim();
  if (!limpo) return null;
  if (existe(limpo)) return limpo;
  const apelido = APELIDOS[limpo.toLowerCase()];
  if (apelido && existe(apelido)) return apelido;
  return null;
}

/** Tira os blocos do texto e devolve só o que era fala de verdade.
 *  Bloco ABERTO e não fechado (resposta cortada no meio) também sai: o resto do texto a
 *  partir de `<tool_call>` é chamada, não fala — melhor perder a cauda do que despejar
 *  HTML na conversa. */
export function semBlocos(texto: string): string {
  const limpo = String(texto ?? "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const aberto = limpo.search(/<tool_call>/i);
  if (aberto >= 0) return limpo.slice(0, aberto).replace(/\n{3,}/g, "\n\n").trim();
  return limpo;
}
