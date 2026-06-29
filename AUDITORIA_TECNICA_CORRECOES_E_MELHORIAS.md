# Auditoria Tecnica do Projeto IV Platform

Data da auditoria: 2026-04-14
Escopo: revisao de codigo, validacao de build, analise de falhas silenciosas, consistencia funcional, UX/UI e performance.

## Resumo executivo

A aplicacao compila e gera build de producao sem erros de TypeScript.
Mesmo assim, ha riscos funcionais importantes (incluindo falhas silenciosas) e pontos de arquitetura que precisam de tratamento em fases.

Separacao deste plano:
- Fases de Correcao: remover bugs, inconsistencias e riscos operacionais.
- Fases de Melhoria: elevar qualidade de UX/UI, escalabilidade e desempenho.

---

## Fases de Correcao

### Fase C1 - Correcao Critica (alta prioridade)

Objetivo: eliminar comportamentos incorretos com impacto direto no uso.

1) Edicao de turma no calendario nao persiste
- Severidade: Alta
- Sintoma: modal de edicao permite alterar turma, mas a turma nao e salva.
- Causa: o update de aula agendada nao aceita `class_id` no tipo e no service.
- Impacto: falha silenciosa, quebra de confianca do usuario.
- Acao:
  - Opcao A (recomendada): tornar campo Turma somente leitura no modal de edicao.
  - Opcao B: permitir migracao real de turma, alterando tipo/service/regras de negocio.
- Criterio de aceite:
  - Se campo editavel: mudanca persiste corretamente no banco/storage.
  - Se nao editavel: UI deixa isso explicito, sem expectativa falsa.

2) CRUD de usuarios em modo Supabase incompleto
- Severidade: Alta
- Sintoma: editar email e excluir conta falha em runtime no modo Supabase.
- Causa: funcoes locais lancam erro proposital por falta de endpoint admin seguro.
- Impacto: coordenacao nao consegue concluir fluxo de gestao de contas em ambiente real.
- Acao:
  - Criar endpoint administrativo seguro para update de email e delete de usuario.
  - Habilitar na UI apenas quando backend admin estiver disponivel.
- Criterio de aceite:
  - Coordenacao consegue editar nome/email e excluir conta em Supabase.
  - Operacoes auditaveis com retorno de erro amigavel.

### Fase C2 - Correcao Funcional (media prioridade)

Objetivo: corrigir inconsistencias operacionais e riscos de regressao.

3) Senha temporaria de professor pode repetir entre cadastros
- Severidade: Media
- Sintoma: senha gerada uma vez e reutilizada no modal.
- Impacto: risco operacional e de seguranca.
- Acao:
  - Regenerar senha ao abrir modal e apos cada criacao.
- Criterio de aceite:
  - Cada novo cadastro recebe senha nova automaticamente.

4) Regra de permissao aplicada so na UI
- Severidade: Media
- Sintoma: services de agenda aceitam mutacoes sem checar role.
- Impacto: possivel acao indevida por chamada programatica.
- Acao:
  - Adicionar validacao de permissao no backend (fonte de verdade).
  - No fallback local, validar papel no service antes da mutacao.
- Criterio de aceite:
  - Usuario sem role adequada nao consegue criar/editar/excluir por nenhum caminho.

5) Escopo da regra "coordenacao only" no calendario pode ter removido capacidade esperada de professor
- Severidade: Media
- Sintoma: start/end/cancel ficam presos ao mesmo flag de gestao.
- Impacto: possivel regressao de operacao docente.
- Acao:
  - Separar permissoes por acao:
    - CRUD de agendamento: coordenacao.
    - Start/End de aula: validar regra de negocio (coordenacao e/ou professor).
- Criterio de aceite:
  - Matriz de permissao formalizada e refletida em UI + backend.

### Fase C3 - Correcao de confiabilidade e observabilidade

Objetivo: reduzir falhas silenciosas e melhorar diagnostico.

6) Mensagens de erro heterogeneas (alert, inline, silencio)
- Severidade: Media
- Impacto: suporte mais dificil, UX inconsistente.
- Acao:
  - Padronizar feedback com sistema unico (toast + detalhes tecnicos em log).
