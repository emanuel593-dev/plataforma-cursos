# IV Platform — Matriz de Autorização

> Gerado em 2026-04-15. Última atualização: **2026-05-13** (Fase 5 promote managed + ajustes UX 7-day window).
> Atualizar sempre que novas entidades ou políticas forem adicionadas.

## Papéis

| Código | Nome | Descrição |
|--------|------|-----------|
| **C** | `coordenacao` | Acesso administrativo total |
| **P** | `professor` | Gerencia turmas próprias, presença e relatórios |
| **M** | `monitor` | Auxilia professor em turmas atribuídas (presença, sala) |
| **A** | `aluno` | Visualiza dados de turmas matriculadas |

---

## Matriz CRUD por Entidade

| Entidade | CREATE | READ | UPDATE | DELETE |
|----------|--------|------|--------|--------|
| **profiles** | _(trigger auth)_ | C, P, A | Próprio OU C | _(não exposto)_ |
| **modules** | C | C, P, A | C | C |
| **lessons** | C | C, P, A | C | C |
| **classes** | C | C, P, A | C | C |
| **enrollments** | C | C=all, P=turmas próprias, A=próprio | C | C |
| **scheduled_lessons** | C | C=all, P=turmas próprias, A=matriculadas | C + P (turma própria) | C |
| **attendance** | C + P (turma) + A (próprio) | C=all, P=turma, A=próprio | C + P (turma) + A (próprio) | _(negado)_ |
| **lesson_reports** | P (próprio) | P=próprio, C=all | C | C |
| **announcements** | C (global/turma) + P (turma própria) | C=all, P=turma+global, A=matriculada+global | C + P (autor/turma) | C + P (autor) |
| **announcement_reads** | Próprio (`user_id = auth.uid()`) | C, P, A | _(negado)_ | _(negado)_ |
| **class_materials** | C + P (turma) | C=all, P=turma, A=matriculada | C + uploader | C + uploader |

---

## Camadas de Enforcement

### 1. Rotas (ProtectedRoute em App.tsx)

| Rota | Papéis Permitidos |
|------|-------------------|
| `/` (Dashboard) | C, P, A |
| `/calendario` | C, P, A |
| `/sala/:roomId` | C, P, A |
| `/perfil` | C, P, A |
| `/turmas` | C, P |
| `/turmas/:id` | C, P, A |
| `/presencas` | C, P |
| `/modulos` | C |
| `/alunos` | C |
| `/professores` | C |
| `/relatorios` | C |

### 2. Service-layer (localStorage mode)

| Serviço | Função | Guard |
|---------|--------|-------|
| `schedule` | `createScheduledLesson` | `assertCoordinator()` |
| `schedule` | `deleteScheduledLesson` | `assertCoordinator()` |
| `schedule` | `startLesson` | `assertLessonController()` |
| `schedule` | `endLesson` | `assertLessonController()` |
| `schedule` | `cancelLesson` | `assertLessonController()` |
| `announcements` | `listVisibleAnnouncements` | Filtro por role (sem throw) |
| _demais serviços_ | _(todas as funções)_ | **Nenhum guard** — depende de RLS |

### 3. UI-layer (botões/ações condicionais)

| View | Padrão | Controla |
|------|--------|----------|
| Layout | `NAV_ITEMS[].roles.includes(role)` | Menu lateral/mobile/bottom tabs |
| CalendarView | `canManage = coordenacao` | Editar/Excluir agendamento |
| CalendarView | `canControlLesson = coordenacao\|professor` | Iniciar/Encerrar/Cancelar |
| ClassDetailView | `isCoord` | Aba Gestão, avançar módulo |
| ClassDetailView | `canManage = isCoord\|isProf` | Contador leituras, materiais |
| ClassesView | `coordenacao` | Botão Nova Turma, Editar, Excluir |
| DashboardView | `coordenacao\|professor` | Publicar aviso |
| ClassroomView | `aluno` | Modal verificação presença |
| ClassroomView | `isHost` | Controles de host (mudo/kick) |

### 4. RLS (Supabase — produção)

Todas as tabelas possuem `ENABLE ROW LEVEL SECURITY` com políticas granulares definidas em:
- `supabase/migrations/001_initial_schema.sql`
- `supabase/migrations/005_announcements.sql`
- `supabase/migrations/006_*.sql`
- `supabase/migrations/007_phase3_4_schema.sql`

