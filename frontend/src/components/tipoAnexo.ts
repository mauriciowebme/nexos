/** v3.49 — o quadradinho colorido por tipo de arquivo (era local do Arquivos; v3.85 o
 *  explorador usa o mesmo desenho, então a função saiu para um arquivo só). */
export function tipoDoAnexo(mime: string): { rotulo: string; cor: string; d: string } {
  const m = (mime || "").toLowerCase();
  if (m.includes("pdf"))
    return { rotulo: "PDF", cor: "#f85149", d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5" };
  if (m.startsWith("image/"))
    return {
      rotulo: "Imagem",
      cor: "#6cb6ff",
      d: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zM8.5 9.5a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4zM4 17l5-4 4 3 3-2 4 3",
    };
  if (m.includes("sheet") || m.includes("excel") || m.includes("csv"))
    return { rotulo: "Planilha", cor: "#3fb950", d: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zM3 10h18M9 3v18M15 3v18" };
  if (m.startsWith("audio/") || m.includes("video/"))
    return { rotulo: "Mídia", cor: "#a371f7", d: "M9 18V6l10-2v12M6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM16.5 18.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" };
  if (m.includes("xml") || m.includes("json"))
    return { rotulo: "Dados", cor: "#d29922", d: "M8 7l-4 5 4 5M16 7l4 5-4 5" };
  if (m.includes("zip") || m.includes("compress") || m.includes("tar"))
    return { rotulo: "Pacote", cor: "#89dceb", d: "M4 7l8-4 8 4v10l-8 4-8-4V7zM12 3v18M4 7l8 4 8-4" };
  return { rotulo: "Arquivo", cor: "#7d8899", d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" };
}