- Criterio de aceite:
  - Todos fluxos criticos retornam erro amigavel e consistente.

7) Confirmacoes destrutivas sem contexto completo
- Severidade: Baixa/Media
- Impacto: risco de acao acidental.
- Acao:
  - Modal de confirmacao com impacto (ex.: remove matriculas, desatribui turma).
- Criterio de aceite:
  - Confirmacao informa claramente consequencias antes de confirmar.

---

## Fases de Melhoria

### Fase M1 - UX/UI (curto prazo)

Objetivo: melhorar clareza, previsibilidade e usabilidade.

1) Calendario: explicitar timezone oficial
- Acao: exibir "Horario oficial: Brasilia (America/Sao_Paulo)" no formulario.
- Ganho: reduz duvidas de fuso.

2) Calendario: campo Turma na edicao
- Acao: se nao houver migracao de turma, campo deve ser readonly/disabled com tooltip.
- Ganho: remove ambiguidade e evita erro de expectativa.

3) Fluxos administrativos
- Acao: uniformizar estados de loading/sucesso/erro em todos CRUDs.
- Ganho: experiencia consistente para coordenacao.

4) Listagens grandes (alunos/professores)
- Acao: busca por nome/email + paginacao simples.
- Ganho: navegacao mais rapida em base crescente.

### Fase M2 - Performance (medio prazo)

Objetivo: reduzir custo de render, chamadas e tamanho inicial.

1) Bundle inicial elevado
- Evidencia: build alertou chunk > 500 kB.
- Acao:
  - Code splitting por rota com `React.lazy` + `Suspense`.
  - Opcional: `manualChunks` no Vite/Rollup.
- Ganho esperado: menor tempo de carregamento inicial.

2) N+1 na tela de alunos
- Acao:
  - Trocar loop de `listEnrollmentsByClass` por carga unica de matriculas ativas.
  - Indexar em memoria por `student_id`.
- Ganho esperado: menor latencia e menos chamadas em ambiente remoto.

3) Refetch total apos mutacoes
- Acao:
  - Atualizacao otimista local + refetch pontual quando necessario.
- Ganho esperado: UI mais responsiva e menos custo de rede.

4) Computacoes derivadas repetitivas
- Acao:
  - Aplicar `useMemo` para mapas (`classById`, `lessonById`, enrollment map, etc.).
- Ganho esperado: menor custo de render em listas grandes.

### Fase M3 - Arquitetura e governanca (medio/longo prazo)

Objetivo: padronizar regras e facilitar manutencao.

1) Matriz de autorizacao formal
- Acao: documento de permissao por modulo/acao + testes de autorizacao.
- Ganho: reduz regressao de acesso.

2) Camada administrativa para Supabase
- Acao: endpoints server-side para operacoes sensiveis (email/delete).
- Ganho: CRUD completo com seguranca.

3) Telemetria de erro e auditoria
- Acao: log estruturado por operacao critica (criar/editar/excluir/start/end).
- Ganho: suporte e rastreabilidade melhores.

---

## Ordem recomendada de execucao

1. C1 completo (bloqueios criticos e falhas silenciosas).
2. C2 completo (regras de permissao e consistencia funcional).
3. C3 rapido (padrao de erros/confirmacoes).
4. M1 (UX/UI de clareza).
5. M2 (performance de runtime e bundle).
6. M3 (governanca e robustez de longo prazo).

---

## Checklist de validacao por fase

### Para fases de Correcao
- `npm run lint` sem erros.
- `npm run build` sem regressao funcional.
- Teste manual dos fluxos CRUD em coordenacao.
- Teste de permissao cruzada (coordenacao/professor/aluno).

### Para fases de Melhoria
- Medir antes/depois:
  - tempo de carga inicial;
  - quantidade de chamadas em telas de lista;
  - tempo medio de resposta de acoes CRUD.
- Validar experiencia mobile e desktop.

---

## Observacao final

A base atual esta estavel para evolucao, mas a confiabilidade dos fluxos administrativos depende de fechar as correcoes C1 e C2 antes de escalar uso em ambiente real com Supabase ativo.
