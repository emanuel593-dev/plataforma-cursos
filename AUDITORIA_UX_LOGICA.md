# Auditoria de UX, Lógica e Usabilidade — sistema_iv

**Data:** 28 de abril de 2026
**Escopo:** App React + Supabase (LMS Education Platform)
**Contexto:** Pós migration 011 (multi-professor por turma, swap requests, lesson assignment history, push subscriptions, helper RLS `is_class_professor`).

Score geral estimado: **~82%** — sem bugs críticos. Lacunas concentram-se em *notification dispatching*, *visibilidade da coordenação sobre swaps*, *gestão de professores dentro da turma* e *robustez offline*.

---

## ✅ O que está bem coberto

- Roteamento e `ProtectedRoute` por papel; menu sem itens órfãos.
- `class_professors` com batch fetch (`listProfessorsByClasses`) — sem N+1.
- Aba "Histórico" em [src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx) consumindo `lesson_assignment_history`.
- Auto-attendance de 3 camadas (duração mínima, verificações aleatórias, avaliação final) implementado em [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) e documentado em [AUTO_ATTENDANCE.md](AUTO_ATTENDANCE.md).
- PWA: manifest, viewport com `viewport-fit=cover`, safe-area, haptic, pull-to-refresh, Service Worker com Background Sync (`sw-notifications.js`).
- Web Push completo: `push.service.ts`, VAPID, `push_subscriptions` com upsert por endpoint, navegação confiável via `iv:navigate` postMessage.
- Acessibilidade: `aria-label` consistente em ícones, `Modal` com `role="dialog"` + Escape, focus trap implícito.
- Auditoria/LGPD: `audit.service.ts` com `writeAuditLog`, consent na gravação de aula.

---

## 🔴 Lacunas de alta prioridade

### 1. Eventos críticos não disparam notificação push/in-app

- [src/components/views/CalendarView.tsx](src/components/views/CalendarView.tsx#L386): `handleAcceptSwap` e `handleRejectSwap` apenas mostram toast local. O *requester* nunca é avisado de que sua troca foi aceita ou recusada.
- [src/services/schedule.service.ts](src/services/schedule.service.ts#L300): `updateScheduledLesson()` ao trocar `professor_id` (substituição manual da coordenação) também não emite nada. O trigger `lesson_assignment_history` registra no banco, mas o substituto não recebe push nem in-app.
- Faltam dispatchers para: swap aceito/recusado, substituição manual, novo material/anúncio em turma, lembrete pré-aula.
- Infra existente (`push.service.ts`, `sw-notifications.js`, `push_subscriptions`) só falta ser invocada.

### 2. Coordenação sem visibilidade sobre swaps

- [src/components/views/CalendarView.tsx](src/components/views/CalendarView.tsx#L334) só mostra inbox para o `target` do swap. Coordenação não tem nenhuma tela para auditar/ver swaps pendentes/aceitos/rejeitados.
- `swaps.service.ts` já expõe a query — falta UI.
- Recomendação: aba "Trocas" em ReportsView ou em `/gestao`.

### 3. ClassDetailView carrega professores da turma mas não os exibe

- [src/components/views/ClassDetailView.tsx](src/components/views/ClassDetailView.tsx#L92): `classProfessorIds` é populado via `listProfessorsOfClass(id)` mas nunca renderizado.
- Para gerenciar `class_professors` o usuário precisa ir em `/professores` (UX confusa, dois lugares).
- Recomendação: tab/seção "Professores" com listagem e botões adicionar/remover inline.

---

## 🟡 Lacunas de média prioridade

### 4. `useLongPress` definido mas zero usuários
- [src/hooks/useLongPress.ts](src/hooks/useLongPress.ts) — nenhuma referência. Bom encaixe em cards de aula (menu rápido: editar/cancelar/trocar) e em cards de professor/turma.

### 5. `useNetworkStatus` é puramente cosmético
- [src/components/Layout.tsx](src/components/Layout.tsx#L76) só altera theme color e mostra banner. Botões de submit continuam habilitados offline → falhas silenciosas.
- Opções: bloquear submit ou enfileirar via Background Sync (SW já tem tags `iv:*`).

### 6. `reports.service.ts` sem `assertCanMutate` em `saveReport`
- [src/services/reports.service.ts](src/services/reports.service.ts) — `deleteReport` valida role, `saveReport` não. RLS protege em produção, mas em modo localStorage é exploitable. Gap G2 do `AUTHORIZATION_MATRIX.md`.

### 7. Cache em localStorage pode estourar
- `iv_scheduled_lessons`, `iv_classes`, attendance matrix. Migrar leituras pesadas para IndexedDB.

---

## 🟢 Polimentos / baixa prioridade

- Confirmação antes de aceitar swap (clique único hoje).
- Toast de swap mais informativo (incluir nome do colega e horário).
- Badge no menu Calendário com contagem de swaps pendentes.
- `/gestao` como hub real (Trocas, Auditoria, Configurações).
- Breadcrumbs em `/turmas/:id`.
- ARIA live region para toasts/notificações in-app.
- Sem testes — adicionar E2E mínimo para jornadas RLS-sensíveis.

---

## 💡 Refactors sugeridos

- **`events.service.ts` unificado**: combinar in-app + push + audit num único `emitSwapAccepted(swap)`, `emitLessonReassigned(lesson, oldProf, newProf)`. Hoje cada chamador esquece um dos três.
- **`substitution.service.ts`**: centralizar fluxo aceitar swap → atualizar `scheduled_lessons.professor_id` → notificar → auditar. Hoje espalhado entre `swaps.service.ts` e `CalendarView`.
- **`cache.service.ts`**: abstrair localStorage/IndexedDB em interface única.

---

## 📋 Resumo executivo

| Área | Status |
|---|---|
| Estrutura & roteamento | ✅ Sólido |
| `class_professors` | ✅ 90% (falta exibição em ClassDetailView) |
| `lesson_swap_requests` | ⚠️ 70% (falta visão coord + notificações) |
| `lesson_assignment_history` | ✅ 100% |
| Push & notificações | ✅ 95% (falta dispatch em eventos) |
| Acessibilidade | ✅ 85% |
| PWA / Mobile | ✅ 90% |
| Auto-attendance | ✅ 100% |
| Offline mode | ⚠️ 60% |
| Tests | ❌ 0% |

---

## 🎯 Roadmap sugerido

**Sprint 1 (crítico)**
- [ ] Dispatcher de notificação em swap aceito/recusado e em substituição manual
- [ ] Aba/inbox de swaps para coordenação
- [ ] Tab "Professores" em ClassDetailView

**Sprint 2 (importante)**
- [ ] IndexedDB para attendance + scheduled_lessons
- [ ] `useNetworkStatus` bloqueando submits offline
- [ ] `assertCanMutate` em `saveReport`
- [ ] Integrar `useLongPress` em cards de aula

**Sprint 3 (nice-to-have)**
- [ ] `events.service.ts` e `substitution.service.ts` unificados
- [ ] E2E tests para jornadas críticas
- [ ] Background Sync queue para offline
- [ ] Breadcrumbs em rotas aninhadas
