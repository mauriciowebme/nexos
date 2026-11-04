/**
 * Teste de unidade do resgate de chamada escrita em texto (v3.70).
 *
 * Usa o caso REAL que quebrou em 03/11/2026 23:27 (mensagem 796 do chat): o modelo
 * escreveu 13,8 mil caracteres de HTML dentro de `<tool_call><function=show_tela>` e
 * o painel nunca apareceu — o HTML foi para a conversa como texto.
 *
 * Fixture: tests/fixtures/tela-em-texto.txt (texto verbatim daquela mensagem).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { chamadasNoTexto, nomeReal, semBlocos, temBloco } = require("../dist/resgate.js");

const texto = readFileSync(join(process.cwd(), "tests", "fixtures", "tela-em-texto.txt"), "utf8");
const existe = (n: string) => n === "mostrar_tela";

test("reconhece o bloco da tela escrito no texto", () => {
  assert.equal(temBloco(texto), true);
  const achadas = chamadasNoTexto(texto);
  assert.equal(achadas.length, 1);
  assert.equal(achadas[0].nome, "show_tela");
  assert.equal(achadas[0].args.titulo, "USD/BRL · Bandas de Bollinger (PTAX real do Banco Central)");
  const html = String(achadas[0].args.html);
  assert.ok(html.startsWith("<!DOCTYPE html>"), "o html tem de vir inteiro");
  assert.ok(html.length > 10000, `html curto demais: ${html.length}`);
});

test("resolve o apelido para o nome real", () => {
  assert.equal(nomeReal("show_tela", existe), "mostrar_tela");
  assert.equal(nomeReal("mostrar_tela", existe), "mostrar_tela");
  assert.equal(nomeReal("show_tela", () => false), null, "sem a ferramenta, não resolve");
  assert.equal(nomeReal("inventada_xyz", existe), null);
  assert.equal(nomeReal("", existe), null);
});

test("sem o bloco sobra só a fala de caminho", () => {
  const limpo = semBlocos(texto);
  assert.ok(limpo.startsWith("Painel pronto com dados reais."), limpo.slice(0, 80));
  assert.equal(/<tool_call>|<\/parameter>|<function=/.test(limpo), false);
  assert.ok(limpo.length < 300, `sobrou coisa demais: ${limpo.length}`);
});

test("texto normal não é tocado", () => {
  const normal = "Segue o resumo: receita subiu 12% no mês.";
  assert.equal(temBloco(normal), false);
  assert.deepEqual(chamadasNoTexto(normal), []);
  assert.equal(semBlocos(normal), normal);
});

test("dois blocos no mesmo texto viram duas chamadas", () => {
  const dois = [
    "<tool_call><function=show_tela><parameter=titulo>A</parameter><parameter=html><div>a</div></parameter></function></tool_call>",
    "e agora o segundo:",
    "<tool_call><function=run_python><parameter=codigo>print(1)</parameter></function></tool_call>",
  ].join("\n");
  const achadas = chamadasNoTexto(dois);
  assert.equal(achadas.length, 2);
  assert.equal(nomeReal(achadas[0].nome, (n) => n === "mostrar_tela" || n === "rodar_python"), "mostrar_tela");
  assert.equal(nomeReal(achadas[1].nome, (n) => n === "rodar_python"), "rodar_python");
  assert.deepEqual(achadas[1].args, { codigo: "print(1)" });
});

test("bloco cortado no meio (resposta truncada) também sai da vista", () => {
  const cortado = "Vou montar a tela.\n\n<tool_call>\n<function=show_tela>\n<parameter=titulo>X</parameter>\n<parameter=html>\n<!DOCTYPE html>\n<div>sem fim";
  assert.equal(temBloco(cortado), true, "o começo do bloco é reconhecido");
  assert.deepEqual(chamadasNoTexto(cortado), [], "sem fechamento não há chamada executável");
  const limpo = semBlocos(cortado);
  assert.equal(limpo, "Vou montar a tela.");
  assert.equal(/DOCTYPE|<tool_call>/.test(limpo), false);
});
