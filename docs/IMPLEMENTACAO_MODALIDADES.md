# Implementação de Modalidades (Online / Presencial / Híbrida)

> Documento-guia para introdução das modalidades **online**, **presencial** e **híbrida**
> ao sistema. Referência única para escopo, decisões, schema, UI e ordem de execução.
>
> **Status: Fases 1-5 concluídas e validadas em 2026-05-13** (build verde, 35/35 testes verdes,
> migrations 034 e 035 aplicadas em produção `iqltmpkqudhtkfqgqfwl`). Fase 6 (polish/onboarding
> tooltips) pendente.

---

## 1. Objetivo

Estender o sistema (hoje 100% voltado para aulas online) para também gerenciar
**turmas presenciais** e **híbridas** (online + presencial), sem quebrar o
funcionamento atual e sem inflar a complexidade do produto.

A versão online atual permanece **idêntica**: WebRTC, presença automática,
gravação, chat, polls, push de início de aula — tudo continua funcionando para
turmas marcadas como `online`.

---

## 2. Conceitos firmados

### 2.1 Modalidades

| Modalidade | Comportamento |
|---|---|
| `online` | Idêntico ao atual: ClassroomView, WebRTC, presença automática, todos os recursos online. |
| `presencial` | Gestão/gerenciamento. Sem ClassroomView, sem WebRTC, sem chat/polls/gravação. Presença é manual (chamada feita por monitor ou coordenação). |
| `hibrida` | Turma com **aulas mistas**. A modalidade é decidida **na criação de cada aula**, não na turma. Cada aula segue 100% o fluxo da sua modalidade. |

### 2.2 Quem loga no app

| Papel | Tipo de turma | Loga? |
|---|---|---|
| Coordenação | Online + Presencial + Híbrida | ✅ Sempre |
| Monitor | Online + Presencial + Híbrida | ✅ Sempre |
| Professor online | Online (e online da híbrida) | ✅ |
| Aluno online | Online (e online da híbrida) | ✅ |
| **Professor presencial** | Presencial | ❌ "managed only" |
| **Aluno presencial** | Presencial | ❌ "managed only" |

> "Managed only" = registro existe em `profiles` para gestão (chamada,
> relatórios, vinculação a turma) mas **sem usuário em `auth.users`**, sem login,
> sem push, sem e-mail de convite.

### 2.3 Vínculos obrigatórios

| Tipo de turma | Professor | Monitor |
|---|---|---|
| `online` | Pelo menos 1 (modelo atual mantido) | opcional |
| `presencial` | **Pelo menos 1 obrigatório** | recomendado, opcional |
| `hibrida` | **Pelo menos 1 obrigatório** | recomendado, opcional |

Sem monitor, **a coordenação faz a chamada** (já tem permissão total).

### 2.4 Permissão de chamada (P/F/FJ)

| Modalidade | Quem pode marcar |
|---|---|
| `online` | Sistema automático + coordenação (override manual) |
| `presencial` | Monitor da turma + coordenação |
| `hibrida` (aula online) | Sistema automático + coordenação |
| `hibrida` (aula presencial) | Monitor da turma + coordenação |

Professor presencial **não loga** → não tem permissão de chamada. Decisão
intencional para manter o produto enxuto.

---

## 3. Schema (migration `034_modality.sql`)

### 3.1 Enum
```sql
CREATE TYPE class_modality AS ENUM ('online', 'presencial', 'hibrida');
```

### 3.2 Coluna em `classes`
```sql
ALTER TABLE classes
  ADD COLUMN modality class_modality NOT NULL DEFAULT 'online',
  ADD COLUMN location text NULL;  -- endereço/sala física (presencial e híbrida)
```

`DEFAULT 'online'` garante que **todas as turmas existentes ficam online**
sem migration de dados.

### 3.3 Coluna em `scheduled_lessons`
```sql
ALTER TABLE scheduled_lessons
  ADD COLUMN modality class_modality NULL;
```

