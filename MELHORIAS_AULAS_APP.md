# Melhorias UX/UI — Sala de Aula, Relatórios e Fluxos Correlatos

> Documento de auditoria das oportunidades de melhoria identificadas após
> implementação das correções de auto-attendance, "Iniciar aula" e relatórios
> enriquecidos. Cada ponto contém **descrição do problema atual**, **proposta
> de solução** e **arquivos/áreas afetados** para facilitar implementação.

---

## Sumário

- [Alta prioridade — gaps funcionais](#alta-prioridade--gaps-funcionais)
  - [A. Indicador "Iniciar aula" para alunos esperando](#a-indicador-iniciar-aula-para-alunos-esperando)
  - [B. Botão "Iniciar aula" muito próximo do "Encerrar"](#b-botão-iniciar-aula-muito-próximo-do-encerrar)
  - [C. Falta export/CSV do relatório enriquecido](#c-falta-exportcsv-do-relatório-enriquecido)
  - [D. Filtros no ReportsView](#d-filtros-no-reportsview)
- [Média prioridade — polimento](#média-prioridade--polimento)
  - [E. Estado vazio do Calendar mais útil](#e-estado-vazio-do-calendar-mais-útil)
  - [F. Indicador de "qualidade de conexão ruim" persistente](#f-indicador-de-qualidade-de-conexão-ruim-persistente)
  - [G. Lista de participantes com presença em tempo real](#g-lista-de-participantes-com-presença-em-tempo-real)
  - [H. Confirmação de saída para alunos com tempo crítico](#h-confirmação-de-saída-para-alunos-com-tempo-crítico)
  - [I. Notificação push quando aula é iniciada](#i-notificação-push-quando-aula-é-iniciada)
- [Baixa prioridade — micro-UX](#baixa-prioridade--micro-ux)
  - [J. Skeleton loaders em vez de PageLoader genérico](#j-skeleton-loaders-em-vez-de-pageloader-genérico)
  - [K. Empty state nos detalhes de presença](#k-empty-state-nos-detalhes-de-presença)
  - [L. Tooltips faltando em ícones](#l-tooltips-faltando-em-ícones)
  - [M. Modo "apresentação" no compartilhamento de tela](#m-modo-apresentação-no-compartilhamento-de-tela)
  - [N. Indicador de quem está falando em chat de áudio puro](#n-indicador-de-quem-está-falando-em-chat-de-áudio-puro)
  - [O. Persistência de preferências de chat](#o-persistência-de-preferências-de-chat)
- [Observações técnicas — pegadinhas que podem virar bugs visíveis](#observações-técnicas--pegadinhas-que-podem-virar-bugs-visíveis)
  - [P. `formatHm` exibe horário no fuso do cliente](#p-formathm-exibe-horário-no-fuso-do-cliente)
  - [Q. "Atrasado +Xmin" não considera tolerância de início](#q-atrasado-xmin-não-considera-tolerância-de-início)
  - [R. Reports não mostram nome da turma quando `scheduled_lesson` foi deletado](#r-reports-não-mostram-nome-da-turma-quando-scheduled_lesson-foi-deletado)
- [Roadmap recomendado](#roadmap-recomendado)

---

## Alta prioridade — gaps funcionais

### A. Indicador "Iniciar aula" para alunos esperando

**Problema atual:**
O aluno entra na sala antes do host clicar "Iniciar" e vê apenas:
- Badge "Aguardando início" no header
- Cronômetro `--:--`

Não há feedback explícito de que **a conexão está saudável** e que o sistema está aguardando o professor. Aluno pode pensar que está com problema de áudio/vídeo ou que entrou em aula errada.

**Proposta:**
- Overlay/mensagem central no grid de vídeo enquanto `lessonStartedAt === null`:
  > *"O professor ainda não iniciou a aula. Você está conectado e seu áudio/vídeo já estão funcionando."*
- Som curto (notification chime) + haptic sutil quando o evento `lesson-started` chega via Realtime — útil quando o aluno minimizou o app/aba.

**Arquivos afetados:**
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) — overlay condicional + listener para tocar som no flip de `lessonStartedAt: null → number`
- [src/hooks/useHaptic.ts](src/hooks/useHaptic.ts) — já existe, reutilizar
- `public/sounds/lesson-start.mp3` (novo asset)

---

### B. Botão "Iniciar aula" muito próximo do "Encerrar"

**Problema atual:**
Os botões "Iniciar aula" (verde, pulsante) e "Encerrar" (vermelho) estão lado a lado na mesma `controls bar`. Risco de clique acidental. Hoje:
- "Encerrar" tem confirmação modal
- "Iniciar" **NÃO** tem confirmação (idempotente, mas ainda assim é decisão importante)

**Proposta:**
Mover "Iniciar aula" para fora da controls bar — exibir como **banner verde proeminente acima do grid de vídeo** enquanto `isHost && lessonStartedAt === null`. O banner some assim que a aula começa, devolvendo o espaço ao grid.

Estrutura sugerida:
```
┌───────────────────────────────────┐
│ ▶ Iniciar Aula  (banner cheio)    │  ← só host, só pré-início
├───────────────────────────────────┤
│        Grid de vídeo               │
│                                    │
├───────────────────────────────────┤
│ 🎤 📹 📺 💬 ⚙️  ⛔ Encerrar        │  ← controls bar limpa
└───────────────────────────────────┘
```

**Arquivos afetados:**
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) — mover JSX do botão; remover do controls bar e adicionar como banner condicional acima do grid

---

### C. Falta export/CSV do relatório enriquecido

**Problema atual:**
Após o enriquecimento da [ReportsView.tsx](src/components/views/ReportsView.tsx), a coordenação consegue ver tabela detalhada de presença por aluno (entrou/saiu/duração/status/notas/atraso). Porém **não há como exportar** esses dados para arquivamento, planilhas ou envio à secretaria escolar.

**Proposta:**
Adicionar botão "Exportar" no header de cada card expandido com 2 opções:
- **CSV**: planilha com uma linha por aluno (compatível com Excel/Google Sheets)
- **PDF/Imprimir**: layout printer-friendly da tabela com cabeçalho da aula

Conteúdo do CSV:
```
Aluno,Email,Entrou,Saiu,Permaneceu (min),Status,Verificações,Atraso (min),Observação
```

**Arquivos afetados:**
- [src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx) — botão + lógica de geração CSV (sem deps externas, `Blob` + `URL.createObjectURL`)
- Print: usar `window.print()` com CSS `@media print` em [src/index.css](src/index.css) escondendo chrome

---

### D. Filtros no ReportsView

**Problema atual:**
Hoje só há **busca textual** no nome do título. Coordenadores com muitas turmas/professores precisam scrollar/buscar manualmente.

**Proposta:**
Adicionar barra de filtros (colapsável em mobile) com:
- Dropdown **Turma** (carregado de `listClasses()`)
- Dropdown **Professor** (carregado de `listProfilesByRole('professor')`)
- **Intervalo de datas** (date pickers `from` / `to`)
- Toggle **"Só aulas com ausências automáticas"** (ratio < 75% ou checks falhados em algum aluno) — para auditoria rápida de problemas

Persistir filtros em URL query params para compartilhamento.

**Arquivos afetados:**
- [src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx)
- Reuso de `useSearchParams` (já existe)

---

## Média prioridade — polimento

### E. Estado vazio do Calendar mais útil

**Problema atual:**
Quando não há aulas no mês selecionado, exibe ilustração genérica (`EmptyState`). Para coord, é uma oportunidade desperdiçada de orientar a próxima ação.

**Proposta:**
Estado vazio diferenciado por papel:
- **Coord**: CTA grande "Agendar primeira aula" → abre modal de criação
- **Professor**: mensagem informativa "Nenhuma aula agendada neste período"
- **Aluno**: mesma do professor

**Arquivos afetados:**
- [src/components/views/CalendarView.tsx](src/components/views/CalendarView.tsx)

---

### F. Indicador de "qualidade de conexão ruim" persistente

**Problema atual:**
`ConnectionBadge` em [ClassroomView.tsx](src/components/views/ClassroomView.tsx) mostra qualidade no header (good/fair/poor). Mas se ficar `poor` por 30s+ o usuário **não recebe orientação** sobre o que fazer — a informação é passiva.

**Proposta:**
Detectar `quality === 'poor'` por mais de 30s contínuos → toast dismissível:
> *"Conexão instável detectada. Considere desligar a câmera para preservar áudio."*

Botão de ação no toast: "Desligar câmera". Reset do timer quando qualidade volta a `good`/`fair`.

**Arquivos afetados:**
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) — `useEffect` com timer
- [src/contexts/ToastContext.tsx](src/contexts/ToastContext.tsx) — já tem suporte a action buttons (verificar)

---

### G. Lista de participantes com presença em tempo real

**Problema atual:**
Hoje o host vê só os tiles de vídeo. Para turmas grandes (>9 alunos), os tiles ficam pequenos e é difícil saber rapidamente:
- **Quem está conectado** (visível pelos tiles)
- **Quem ainda não entrou** (invisível — precisa abrir outra view)

**Proposta:**
Drawer lateral (toggle por ícone `Users` no header) com:
- Lista textual ordenada alfabeticamente: `[●] Nome do aluno` (verde se conectado, cinza se não)
- Cruzamento com `class_students` para mostrar todos os matriculados
- Contador "X de Y conectados"
- Ações inline (host): silenciar / remover / promover host

**Arquivos afetados:**
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx)
- Carregar `class_students` via [src/services/classes.service.ts](src/services/classes.service.ts) (verificar se já existe método)
- Novo componente `ParticipantsDrawer`

---

### H. Confirmação de saída para alunos com tempo crítico

**Problema atual:**
Aluno pode clicar "Sair" em qualquer momento. Se sair com `ratio < MIN_DURATION_RATIO` (75%), será **automaticamente marcado ausente**. Mas o aluno não sabe disso no momento da decisão.

**Proposta:**
Em `handleLeave` (perfil aluno), ANTES do disconnect, calcular ratio atual e se `< 75%` exibir modal:
> *"Sair agora pode marcar você como ausente automaticamente.
> Você está há **X min** dos **Y min** mínimos.
> Tem certeza?"*

Botões: **"Continuar na aula"** (cancelar) | **"Sair mesmo assim"** (confirmar).

**Arquivos afetados:**
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) — `handleLeave` para alunos
- Reuso do `ConfirmModal` existente

---

### I. Notificação push quando aula é iniciada

**Problema atual:**
Há push para "lembrete antes da aula" via [netlify/functions/push-reminders.ts](netlify/functions/push-reminders.ts). Mas:
- Aluno pode entrar na sala **antes** do horário (ver opção A acima)
- Minimiza a aba esperando o professor
- Quando aula realmente começa, **não recebe nenhuma notificação**

**Proposta:**
Quando host clica "Iniciar aula" → `markLessonStarted` no servidor → trigger push para todos os alunos da turma matriculados com:
> *"Sua aula '{título}' começou agora"*

Implementação: ou nova Netlify Function `push-lesson-started.ts` chamada explicitamente do client após `markLessonStarted`, ou trigger Postgres em `scheduled_lessons` quando `started_at` muda de NULL → valor.

**Arquivos afetados:**
- Nova função em [netlify/functions/](netlify/functions/) OU trigger em SQL
- [src/services/schedule.service.ts](src/services/schedule.service.ts) `markLessonStarted` — chamar a função
- Reutilizar infra de [netlify/functions/push-send.ts](netlify/functions/push-send.ts)

---

## Baixa prioridade — micro-UX

### J. Skeleton loaders em vez de PageLoader genérico

**Problema atual:**
[src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx), [src/components/views/ClassDetailView.tsx](src/components/views/ClassDetailView.tsx), [src/components/views/CalendarView.tsx](src/components/views/CalendarView.tsx) usam `PageLoader` (spinner full-screen) durante o load.

Skeleton loaders preservam o layout final e dão **percepção de carregamento mais rápido** (a tela "se monta" progressivamente em vez de "piscar").

**Proposta:**
Componente `<Skeleton>` simples (div animada com gradient shimmer) e variantes pré-prontas para card de relatório, linha de tabela, evento de calendário.

**Arquivos afetados:**
- Novo `src/components/ui/Skeleton.tsx`
- Substituir uso de `PageLoader` nas views listadas

---

### K. Empty state nos detalhes de presença

**Problema atual:**
Tabela de attendances vazia mostra texto plano `"Nenhum participante registrado."`. Não diferencia visualmente:
- Aula sem alunos matriculados
- Aula que nunca foi iniciada (lição cancelada / host saiu sem clicar Iniciar)
- Erro de carregamento

**Proposta:**
Empty states distintos com ícone + texto contextual.

**Arquivos afetados:**
- [src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx)

---

### L. Tooltips faltando em ícones

**Problema atual:**
Vários ícones em headers, badges e indicadores não têm `title` ou `aria-label`:
- `ConnectionBadge`
- `AudioLevelBar`
- Ícones de status do calendário
- Ícones decorativos em cards

Acessibilidade prejudicada (screen readers) e descobrabilidade (hover não revela função).

**Proposta:**
Auditoria geral adicionando `title` ou componente `<Tooltip>` consistente. Considerar usar Radix UI Tooltip ou componente próprio.

**Arquivos afetados:**
- Vários componentes em `src/components/`

---

### M. Modo "apresentação" no compartilhamento de tela

**Problema atual:**
Quando alguém compartilha tela, os tiles de vídeo continuam no mesmo tamanho do grid normal — a tela compartilhada compete por espaço com os rostos.

**Proposta:**
Quando há `screenSharing === true` (qualquer participante):
- Tela compartilhada ocupa ~80% da área (foco)
- Tiles de participantes viram thumbnails pequenos na lateral direita ou parte inferior
- Padrão consistente com Google Meet / Zoom

**Arquivos afetados:**
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) — lógica de grid condicional
- Novo CSS class para layout "presentation mode"

---

### N. Indicador de quem está falando em chat de áudio puro

**Problema atual:**
Já existe `useSpeakingDetection` para o tile **local** (border verde quando o usuário fala). Para tiles **remotos**, o efeito não é replicado.

Em chamadas só com áudio (todos com câmera desligada), é impossível saber **quem está falando**.

**Proposta:**
Compartilhar nível de áudio via Realtime broadcast (`audio-level` event, throttled a ~5Hz) ou usar `getStats()` do RTCPeerConnection para inferir atividade no track remoto. Aplicar borda verde no tile remoto correspondente.

**Arquivos afetados:**
- [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts) — broadcast de speaking state
- [src/hooks/useSpeakingDetection.ts](src/hooks/useSpeakingDetection.ts) — possivelmente generalizar
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) — passar `isSpeaking` para `VideoTile` remoto

---

### O. Persistência de preferências de chat

**Problema atual:**
Estado `chatOpen` em [ClassroomView.tsx](src/components/views/ClassroomView.tsx) é local no componente. Cada nova entrada em sala reseta para `false`. Usuários que sempre querem o chat aberto têm que reabrir manualmente.

**Proposta:**
Persistir em `localStorage` chave `iv_chat_default_open` (boolean). Carregar no `useState` inicial.

Padrão similar para outras preferências de UI (sidebar collapsed, theme — se houver).

**Arquivos afetados:**
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx)

---

## Observações técnicas — pegadinhas que podem virar bugs visíveis

### P. `formatHm` exibe horário no fuso do cliente

**Problema:**
[ReportsView.tsx](src/components/views/ReportsView.tsx) `formatHm()` usa `Date#toLocaleTimeString('pt-BR', ...)` sem `timeZone`. Se um coordenador acessa o relatório de uma viagem (TZ diferente da escola), os horários `joined_at` / `left_at` aparecem deslocados.

**Proposta:**
Fixar `timeZone: 'America/Sao_Paulo'` (ou config global da instituição) em todos os formatadores de horário.

**Arquivos afetados:**
- [src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx)
- [src/lib/utils.ts](src/lib/utils.ts) — possível helper centralizado `formatTimeBR`
- Auditoria em outras views que mostram horário

---

### Q. "Atrasado +Xmin" não considera tolerância de início

**Problema:**
Threshold de 5min hardcoded em `LATE_THRESHOLD_MINUTES` em [ReportsView.tsx](src/components/views/ReportsView.tsx). Algumas instituições/professores deixam 10-15min de cortesia no início; outras são rígidas.

**Proposta:**
Adicionar coluna `late_threshold_minutes integer DEFAULT 5` na tabela `classes`. Cada turma define seu próprio limite. UI de admin de turma para editar.

**Arquivos afetados:**
- Nova migração SQL
- [src/types.ts](src/types.ts) — atualizar tipo `Class`
- [src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx) — usar valor da turma em vez de constante
- UI de edição de turma (verificar onde fica)

---

### R. Reports não mostram nome da turma quando `scheduled_lesson` foi deletado

**Problema:**
[ReportsView.tsx](src/components/views/ReportsView.tsx) `getClassName()` retorna `—` se `scheduled_lessons` foi deletada (por qualquer motivo: cleanup, erro, cascade). O relatório fica órfão visualmente.

**Proposta:**
Denormalizar `class_name text` no `lesson_reports` no momento do `saveReport`. Salva no histórico mesmo se a turma for renomeada/deletada futuramente. Princípio de "snapshot histórico" igual ao já feito com `professor_name` e `participants[].userName`.

**Arquivos afetados:**
- Nova migração: `ALTER TABLE lesson_reports ADD COLUMN class_name text`
- [src/types.ts](src/types.ts) — atualizar tipo `LessonReport`
- [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) — `saveReport` populando `class_name`
- [src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx) — fallback `report.class_name ?? getClassName(report)`

---

## Roadmap recomendado

Priorização para próximos 2-3 sprints:

| Sprint | Itens | Foco | Esforço |
|---|---|---|---|
| **Sprint 1 — Auditoria/Produção** | A, B, C, F | Fechar gaps que afetam uso real de aula e auditoria | Baixo-Médio |
| **Sprint 2 — Gestão** | D, G, I | Ferramentas para coord visualizar e comunicar | Médio |
| **Sprint 3 — Polimento** | H, M, N | UX refinada e features comparáveis a Meet/Zoom | Médio-Alto |
| **Backlog técnico** | E, J, K, L, O, P, Q, R | Pode ser distribuído em capacity sobressalente | Variado |

**Recomendação:** começar com **A + B + H** — são os de maior impacto na UX real de aula e baixo esforço relativo.

---

*Documento gerado a partir da auditoria pós-implementação dos fixes de
auto-attendance, "Iniciar aula" e relatórios enriquecidos. Atualizar conforme
itens forem implementados.*
