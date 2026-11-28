/**
 * Bateria da tela Arquivos (v3.85) — pastas, lixeira de 30 dias, upload em chunks,
 * renomear/mover/favoritar, copia, zip, isolamento entre contas e expurgo da faxina.
 *
 *   set -a; . /opt/data/cache/scratch/nexos_test_keys.env; set +a
 *   node --experimental-strip-types testes/env-local/anexos-bateria.mts
 *
 * Regras da casa (skill `suite-de-testes`):
 *  - so contra o ambiente de TESTES (BASE vem do up-test.sh, porta 8002, rede propria);
 *  - o que vale e a API + o banco + o disco, nunca a mensagem na tela;
 *  - sondas com chave RUIM vao por ultimo: elas armam o freio de forca bruta por IP
 *    (10 falhas em 300s) e depois tudo na mesma IP volta 429 — o que ja queimou rodada.
 */

import crypto from "node:crypto";
import { execSync } from "node:child_process";

const BASE = (process.env.BASE ?? "http://172.28.0.1:8002").replace(/\/$/, "");
const K = process.env.TESTKEY;
const OP = process.env.OPKEY;
const SQL = (tenant: string) => `docker exec nexostest-nexos-db-1 psql -U nexostest -d nexostest -Atc`;

if (!K || !OP) {
  console.log("FALHOU: precisa de TESTKEY e OPKEY no ambiente (scripts/up-test.sh gera o arquivo)");
  process.exit(2);
}

/* ------------------------------------------------------------- utilitarios */

type Res = { st: number; j: any; t: string };

async function umaVez(u: string, o: RequestInit = {}, chave: string): Promise<Res> {
  const r = await fetch(BASE + u, { ...o, headers: { ...(o.headers ?? {}), ...(chave ? { Authorization: `Bearer ${chave}` } : {}) } });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { /* binario ou nao-json */ }
  return { st: r.status, j, t };
}

/** espera o freio de forca bruta passar e tenta uma vez so — sem isso a bateria
 * marca falso negativo quando o IP esta bloqueado por sondas anteriores. */
async function ch(u: string, o: RequestInit = {}, chave: string = K!): Promise<Res> {
  let s = await umaVez(u, o, chave);
  if (s.st === 429 && typeof s.j?.detail === "string") {
    const seg = Number(s.j.detail.match(/em (\d+)s/)?.[1] ?? 8);
    console.log(`   .. freio armado no IP: aguardando ${seg + 2}s`);
    await new Promise((r) => setTimeout(r, (seg + 2) * 1000));
    s = await umaVez(u, o, chave);
  }
  return s;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const patchJson = (body: unknown): RequestInit => ({ ...json(body), method: "PATCH" });

/** multipart de UM arquivo (o campo tem de chamar "arquivo") */
function multipart(nome: string, dados: Buffer, mime = "application/octet-stream"): RequestInit {
  const fd = new FormData();
  fd.append("arquivo", new Blob([new Uint8Array(dados)], { type: mime }), nome);
  return { method: "POST", body: fd };
}

/** sobe um arquivo pelo canal real da tela (blocos; aqui num bloco so) e devolve o id */
let seq = 0;
async function subir(nome: string, dados: Buffer, mime = "application/octet-stream", chave: string = K!): Promise<{ st: number; id: string; j: any }> {
  const id = "prova" + Date.now().toString(36) + (seq++).toString(36).padStart(4, "0") + "0";
  const r = await ch(`/anexos/enviar?id=${id}&offset=0&total=${dados.length}&nome=${encodeURIComponent(nome)}&mime=${encodeURIComponent(mime)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: dados,
  }, chave);
  return { st: r.st, id, j: r.j };
}

let falhas = 0;
function ok(cond: boolean, titulo: string, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} | ${titulo}${extra ? " | " + extra : ""}`);
  if (!cond) falhas++;
}
const blake3 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);