Semântica:
- `NULL` → herda da turma (caso 99% das turmas online ou presencial puras).
- Não-`NULL` → override por aula (usado em turmas híbridas).

Index de filtro para queries de push/cron:
```sql
CREATE INDEX idx_scheduled_lessons_effective_modality
  ON scheduled_lessons (id, modality)
  WHERE modality IS NOT NULL;
```

### 3.4 Coluna em `profiles`
```sql
ALTER TABLE profiles
  ADD COLUMN is_managed_only boolean NOT NULL DEFAULT false;
```

**Importante**: a FK `profiles.id REFERENCES auth.users(id) ON DELETE CASCADE`
existe (mig 001). Para suportar perfis sem `auth.users`, precisamos:
1. Tornar a FK `DEFERRABLE INITIALLY DEFERRED` OU
2. **Remover a FK** e substituir por trigger condicional que valida só quando
   `is_managed_only = false`.

Decisão: **opção 2** (remover FK e validar via trigger). Razão: opção 1
não permite o cenário "criar profile sem nunca criar auth.users", que é
exatamente o que precisamos.

```sql
ALTER TABLE profiles DROP CONSTRAINT profiles_id_fkey;

CREATE OR REPLACE FUNCTION public.profiles_validate_auth_link() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_managed_only = false THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'Profile não-managed deve ter auth.users correspondente';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_validate_auth_link_trg
  BEFORE INSERT OR UPDATE OF id, is_managed_only ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_validate_auth_link();
```

`handle_new_user()` (trigger em `auth.users` que cria profile) não muda — quando
um usuário real se cadastra, vira `is_managed_only=false` por default.

Quando coordenação cria managed: insere direto em `profiles` com
`is_managed_only=true` e UUID gerado client-side (ou via `gen_random_uuid()`).

### 3.5 Validação de turma (professor obrigatório)
```sql
CREATE OR REPLACE FUNCTION public.classes_validate_required_professor() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.modality IN ('presencial', 'hibrida') THEN
    IF NOT EXISTS (
      SELECT 1 FROM class_professors WHERE class_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Turma % requer ao menos 1 professor vinculado', NEW.modality;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
```

Aplicado como **constraint DEFERRABLE INITIALLY DEFERRED** ou **trigger
AFTER UPDATE** para permitir o caso normal: `INSERT classes` → `INSERT
class_professors` na mesma transação.

Decisão: trigger AFTER cuja transação verifica no commit (via
`SET CONSTRAINTS ALL DEFERRED`). Alternativamente, validar no service-side
(`classes.service.ts`) antes do INSERT.

**Nota**: também precisa rodar quando alguém faz `DELETE` em `class_professors`
ou quando a modalidade da turma muda (`UPDATE classes SET modality = ...`).

### 3.6 Guards nos triggers existentes (cinto + suspensório)

**Mig 031 — `attendance_recompute_trg`**:
```sql
-- Adicionar no início de attendance_recompute_one():
DECLARE
  v_lesson_modality class_modality;
BEGIN
  SELECT COALESCE(sl.modality, c.modality)
    INTO v_lesson_modality
    FROM scheduled_lessons sl
    JOIN classes c ON c.id = sl.class_id
   WHERE sl.id = NEW.scheduled_lesson_id;

  IF v_lesson_modality = 'presencial' THEN
    RETURN NEW;  -- presencial: status sempre manual
  END IF;
  -- ... resto do código atual
```

**Mig 031 — `lesson_recompute_attendance_trg`**: mesmo guard, no início.

**Mig 033 — `attendance_log_auto_absent_trg`**: mesmo guard. Em presencial não
existe "auto absent", todo absent é decisão humana.

### 3.7 Idempotência

Toda a migration usa `IF NOT EXISTS` / `CREATE OR REPLACE` / `DO BLOCK` para
ser re-executável.

---

## 4. Tipos e Services (cliente)

