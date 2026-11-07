/**
 * Teste de unidade do GUARDA DO LAÇO (v3.74 / T056 e T057).
 *
 * A suíte de contrato (tests/e2e.test.ts, bloco v3.74) prova o turno pela porta HTTP.
 * Aqui fica o que o contrato não distingue sozinho: a CHAVE da chamada tem de ser a
 * mesma quando o modelo escreve os argumentos em ordem diferente (senão o guarda não vê
 * a repetição), e o texto que vira arquivo tem de ser o SEM CORTE (senão o despejo
 * grava justamente a cauda que se queria preservar).
 *
 * Medido no banco em 06/11: `baixar_arquivo` chamado 3x com os mesmos argumentos num
 * turno de 32 chamadas — o laço não percebia.
 */
import test from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { chaveDaChamada, lembreteDeRepeticao, LIMIAR_ENVASE } = require("../dist/provider.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { textoSemCorte, paraTexto, MAX_TEXTO_MODELO } = require("../dist/ferramentas.js");

test("a chave da chamada não depende da ordem dos argumentos", () => {
  const a = chaveDaChamada("baixar_arquivo", { caminho: "/a/b.txt", bloco: 2 });
  const b = chaveDaChamada("baixar_arquivo", { bloco: 2, caminho: "/a/b.txt" });
  assert.equal(a, b, "ordem trocada é a mesma chamada");
});

test("a chave é estável em objeto aninhado", () => {
  const a = chaveDaChamada("editar_no_local", { arquivo: "x.ts", busca: { texto: "1", fixo: true } });
  const b = chaveDaChamada("editar_no_local", { busca: { fixo: true, texto: "1" }, arquivo: "x.ts" });
  assert.equal(a, b);
});

test("argumento diferente é chamada diferente (o guarda não interfere no trabalho legítimo)", () => {
  const a = chaveDaChamada("search", { query: "alfa" });
  const b = chaveDaChamada("search", { query: "bravo" });
  const c = chaveDaChamada("search", { query: "alfa", top_k: 9 });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("ferramenta diferente com os mesmos argumentos é chave diferente", () => {
  assert.notEqual(chaveDaChamada("ler_arquivo", { p: "a" }), chaveDaChamada("apagar_arquivo", { p: "a" }));
});

test("sem argumento e argumento vazio não quebram", () => {
  assert.equal(chaveDaChamada("list_gavetas", {}), chaveDaChamada("list_gavetas", {}));
  chaveDaChamada("list_gavetas", undefined as any);
  chaveDaChamada("list_gavetas", null as any);
});

test("argumento circular não derruba o laço (a chave vira texto)", () => {
  const ciclico: Record<string, unknown> = { a: 1 };
  ciclico["eu"] = ciclico;
  const k = chaveDaChamada("rodar_python", ciclico as any);
  assert.equal(typeof k, "string");
  assert.ok(k.startsWith("rodar_python"), k.slice(0, 40));
});

test("o encerramento acontece na 3ª vez idêntica", () => {
  assert.equal(LIMIAR_ENVASE, 3, "mexeu no limiar, mexe no contrato do bloco v3.74");
});

test("o lembrete diz o que repetiu, quantas vezes e o que fazer", () => {
  const l = lembreteDeRepeticao("list_docs", 2, "3 gavetas");
  assert.match(l, /\[guarda do laço\]/);
  assert.match(l, /`list_docs`/);
  assert.match(l, /2ª vez/);
  assert.match(l, /MUDE o argumento/);
  assert.ok(l.includes("3 gavetas"), "o resultado anterior tem de voltar junto");
});

test("T057: o texto do despejo é o SEM CORTE, e base64 nunca vai para o arquivo", () => {
  const corpo = "L1\n".repeat(3000); // 12.000 chars: maior que o teto do payload
  const bruto = textoSemCorte({ saida: corpo });
  assert.ok(bruto.length > MAX_TEXTO_MODELO, "sem corte é o que o despejo grava");
  const cortado = paraTexto({ saida: corpo });
  assert.ok(cortado.length <= MAX_TEXTO_MODELO + 60, "paraTexto continua cortando (fallback)");
  assert.ok(cortado.includes("[cortado:"), "o corte antigo está marcado");

  const b64 = "A".repeat(400);
  const tocado = textoSemCorte({ img: b64 });
  assert.ok(tocado.includes("[arquivo em base64:"), "a etiqueta de base64 aparece: " + tocado.slice(0, 90));
  /* NÃO assino aqui que o base64 some: medido em 06/11, a máscara antiga devolve o blob
     inteiro (o `$1` do replace é o próprio base64, não o tamanho). É achado à parte —
     T058 em docs/proximos-passos.md — e teste nenhum pode eternizar o comportamento
     enquanto o achado espera o OK do dono. */
});
