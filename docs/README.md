# Mapa da documentação — Nexos

> **Última atualização:** 2026-11-04 · **Versão:** 3.72.0 · **Dono:** Mauricio

O que vai onde (lugares canônicos da casa — padrão `organizacao-documentacao`; a tabela da skill é a dona, este mapa só registra o estado do repo):

| Conteúdo | Lugar | Estado |
|---|---|---|
| Fila do que falta (T###) | `docs/proximos-passos.md` | ✅ existe (só o que está em aberto) |
| Prova de como se testa (contrato por rota) | `docs/testes.md` (dono do método: skill `suite-de-testes`) | ✅ existe |
| Planos de trabalho temporários | `docs/planos/NNN-assunto.md` | pasta só existe enquanto um plano está em execução; ao concluir, o plano sai do repo (histórico no `git log`) |
| Specs por módulo | `docs/specs/NN-modulo.md` | _nasce na primeira regra escrita_ (pasta sem primeiro doc não se cria) |
| Casos reais / análises / auditorias datadas | `docs/casos/`, `docs/analises/`, `docs/auditoria/` | ✅ `analises/` nasceu com a referência do DeepSeek Harness (04/11); casos e auditorias ainda não surgiram |
| Runbook de operação | `docs/runbook.md` | _quando houver operação manual repetida_ |
| Histórico do entregue | `git log` | ✅ desde 30/10 — o histórico de versões saiu do `README.md` (eram 86 seções); o repo é a fonte |
| Guia de uso / API | `README.md` da raiz + seção de exemplos | ✅ existe (raiz) |

## Índice do estado atual (medido 2026-11-04)

| Arquivo | Assunto | Linhas |
|---|---|---|
| `proximos-passos.md` | **só o aberto**: fila T### zerada na 3.73.0 (T054/T055 entregues; T052/T053 retiradas por enquanto) + ideias não numeradas | ~50 |
| `testes.md` | contrato da suíte do nexos (ponteiro para `suite-de-testes`) | 131 |
| `mcp.md` | os três papéis do nexos (agente, central de memória, servidor MCP) e o protocolo de `POST /mcp` | 181 |
| `analises/2026-11-04-referencia-deepseek-harness.md` | referência da casa para medidor de contexto, velocidade de escrita e compactação, lida no código do DeepSeek Harness | 112 |

Nada neste mapa autoriza execução: tarefas viram código com OK explícito do dono (25/10, regra gravada no roadmap).