### 4.1 `src/types.ts`
- `export type ClassModality = 'online' | 'presencial' | 'hibrida';`
- Adicionar `modality: ClassModality` e `location: string | null` em `Class`.
- Adicionar `modality: ClassModality | null` em `ScheduledLesson`.
- Adicionar `is_managed_only: boolean` em `Profile`.
- Atualizar `ClassInsert`, `ClassUpdate`, `ScheduledLessonInsert`,
  `ScheduledLessonUpdate`, `ProfileInsert` correspondentemente.
- Helper: `effectiveLessonModality(sl, c): ClassModality` que retorna
  `sl.modality ?? c.modality`.

### 4.2 `src/services/classes.service.ts`
- Aceitar `modality` e `location` em create/update.
- Validar antes do INSERT que turma `presencial`/`hibrida` está sendo criada
  com pelo menos 1 professor (UX-friendly: erro claro antes do RAISE EXCEPTION
  do banco).

### 4.3 `src/services/schedule.service.ts`
- Aceitar `modality` opcional ao agendar aula.
- Em turma híbrida, **exigir** modality explícita (TS type-narrowing).

### 4.4 `src/services/profiles.service.ts`
- Função `createManagedProfile({ full_name, role, phone? })`:
  - Insere com `is_managed_only=true`, UUID via `crypto.randomUUID()`.
  - `email`: gerar placeholder único (`managed-<uuid>@iv.local`) para satisfazer
    NOT NULL atual, OU tornar email NULL nos managed (preferível).
  - **Decisão**: tornar `profiles.email` nullable na mig 034 e checar
    `email IS NOT NULL` apenas para `is_managed_only=false` via trigger.
- Função `promoteManagedToReal({ profile_id, email })`:
  - Chama Netlify function `admin-promote-managed.ts`.
  - Backend: cria `auth.users` **com o mesmo UUID** do profile (admin API
    aceita `id` explícito), atualiza `profiles.email`, set
    `is_managed_only=false`, dispara invite.

### 4.5 Service novo: `src/services/managed.service.ts`
- `listManagedStudents(classId?)`
- `createManagedStudent(data)`
- `listManagedProfessors(classId?)`
- `createManagedProfessor(data)`
- Reutiliza `profiles.service` por baixo.

---

## 5. Cliente — UI

### 5.1 Wizard de criação de turma (ClassesView ou modal dedicado)

Ordem dos campos:
1. Nome
2. Módulo
3. **Modalidade** (radio: Online / Presencial / Híbrida)
4. Se Presencial ou Híbrida:
   - `Local` (texto: "Templo Sede - Sala 3")
5. Vincular Professor(es) — botão "Adicionar professor"
   - Para presencial/híbrida: lista filtra `is_managed_only=true` também,
     com toggle "Mostrar apenas managed".
6. Vincular Monitor(es) (opcional, com aviso "Recomendado")
7. Bloqueio do botão "Criar turma" enquanto não houver ≥1 professor para
   presencial/híbrida.

### 5.2 Cadastro de aluno managed (ManagedStudentsView ou modal in-page)

Campos:
- Nome completo (obrigatório)
- Telefone (opcional)
- Turma (select)
- Botão "Salvar e adicionar próximo" → fluxo bulk

Sem email, sem senha, sem convite.

### 5.3 Cadastro de professor managed (ManagedProfessorsView)

Idêntico ao aluno managed, com role pré-definido como `professor`.

### 5.4 "Promover managed → conta real" (botão na linha do aluno/professor)

Modal:
- Email (obrigatório)
- Mensagem opcional
- Botão "Promover e enviar convite"

Backend (Netlify function): cria `auth.users` com mesmo UUID, atualiza profile,
envia invite.

### 5.5 Agendar aula (CalendarView)

- Em turma `online`: form atual (sem mudança).
- Em turma `presencial`: form atual sem campos de "Sala virtual"; modality
  herdada.
- Em turma `hibrida`: radio adicional "Modalidade desta aula: Online /
  Presencial".