---

## Gaps Conhecidos

| # | Descrição | Impacto | Mitigação Atual |
|---|-----------|---------|-----------------|
| G1 | Modo localStorage não tem enforcement server-side para CRUD de classes, modules, enrollments, materials, profiles, reports | Baixo (dev only) | RLS ativo em produção (Supabase) |
| G2 | Serviços exceto `schedule` não fazem assert de role | Médio | RLS enforcement + UI hiding |
| G3 | Tabela `attendance` sem política DELETE | Baixo | Nenhuma operação de delete é exposta na UI |
| G4 | `auth.createProfessorAccount/Student` sem assert | Baixo | Views protegidas por ProtectedRoute (coordenacao-only) |

---

## Recomendações Futuras

1. Adicionar `assertCoordinator()` nos serviços de `classes`, `modules`, `enrollments`, `profiles` para defesa em profundidade
2. Adicionar política RLS de DELETE em `attendance` se a funcionalidade for exposta
3. Criar testes E2E por jornada (aluno tenta criar turma → bloqueado)

---

## Modalidades de Turma e Aula

Migrations `034_modality.sql` adicionam:

- `classes.modality` (`online | presencial | hibrida`, default `online`)
- `classes.location` (texto livre, usado em presencial/híbrida)
- `scheduled_lessons.modality` (mesmo enum, **nullable** — herda da turma)
- Função `effective_lesson_modality(p_lesson_id uuid)` retorna `aula.modality ?? turma.modality ?? 'online'`
- Helper TS espelho: `effectiveLessonModality(lesson, cls)` em `src/types.ts`

### Comportamento por modalidade

| Camada | online | presencial | hibrida |
|--------|--------|-----------|---------|
| Botão "Entrar na aula" (Dashboard/Calendar/ClassDetail) | habilitado | **oculto** — substituído por "🏛️ Aula presencial" | habilitado |
| Rota `/sala/:roomId` (ClassroomView) | acesso normal | **guarda** redireciona para `/turmas/:id` | acesso normal |
| Botão "Registrar presença" (ClassDetailView) | n/a | visível para C+P (link `/presencas?aula=:id`) | n/a |
| Cron `push-events` lesson-started | dispara | **skip** | dispara |
| Função `push-lesson-started` | body "Toque para entrar na sala." + url `/sala/...` | body "Aula presencial em andamento." + url `/turmas/...` | body sala |
| `notifications.service` in-app | "Aula ao vivo" + link sala | "Aula presencial em andamento" + link turma | "Aula ao vivo" + link sala |
| Trigger `auto_absent` (migration 033) | marca faltas | **skip** (presença é manual) | marca faltas |

### Trigger `attendance` para presencial

- `attendance_set_marked_by_trigger` é `DEFERRABLE` para permitir bootstrap (criar turma online → atribuir professor → atualizar modalidade)
- `manually_overridden = true` + `marked_by` setado quando coordenação/monitor marcam manualmente

---

## Perfis Gerenciados (`is_managed_only`)

Migration `035_managed_profile_rpcs.sql` adiciona suporte a perfis criados via cadastro inline (sem login auth), úteis para alunos sem e-mail.

| Coluna | Tipo | Significado |
|--------|------|-------------|
| `profiles.is_managed_only` | `boolean default false` | `true` = perfil sem auth.users associado, gerenciado por coordenação |
| `profiles.managed_by` | `uuid` FK profiles | Coordenador responsável (auditoria) |

### RPCs (segurança definer, somente `coordenacao`):

| RPC | Função | Validações |
|-----|--------|-----------|
| `create_managed_profile(p_full_name, p_email, p_role)` | Cria perfil gerenciado | `role IN ('aluno','professor','monitor')`, `email` único entre managed |
| `update_managed_profile(p_id, p_full_name, p_email)` | Atualiza managed | Verifica `is_managed_only = true` |
| `delete_managed_profile(p_id)` | Remove managed | Verifica `is_managed_only = true` |

### Promoção managed → conta real (Fase 5 — implementada 2026-05-13)