/** upload em blocos (o canal da maquina, mesmo que a tela usa para arquivo grande) */
async function enviarEmBlocos(id: string, dados: Buffer, pedaco: number, nome = "grande.bin"): Promise<Res> {
  let off = 0;
  let ultimo: Res = { st: 0, j: null, t: "" };
  while (off < dados.length) {
    const fatia = dados.subarray(off, off + pedaco);
    ultimo = await ch(`/anexos/enviar?id=${id}&offset=${off}&total=${dados.length}&nome=${encodeURIComponent(nome)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: fatia,
    });
    if (ultimo.st >= 400) return ultimo;
    off += fatia.length;
  }
  return ultimo;
}

/* ---------------------------------------------------------------- começa */

console.log(`bateria anexos | BASE=${BASE}`);

const RODADA = Date.now().toString(36).slice(-5);
const NOME_PASTA = `Prova Bateria ${RODADA}`;

/* 1 — pastas: criar, duplicata, nome invalido, subpasta, renomear */
const p1 = await ch("/pastas", json({ nome: NOME_PASTA, pai_id: 0 }));
const pasta = p1.j?.id;
ok(p1.st === 201 && typeof pasta === "number", "1. cria pasta raiz", `st=${p1.st} id=${pasta}`);

const pDup = await ch("/pastas", json({ nome: NOME_PASTA, pai_id: 0 }));
ok(pDup.st === 409, "2. duplicata na mesma pasta e recusada", `st=${pDup.st}`);

const pRuim = await ch("/pastas", json({ nome: "   " }));
ok(pRuim.st === 422, "3. nome de pasta vazio devolve 422", `st=${pRuim.st}`);

const sub = await ch("/pastas", json({ nome: "Sub da Prova", pai_id: pasta }));
ok(sub.st === 201 && sub.j?.pai_id === pasta, "4. subpasta nasce com o pai certo", `id=${sub.j?.id}`);

const pRen = await ch(`/pastas/${sub.j?.id}`, patchJson({ nome: "Sub Renomeada" }));
ok(pRen.st === 200 && pRen.j?.nome === "Sub Renomeada", "5. renomear pasta", `st=${pRen.st}`);

/* 2 — upload simples + upload em blocos com retomada */
const pequeno = Buffer.from("linha um\nlinha dois\n".repeat(40), "utf8");
const up1 = await subir("pequeno.txt", pequeno, "text/plain");
const idPeq = up1.j?.completo ? up1.id : undefined;
ok(up1.st === 201 && !!idPeq, "6. arquivo entra pelo canal de blocos (1 bloco)", `st=${up1.st} id=${String(idPeq).slice(0, 8)}`);

const pedaco = Buffer.alloc(1024 * 1024, 7);
const grande = Buffer.concat([pedaco, Buffer.alloc(512 * 1024, 9)]);
const gid = "prova" + Date.now().toString(36) + "blocos01";
const st1 = await ch(`/anexos/enviar?id=${gid}&offset=0&total=${grande.length}&nome=grande.bin`, {
  method: "POST", headers: { "content-type": "application/octet-stream" }, body: pedaco,
});
const status = await ch(`/anexos/enviar/status?id=${gid}`);
ok(st1.st === 201 && status.j?.bytes === pedaco.length && status.j.completo === false,
   "7. upload em blocos guarda o parcial", `bytes=${status.j?.bytes}/${grande.length}`);

const st2 = await ch(`/anexos/enviar?id=${gid}&offset=${pedaco.length}&total=${grande.length}&nome=grande.bin`, {
  method: "POST", headers: { "content-type": "application/octet-stream" }, body: grande.subarray(pedaco.length),
});
ok(st2.st === 201 && st2.j?.completo === true, "8. upload em blocos fecha", `bytes=${st2.j?.bytes}`);

const listaAposBlocos = await ch(`/arquivos?limit=200`);
const idGrande = (listaAposBlocos.j?.arquivos ?? []).find((x: any) => x.id === gid)?.id;
ok(!!idGrande, "9. arquivo por blocos aparece na lista como anexo completo");

/* 3 — teto de tamanho: o corpo maior que o limite morre em 413 (nao em 500) */
const teto = await ch(`/arquivos?pasta=${pasta}`, multipart("enorme.bin", Buffer.alloc(16 * 1024 * 1024, 1)));
ok(teto.st === 413 || teto.st === 422, "10. corpo maior que o teto do conversor e recusado", `st=${teto.st} ${String(teto.j?.detail ?? "").slice(0, 46)}`);
const tetoBlocos = await ch(`/anexos/enviar?id=provatetoblocos01&offset=0&total=${11 * 1024 * 1024 * 1024}&nome=impossivel.bin`, {
  method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(64, 1) });
ok(tetoBlocos.st === 422, "10b. total maior que o teto do anexo e recusado na abertura", `st=${tetoBlocos.st} ${String(tetoBlocos.j?.detail ?? "").slice(0, 46)}`);

/* 4 — mover, favoritar, renomear e o hash que nao muda */
const mv = await ch(`/arquivos/${idPeq}`, patchJson({ pasta_id: sub.j?.id }));
const naSub = await ch(`/arquivos?pasta=${sub.j?.id}`);
ok(mv.st === 200 && (naSub.j?.arquivos ?? []).some((x: any) => x.id === idPeq), "11. mover para outra pasta", `st=${mv.st}`);

const fav = await ch(`/arquivos/${idPeq}`, patchJson({ favorita: true }));
const soFav = await ch(`/arquivos?favoritos=1`);
ok(fav.st === 200 && (soFav.j?.arquivos ?? []).some((x: any) => x.id === idPeq && x.favorita), "12. favoritar aparece na vista favoritos");

const antes = await ch(`/anexos/${idPeq}`);
const bytesAntes = Buffer.from(await (await fetch(BASE + `/anexos/${idPeq}`, { headers: { Authorization: `Bearer ${K}` } })).arrayBuffer());
const rn = await ch(`/arquivos/${idPeq}`, patchJson({ nome: "renomeado.txt" }));
const depois = await ch(`/anexos/${idPeq}`);
const bytesDepois = Buffer.from(await (await fetch(BASE + `/anexos/${idPeq}`, { headers: { Authorization: `Bearer ${K}` } })).arrayBuffer());
ok(rn.st === 200 && rn.j?.nome === "renomeado.txt" && blake3(bytesAntes) === blake3(bytesDepois) && bytesAntes.length === pequeno.length,
   "13. renomear mantem os bytes (mesmo hash)", `${blake3(bytesAntes)} -> ${blake3(bytesDepois)} | st=${rn.st} ${antes.st}/${depois.st}`);

/* 5 — copia: nome novo e bytes identicos */
const cp = await ch("/arquivos/copiar", json({ ids: [idPeq], pasta: pasta }));
const idCop = cp.j?.copiados?.[0];
const copia = await ch(`/anexos/${idCop}`);
const bytesCop = Buffer.from(await (await fetch(BASE + `/anexos/${idCop}`, { headers: { Authorization: `Bearer ${K}` } })).arrayBuffer());
ok(cp.st === 200 && !!idCop && idCop !== idPeq && bytesCop.equals(bytesAntes), "14. copiar para pasta gera id novo com os mesmos bytes", `st=${cp.st}`);
const listaAposCopia = await ch(`/arquivos?pasta=${pasta}&limit=200`);
const fichaCop = (listaAposCopia.j?.arquivos ?? []).find((x: any) => x.id === idCop);
const bytesBaix = Buffer.from(await (await fetch(BASE + `/anexos/${idCop}`, { headers: { Authorization: `Bearer ${K}` } })).arrayBuffer());
ok(!!fichaCop && bytesBaix.equals(bytesAntes), "15. copia fica listavel e baixavel", `nome=${fichaCop?.nome} bytes=${bytesBaix.length}`);

/* 6 — lixeira: excluir some da vista, aparece na lixeira, conta em usados */
const ex = await ch("/arquivos/excluir", json({ ids: [idCop] }));
const lix = await ch(`/arquivos?lixeira=1`);
const norm = await ch(`/arquivos?limit=200`);
const usados = await ch("/arquivos/usados");
ok(ex.st === 200 && ex.j?.lixeira === true, "16. excluir manda para a lixeira", `st=${ex.st}`);
ok((lix.j?.arquivos ?? []).some((x: any) => x.id === idCop) && !(norm.j?.arquivos ?? []).some((x: any) => x.id === idCop),
   "17. lixeira mostra o excluido e a lista normal esconde");
ok(usados.st === 200 && usados.j?.lixeira_itens >= 1, "18. usados conta os itens da lixeira", `lixeira_itens=${usados.j?.lixeira_itens}`);

/* 7 — restaurar, inclusive quando a pasta de destino sumiu */
const rs = await ch("/arquivos/restaurar", json({ ids: [idCop] }));
const norm2 = await ch(`/arquivos?limit=200`);
ok(rs.st === 200 && (norm2.j?.arquivos ?? []).some((x: any) => x.id === idCop), "19. restaurar devolve o arquivo", `para_raiz=${rs.j?.para_raiz}`);

/* pasta com arquivo dentro vai para a lixeira junto e volta junto */
const upNaSub = await subir("filho.txt", Buffer.from("filho\n", "utf8"), "text/plain");
const idFilho = upNaSub.id;
await ch(`/arquivos/${idFilho}`, patchJson({ pasta_id: sub.j?.id }));
const delPasta = await ch(`/pastas/${sub.j?.id}`, { method: "DELETE" });
ok(delPasta.st === 200 && delPasta.j?.arquivos >= 1, "20. excluir pasta leva os arquivos junto", `arquivos=${delPasta.j?.arquivos}`);
const pastasLix = await ch("/pastas?lixeira=1");
ok((pastasLix.j?.pastas ?? []).some((x: any) => x.id === sub.j?.id), "21. pasta excluida aparece na lixeira de pastas");
const backPasta = await ch(`/pastas/${sub.j?.id}/restaurar`, json({}));
ok(backPasta.st === 200 && (backPasta.j?.arquivos ?? 0) >= 1, "22. restaurar pasta traz os arquivos de volta", `arquivos=${backPasta.j?.arquivos}`);

/* 8 — copia para pasta apagada: o arquivo sobrevive na raiz com aviso */
const delSubDeNovo = await ch(`/pastas/${sub.j?.id}`, { method: "DELETE" });
const exFilho = await ch("/arquivos/excluir", json({ ids: [idFilho] }));
await ch(`/pastas/${sub.j?.id}`, { method: "DELETE" });
const restaOrfa = await ch("/arquivos/restaurar", json({ ids: [idFilho] }));
ok(restaOrfa.st === 200 && restaOrfa.j?.para_raiz >= 1 && !!restaOrfa.j?.aviso,
   "23. restaurar com a pasta morta cai na raiz com aviso", `para_raiz=${restaOrfa.j?.para_raiz} aviso=${String(restaOrfa.j?.aviso ?? "").slice(0, 40)} st-del=${delSubDeNovo.st}/${exFilho.st}`);

/* 9 — esvaziar lixeira apaga de verdade (linha e disco) */
const exPeq = await ch("/arquivos/excluir", json({ ids: [idPeq] }));
const esv = await ch("/arquivos/lixeira", { method: "DELETE" });
const baixEsv = await ch(`/anexos/${idPeq}`);
ok(exPeq.st === 200 && esv.st === 200 && esv.j?.arquivos >= 1 && baixEsv.st === 404,
   "24. esvaziar lixeira apaga linha e disco", `esv=${esv.st} ${esv.j?.arquivos} baix=${baixEsv.st}`);

/* 10 — expurgo por idade: 31 dias na lixeira morrem na faxina; 1 dia sobrevive */
const velho = await subir("velho.txt", Buffer.from("velho\n", "utf8"), "text/plain");
const novo = await subir("novo.txt", Buffer.from("novo\n", "utf8"), "text/plain");
await ch("/arquivos/excluir", json({ ids: [velho.id, novo.id] }));
execSync(`${SQL("")} "update anexos_maquina set excluido_em = now() - interval '31 days' where id = '${velho.id}'"`);
const decaiu = await ch("/decay", json({}), OP!);
const vVivo = await ch(`/anexos/${velho.id}`);
const nVivo = await ch(`/anexos/${novo.id}`);
ok(vVivo.st === 404 && nVivo.st === 200 && (decaiu.j?.expurgo?.lixeira_arquivos ?? 0) >= 1,
   "25. faxina expurga so o que passou de 30 dias", `expurgo=${JSON.stringify(decaiu.j?.expurgo)} velho=${vVivo.st} novo=${nVivo.st}`);

/* 11 — zip */
const zip = await ch(`/arquivos/zip?ids=${novo.id}`);
const zipBuf = Buffer.from(await (await fetch(BASE + `/arquivos/zip?ids=${novo.id}`, { headers: { Authorization: `Bearer ${K}` } })).arrayBuffer());
ok(zip.st === 200 && zipBuf.subarray(0, 2).toString("latin1") === "PK" && zipBuf.length > 100,
   "26. zip real sai com cabeca PK", `st=${zip.st} bytes=${zipBuf.length}`);

/* 12 — isolamento entre contas (usuario comum criado pelo sistema) */
const NOME_B = `prova-b-${RODADA}`;
let criaB = await ch("/usuarios", json({ nome: NOME_B, papel: "user" }), OP!);
if (criaB.st === 409) criaB = await ch(`/usuarios/${NOME_B}/chave`, json({}), OP!);
const chaveB = String(criaB.j?.chave ?? "");
ok(criaB.st < 300 && chaveB.length > 10, "27. conta B criada pelo sistema", `st=${criaB.st}`);
const listaB = await ch("/arquivos?limit=200", {}, chaveB);
ok((listaB.j?.arquivos ?? []).length === 0, "28. B nao ve nada do que A tem", `vistos=${(listaB.j?.arquivos ?? []).length}`);
const lerDeA = await ch(`/anexos/${novo.id}`, {}, chaveB);
ok(lerDeA.st === 404, "29. B nao consegue baixar o arquivo de A", `st=${lerDeA.st}`);
const mexerDeA = await ch(`/arquivos/${gid}`, patchJson({ nome: "sequestro.bin" }), chaveB);
const listaDeA = await ch("/arquivos?limit=500");
const fichaA = (listaDeA.j?.arquivos ?? []).find((x: any) => x.id === gid);
ok(mexerDeA.st >= 400 && !!fichaA && fichaA.nome === "grande.bin",
   "30. B nao renomeia arquivo de A", `st=${mexerDeA.st} nome=${fichaA?.nome}`);
const pastaB = await ch("/pastas", json({ nome: NOME_PASTA }), chaveB);
ok(pastaB.st === 201 && pastaB.j?.id !== pasta, "31. mesmo nome de pasta em outra conta e outro id", `id=${pastaB.j?.id} vs ${pasta}`);

/* 13 — operador ve a conta pedida com ?tenant e, sem filtro, ve so a propria conta */
const opVe = await ch("/arquivos?limit=500&tenant=teste", {}, OP!);
ok(opVe.st === 200 && (opVe.j?.arquivos ?? []).some((x: any) => x.id === gid),
   "32. operador enxerga a conta pedida com ?tenant", `itens=${(opVe.j?.arquivos ?? []).length}`);
const arquivoDoOperador = await subir("do-operador.txt", Buffer.from("operador\n", "utf8"), "text/plain", OP!);
await ch(`/arquivos/${arquivoDoOperador.id}`, patchJson({ nome: "do-operador.txt" }), OP!);
const opSemFiltro = await ch("/arquivos?limit=500", {}, OP!);
const idsDoOperador = (opSemFiltro.j?.arquivos ?? []).map((x: any) => x.id);
ok(idsDoOperador.includes(arquivoDoOperador.id) && !idsDoOperador.includes(gid),
   "33. sem ?tenant o operador ve so a propria conta (sem devassa)", `itens=${idsDoOperador.length}`);

/* 14 — sonda de nome/limpeza: o que a maquina manda nao aparece quebrado na tela */
const mal = await subir("../../escapada/../mal.ico", Buffer.from("x".repeat(64)), "image/x-icon");
const nomeMal = String(mal.j?.nome ?? "");
const listaMal = await ch("/arquivos?limit=300");
const vistoMal = (listaMal.j?.arquivos ?? []).find((x: any) => x.id === mal.id);
ok(mal.st === 201 && !!vistoMal && !String(vistoMal.nome).includes("..") && !String(vistoMal.nome).includes("/"),
   "34. nome malicioso e limpo na entrada", `nome=${vistoMal?.nome}`);

/* 15 — faxina de pedaço orfao: bloco comecado e nunca fechado nao vira anexo */
const abandonado = "prova" + Date.now().toString(36) + "abandon0";
await ch(`/anexos/enviar?id=${abandonado}&offset=0&total=999999&nome=abandonado.bin`, {
  method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(1024, 3),
});
const listaAband = await ch("/arquivos?limit=500");
const fichaAband = (listaAband.j?.arquivos ?? []).find((x: any) => x.id === abandonado);
const copAband = await ch("/arquivos/copiar", json({ ids: [abandonado], pasta: pasta }));
ok(!!fichaAband && fichaAband.completo === false && copAband.st === 422,
   "35. envio abandonado aparece marcado incompleto e nao pode ser copiado", `completo=${fichaAband?.completo} copiar=${copAband.st}`);

/* 16 — rejeicoes (por ultimo: arman o freio do IP) */
const semChave = await umaVez("/pastas", json({ nome: "ninguem" }), "");
ok(semChave.st === 401, "36. sem chave nao cria pasta", `st=${semChave.st}`);
const chaveRuim = await umaVez("/arquivos?limit=1", {}, "nx_" + "x".repeat(30));
ok(chaveRuim.st === 401, "37. chave inexistente e recusada", `st=${chaveRuim.st}`);
const corpoRuim = await ch("/arquivos/excluir", json({ ids: "nao-e-lista" }));
ok(corpoRuim.st >= 400 && corpoRuim.st < 500, "38. ids que nao sao lista morrem em 4xx", `st=${corpoRuim.st}`);
const zipVazio = await ch("/arquivos/zip?ids=");
ok(zipVazio.st >= 400 && zipVazio.st < 500, "39. zip sem ids nao arrebenta", `st=${zipVazio.st}`);

console.log(`\n${falhas === 0 ? "TUDO VERDE" : falhas + " FALHA(S)"} | bateria anexos v3.85 | BASE=${BASE}`);
process.exit(falhas === 0 ? 0 : 1);