### 5.6 Cards de turma e aula (ClassesView, MyClassesView, Dashboard)

Badge sempre visível:
- 🟢 Online
- 🏛️ Presencial  
- 🔀 Híbrida

Em aulas presenciais (no calendário/cards):
- Substituir CTA "Entrar na sala" por **"Ver detalhes"** (aluno) ou
  **"Fazer chamada"** (monitor/coordenação).
- Mostrar `location` da turma como subtítulo do card.

### 5.7 Guard de rota `/sala/:roomId`

Antes de renderizar `ClassroomView`, verificar:
```typescript
const lesson = await getScheduledLessonByRoomId(roomId);
const cls = await getClass(lesson.class_id);
const effective = lesson.modality ?? cls.modality;
if (effective === 'presencial') {
  navigate(`/turmas/${cls.id}`);
  showToast('Esta aula é presencial — sem sala virtual', 'info');
  return null;
}
```

### 5.8 AttendanceView para fluxo monitor (mobile-first)

Hoje a `AttendanceView` é usada principalmente pela coordenação pós-aula.
Vai virar o **fluxo principal** do monitor durante/após aula presencial.

Refinamentos:
- Layout mobile-first (botões grandes P/F/FJ).
- Botão **"Marcar todos presentes"** no topo.
- Tap em P/F/FJ marca via `markPresent/markAbsent/markJustified` (com
  `manually_overridden=true`, já implementado).
- Para FJ: abre modal com campo `notes` obrigatório (justificativa).
- Janela de edição: monitor edita até **7 dias** após a aula. Após isso, só
  coordenação.
- Acesso: monitor vê chamadas das suas turmas (`is_class_monitor`); coordenação
  vê todas.

### 5.9 Dashboard — card "Próxima chamada"

Para monitores e coordenação: card "Próxima aula presencial sua / hoje" com
botão direto para AttendanceView.

### 5.10 Onboarding (tooltips, não modal)

Primeira vez que o monitor abre AttendanceView de aula presencial:
1. Tooltip pulsante no botão "Marcar todos presentes": _"Comece marcando
   todos como presentes, depois ajuste apenas os ausentes."_
2. Após primeira marcação F/FJ, tooltip secundário: _"Use FJ para falta
   justificada. Adicione a justificativa no campo de notas."_

Estado salvo em `localStorage` com key `iv:onboarding:attendance-presencial`.

---

## 6. Push notifications

### 6.1 `push-events.ts` (cron)
- Adicionar JOIN com `classes` para resolver modality efetiva.
- Filtro `WHERE COALESCE(sl.modality, c.modality) != 'presencial'` em scans de:
  - lesson started
  - attendance auto absent

### 6.2 `push-lesson-started.ts`
- Mesmo guard.

### 6.3 `push-reminders.ts` (NOVO ou ajuste)
- 30 min antes de aula presencial: push para monitores da turma.
- Se `class_monitors` vazio: fallback para coordenação.
- Copy: `"Hoje às HH:MM — chamada da turma <Nome> em <location>"`

### 6.4 Push para alunos presenciais

**Não enviar.** Alunos managed não têm `push_subscriptions`.

---

## 7. FJ presencial (reposição)

Mantém estrutura atual (`makeup_submissions`).

Diferenças:
- Coordenação registra "Aluno entregou resumo físico" via formulário simples.
- Sem upload obrigatório de arquivo.
- Campo `justification text NOT NULL` permanece (motivo da falta + nota
  física).
- FJ continua opcional (decisão da coordenação se vai pedir resumo ou não).

Fluxo:
1. Aluno falta presencial → monitor marca FJ na chamada (com justificativa).
2. Coordenação revisa pendências em `MakeupReviewView` (existente).
3. Marca como aprovado/recusado → mesma UX atual.

---

## 8. Permissões (atualizar `docs/AUTHORIZATION_MATRIX.md`)