| Endpoint | Quem pode | Mecanismo |
|----------|-----------|-----------|
| `POST /.netlify/functions/admin-promote-managed` | `coordenacao` (verificado server-side via Bearer token) | Cria `auth.users` com **mesmo UUID** do profile (preserva FKs em enrollments/class_professors/attendance). O trigger `handle_new_user` faz `ON CONFLICT DO UPDATE` flipando `is_managed_only=false` e setando email. Opcionalmente envia link `recovery` para definição de senha. Audit log com action `profile.managed_promoted`. |

UI: botão `UserCheck` na linha de [StudentsView.tsx](src/components/views/StudentsView.tsx) e [ProfessoresView.tsx](src/components/views/ProfessoresView.tsx) — visível apenas quando `is_managed_only===true`.

### Onde aparece na UI

- `ClassFormView` (wizard nova turma) → cadastro inline de professor/monitor/aluno
- `StudentsView`, `ProfessoresView` → listar, editar, excluir e **promover** managed
- Botão "Promover" abre modal com input email + checkbox "Enviar link de senha"

---

## Atualizações na Matriz de Rotas (revisão modalidades)

| Rota | Papéis | Notas |
|------|--------|-------|
| `/sala/:roomId` | C, P, M, A | Guarda em runtime: bloqueia se `effectiveLessonModality === 'presencial'` |
| `/presencas?aula=:id` | C, P, M | Monitor com acesso só leitura+marcar presença manual; **edição limitada a 7 dias** após a aula (coord. sempre) |
| `/turmas` | C, P, M | Monitor vê suas turmas atribuídas |
| `/turmas/:id` | C, P, M, A | Aluno via matrícula; monitor via `class_monitors` |

---

## Divergências / refinamentos durante implementação (sprint 2026-05)

| Item | Plano original | Implementação final | Motivo |
|------|----------------|----------------------|--------|
| Janela de edição de chamada | "7 dias para monitor" genérico | Constante `SEVEN_DAYS_MS` em [AttendanceView.tsx](src/components/views/AttendanceView.tsx) + helper `canEditLessonAttendance(role, scheduledAt)` aplicada em **3 pontos de entrada** (cell click, marcar todos, salvar notas) | Garantir bloqueio uniforme em todos fluxos |
| Botão "Promover managed" | Modal simples com email | Modal com email **+ checkbox "Enviar convite"** (default true) e atualização otimista da lista | UX: coord pode criar conta sem disparar email (p.ex. setar senha manualmente depois) |
| "Magic invite" para promoção | Doc menciona invite | Implementado via `/auth/v1/admin/generate_link` tipo `recovery` | Supabase não tem endpoint dedicado de "promote invite"; recovery link é o padrão equivalente para definir senha |
| Override de modality em aula | "radio na criação de aula híbrida" | State `lessonModalityOverride: 'inherit' \| 'online' \| 'presencial'` em [ClassDetailView.tsx](src/components/views/ClassDetailView.tsx); `'inherit'` mapeia para `null` no DB — radio aparece **apenas** quando `cls.modality === 'hibrida'` | Evitar UX confusa em turmas puras |
| FK profiles → auth | Doc propsôs deferrable OU remover | **Remover + trigger validador** (`profiles_validate_auth_link_trg`) | Deferrable não cobre o cenário "profile sem auth.users" |
| Trigger `handle_new_user` | Não detalhado | Reescrito com `ON CONFLICT DO UPDATE` que flipa `is_managed_only=false` — **chave da promoção** preservar UUID | Permite `POST /admin/users` com `id` do profile sem violar PK |
| Validador `classes_validate_required_professor` | Trigger AFTER simples | Constraint **DEFERRABLE INITIALLY DEFERRED** | Permite o padrão atual de ClassesView (criar online → anexar prof → update modality) |
| Push presencial recipients | "monitores" | Fallback **prof titular** se `class_monitors` vazio (e coord como último fallback) | Reduz risco de chamada esquecida |
| FJ (falta justificada) | Modal com `notes` opcional | `notes.trim()` **obrigatório** — botão salvar disabled até preencher | Garantir auditoria mínima |
| Card "Próxima chamada" no Dashboard | Card dedicado | Reaproveitado card existente de upcoming lessons — botão "Fazer chamada" condicionado a `effectiveLessonModality === 'presencial'` + role ∈ {C, M} | Menos invasivo, menos código |
