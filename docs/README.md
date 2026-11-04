# Mapa da documentação — Nexos

> **Última atualização:** 2026-11-04 · **Versão:** 3.72.0 · **Dono:** Mauricio

O que vai onde (lugares canônicos da casa — padrão `organizacao-documentacao`; a tabela da skill é a dona, este mapa só registra o estado do repo):

| Conteúdo | Lugar | Estado |
|---|---|---|
| Fila do que falta (T###) | `docs/proximos-passos.md` | ✅ existe (só o que está em aberto) |
| Prova de como se testa (contrato por rota) | `docs/testes.md` (dono do método: skill `suite-de-testes`) | ✅ existe |
| Planos de trabalho temporários | `docs/planos/NNN-assunto.md` | pasta só existe enquanto um plano está em execução; ao concluir, o plano sai do repo (histórico no `git log`) |
| Specs por módulo | `docs/specs/NN-modulo.md` | _nasce na primeira regra escrita_ (pasta sem primeiro doc não se cria) |
| Casos reais / análises / auditorias datadas | `docs/casos/`, `docs/analises/`, `docs/auditoria/` | _quando surgirem_ |
| Runbook de operação | `docs/runbook.md` | _quando houver operação manual repetida_ |
| Histórico do entregue | `git log` | ✅ desde 30/10 — o histórico de versões saiu do `README.md` (eram 86 seções); o repo é a fonte |
| Guia de uso / API | `README.md` da raiz + seção de exemplos | ✅ existe (raiz) |

## Índice do estado atual (medido 2026-10-30)

| Arquivo | Assunto | Linhas |
|---|---|---|
| `proximos-passos.md` | **só o aberto**: nenhuma tarefa numerada na fila (T052/T053 retiradas por enquanto, a pedido do dono) + ideias não numeradas | ~52 |
| `testes.md` | contrato da suíte do nexos (ponteiro para `suite-de-testes`) | 105 |

Nada neste mapa autoriza execução: tarefas viram código com OK explícito do dono (25/10, regra gravada no roadmap).