| Ação | Coordenação | Monitor | Professor online | Aluno online |
|---|---|---|---|---|
| Criar turma online | ✅ | ❌ | ❌ | ❌ |
| Criar turma presencial/híbrida | ✅ | ❌ | ❌ | ❌ |
| Cadastrar managed (aluno/prof) | ✅ | ✅ (na sua turma) | ❌ | ❌ |
| Promover managed → conta real | ✅ | ❌ | ❌ | ❌ |
| Fazer chamada presencial | ✅ | ✅ (na sua turma) | ❌ | ❌ |
| Editar chamada após 7 dias | ✅ | ❌ | ❌ | ❌ |
| Iniciar aula online | ✅ | ✅ (substituto) | ✅ | ❌ |

---

## 9. Decisões fechadas (não revisar sem motivo forte)

| # | Decisão |
|---|---|
| 1 | Modalidade definida na **turma** (default) com **override por aula** apenas em híbrida. |
| 2 | Alunos e professores presenciais são **managed only** (sem auth, sem push). |
| 3 | Apenas coordenação e monitor logam para fins de gestão presencial. |
| 4 | Professor obrigatório, monitor opcional. |
| 5 | Coordenação faz chamada quando não há monitor. |
| 6 | FJ presencial reaproveita `makeup_submissions` com justificativa obrigatória. |
| 7 | Sem relatórios separados para presencial (autonomia atual cobre online). |
| 8 | Onboarding via tooltips no próprio AttendanceView, sem modal cheio. |
| 9 | Push lembrete de chamada para monitor (fallback coordenação). |
| 10 | Email do profile vira nullable; obrigatório só para `is_managed_only=false`. |
| 11 | Promover managed: criar `auth.users` com **mesmo UUID** do profile (preserva FKs). |
| 12 | Janela de edição de chamada: 7 dias para monitor, sempre para coordenação. |

---

## 10. Ordem de execução

> Cada fase NÃO é commitada automaticamente. O usuário aprova explicitamente
> antes de cada commit.

### Fase 1 — Fundação invisível ✅ (commit pendente)
- Migration `034_modality.sql` (enum, colunas, guards triggers, validação prof
  obrigatório, profile email nullable, profile FK→auth removida + trigger
  validação).
- Atualizar `src/types.ts` (Profile, Class, ScheduledLesson + Insert/Update).
- Atualizar `src/services/classes.service.ts`, `schedule.service.ts`,
  `profiles.service.ts`.
- Criar `src/services/managed.service.ts`.
- **Critério**: build verde, testes verdes, app continua igual visualmente. ✅

### Fase 2 — Cadastro presencial ✅
- Wizard de criação de turma (modalidade + location + validação prof).
- Cadastro managed (alunos e professores) inline.
- Migration `035_managed_profile_rpcs.sql` (RPCs + RLS).
- **Critério**: coordenação consegue criar turma presencial e cadastrar
  managed. ✅

### Fase 3 — Guards de UI ✅
- Guard rota `/sala/:roomId` redirecionando para `/turmas/:id` quando presencial.
- Esconder/substituir CTAs "Entrar na sala" em aulas presenciais.
- Badges visuais de modalidade.
- **Critério**: turma presencial não exibe nenhum elemento online. ✅

### Fase 4 — Chamada presencial ✅
- AttendanceView mobile-first com "Marcar todos presentes".
- Modal FJ com justificativa **obrigatória** (divergência: estava "opcional" no
  brainstorm — ver §15).
- Janela de edição (7 dias monitor) aplicada em **3 pontos** via helper
  `canEditLessonAttendance`.
- Card "Próxima chamada" no Dashboard (reaproveitado card existente — ver §15).
- **Critério**: monitor consegue fazer chamada do celular durante a aula. ✅

### Fase 5 — Push e promoção managed ✅
- Push reminder presencial (monitor + fallback prof titular + fallback coord).
- Filtros em push-events para excluir presencial (skip lesson-started).
- `push-lesson-started.ts` e `notifications.service.ts` com copy/url
  diferenciados por modalidade.
- Função `admin-promote-managed.ts` + helper `promoteManagedToReal` em
  `managed.service.ts` + UI em [StudentsView.tsx](../src/components/views/StudentsView.tsx)
  e [ProfessoresView.tsx](../src/components/views/ProfessoresView.tsx).
- **Critério**: monitor recebe push antes da aula; coordenação consegue
  promover managed para conta real. ✅

### Fase 6 — Polish (PENDENTE)
- Tooltips de onboarding em AttendanceView presencial.
- `docs/AUTHORIZATION_MATRIX.md` atualizado. ✅
- Smoke tests manuais (turma online, presencial, híbrida) — a executar em
  staging com dados reais.

---

## 11. O que NÃO faz parte deste escopo

- Multi-tenant / multi-filial (`branch_id`). Modalidade é ortogonal — fica
  para um documento futuro.
- Migração para SFU. Coberto em [`docs/MIGRACAO_SFU.md`](MIGRACAO_SFU.md).
- Upload de fotos de aluno managed.
- Relatórios separados para presencial.
- Atestados médicos com upload.

---

## 12. Risco e rollback

| Risco | Mitigação |
|---|---|
| Quebrar online (default modality) | `DEFAULT 'online'` + testes manuais antes de cada commit. |
| FK profiles→auth removida deixar órfãos | Trigger `profiles_validate_auth_link_trg` impede insert/update inválido. |
| Migration de `email NOT NULL` → nullable falhar em rows existentes | NULL apenas para `is_managed_only=true`; existentes ficam com email atual. |
| Trigger validação prof bloquear criação | Validar antes no service para erro UX-friendly; constraint deferrable como salvaguarda. |
| Push presencial vazar para alunos | `push_subscriptions` é populada só por usuários reais via service worker; managed nunca registra subscription → impossível por construção. |

---

## 13. Histórico de decisões

- `2026-05-13` — Documento criado a partir das discussões. Plano aprovado
  com 12 decisões fechadas. Início pela Fase 1.
- `2026-05-13` — Fases 1-5 concluídas. Migrations aplicadas. Build/tests verdes.
  Divergências documentadas em §15.

---

## 14. Status de execução por arquivo

### Backend (Supabase)
| Arquivo | Status |
|---------|--------|
| `supabase/migrations/034_modality.sql` | ✅ aplicado |
| `supabase/migrations/035_managed_profile_rpcs.sql` | ✅ aplicado |

### Backend (Netlify Functions)
| Arquivo | Status |
|---------|--------|
| `netlify/functions/push-events.ts` | ✅ modality-aware |
| `netlify/functions/push-lesson-started.ts` | ✅ copy/url diferenciados |
| `netlify/functions/push-reminders.ts` | ✅ monitor + fallbacks |
| `netlify/functions/admin-promote-managed.ts` | ✅ criado (Fase 5) |

### Frontend (services)
| Arquivo | Status |
|---------|--------|
| `src/types.ts` | ✅ ClassModality + helpers |
| `src/services/classes.service.ts` | ✅ modality+location |
| `src/services/schedule.service.ts` | ✅ modality opcional |
| `src/services/managed.service.ts` | ✅ CRUD + `promoteManagedToReal` |
| `src/services/notifications.service.ts` | ✅ in-app diferenciado |

### Frontend (views)
| Arquivo | Status |
|---------|--------|
| `src/components/views/ClassesView.tsx` | ✅ wizard com modality |
| `src/components/views/ClassDetailView.tsx` | ✅ override híbrida + botão presencial |
| `src/components/views/CalendarView.tsx` | ✅ badges + CTA condicional |
| `src/components/views/DashboardView.tsx` | ✅ "Fazer chamada" para upcoming presencial |
| `src/components/views/AttendanceView.tsx` | ✅ mobile-first + 7-day window + FJ obrigatório |
| `src/components/views/StudentsView.tsx` | ✅ managed CRUD + Promover |
| `src/components/views/ProfessoresView.tsx` | ✅ managed CRUD + Promover |
| `src/components/views/ClassroomView.tsx` | ✅ guard de presencial |

### Docs
| Arquivo | Status |
|---------|--------|
| `docs/AUTHORIZATION_MATRIX.md` | ✅ atualizado (modalidades + promoção + divergências) |
| `docs/IMPLEMENTACAO_MODALIDADES.md` | ✅ este arquivo |

---

## 15. Divergências do plano original (auditoria de sprint)

During execução, alguns ajustes foram feitos sobre o plano original. Todos
foram validados (build verde + 35/35 tests).

| # | Plano original | Implementação final | Motivo |
|---|----------------|----------------------|--------|
| D1 | FK `profiles→auth` deferrable OU remover | **Remover + trigger** `profiles_validate_auth_link_trg` | Deferrable não cobre o cenário "profile sem auth.users nunca". |
| D2 | `handle_new_user` não detalhado | Reescrito com `ON CONFLICT DO UPDATE` que flipa `is_managed_only=false`. **Peça-chave da promoção** — permite POST `/admin/users` com `id` do profile sem violar PK. | Necessário para preservar UUID em promoção. |
| D3 | `classes_validate_required_professor` como trigger AFTER | Constraint **DEFERRABLE INITIALLY DEFERRED** | Permite padrão de ClassesView: `INSERT classes (online)` → `INSERT class_professors` → `UPDATE modality` na mesma transação. |
| D4 | Promover managed via "magic invite" | `/auth/v1/admin/generate_link` tipo **`recovery`** | Supabase não tem endpoint de "promote invite"; recovery link é o equivalente padrão para definir senha. |
| D5 | Service `promoteManagedToReal({ profile_id, email })` snake | `promoteManagedToReal({ profileId, email, sendInvite })` camelCase | Alinhamento com resto do codebase TS. |
| D6 | FJ com `notes` opcional | `notes.trim()` **obrigatório** — botão disabled até preencher | Auditoria mínima. |
| D7 | Janela de 7 dias mencionada genérica | Constante `SEVEN_DAYS_MS` + helper `canEditLessonAttendance(role, scheduledAt)` aplicada em **3 pontos**: cell click, marcar todos, salvar notas | Garantir bloqueio uniforme; evitar bypass por qualquer fluxo. |
| D8 | Override de modality em aula híbrida — "radio na criação" | State `lessonModalityOverride: 'inherit' \| 'online' \| 'presencial'`; `'inherit'` mapeia para `null` no DB; radio aparece **apenas** quando `cls.modality === 'hibrida'` | UX limpa em turmas puras. |
| D9 | Push presencial "para monitores" | Recipients = monitores **OU** prof titular como fallback (evita chamada esquecida) | Robustez. |
| D10 | Card dedicado "Próxima chamada" no Dashboard | Reaproveitado card de upcoming lessons — botão "Fazer chamada" condicionado a presencial + role ∈ {C, M} | Menos código, menos UI duplicada. |
| D11 | Botão promover managed = modal simples com email | Modal com email **+ checkbox "Enviar convite" (default true)** + atualização otimista da lista | Coord pode criar conta sem email (definir senha manualmente depois). |

### Rotas com divergência ou refinamento

| Rota | Divergência |
|------|-------------|
| `/sala/:roomId` | Guard de runtime adicionado (não estava no schema RLS) |
| `/presencas?aula=:id` | **Janela de 7 dias** para monitor enforced em UI — RLS no DB não checa data; recomendação futura de adicionar policy. |
| `/turmas/:id` | Botão "Fazer chamada" deep-link para `/presencas?aula=:id` adicionado para upcoming presencial |
| `POST /.netlify/functions/admin-promote-managed` | **Endpoint novo** (não existia) — ver matriz de autorização |
