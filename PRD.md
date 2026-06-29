# PRD — Plataforma IV (LMS Education Platform)

**Versão**: 1.0
**Data**: 2026-04-13
**Status**: Aprovado para implementação

---

## 1. Visão Geral

### 1.1 Produto
Plataforma web de ensino online para o LMS Education Platform (IV) da Client Organization (ORG). Sistema de gestão acadêmica com salas de aula virtuais por videoconferência, controle de presenças, calendário de aulas e gestão de turmas/alunos.

### 1.2 Contexto
O IV é uma escola de capacitação de futuros líderes de células da ORG, com foco em estudo bíblico, desenvolvimento de caráter cristão e liderança. Atualmente possui ~20 alunos com aulas presenciais e online. A plataforma visa formalizar e organizar as aulas online com tracking completo.

### 1.3 Objetivos
- Disponibilizar aulas online via videoconferência integrada
- Rastrear início, duração, participantes e interações de cada aula
- Gerar relatórios de presenças, faltas e acompanhamento semanal
- Manter calendário de aulas com horários e professores
- Controle de acesso por papéis: Coordenação, Professor, Aluno

### 1.4 Público-alvo
- **Coordenação** (1-3 pessoas): Administram toda a plataforma
- **Professores** (3-5): Ministram aulas e controlam presença
- **Alunos** (~20): Assistem aulas e acompanham progresso

---

## 2. Arquitetura Técnica

### 2.1 Stack
| Camada | Tecnologia |
|--------|-----------|
| Frontend | React 19 + Vite + TypeScript |
| Estilo | Tailwind CSS v4 + tailwind-merge + clsx |
| Animações | motion/react (Framer Motion) |
| Ícones | Lucide React |
| Auth + DB | Supabase (Postgres + Auth + RLS + JWT + Realtime) |
| Vídeo | WebRTC mesh via Socket.IO (portado do vox_transc) |
| Servidor | Express + Socket.IO (sinalização WebRTC apenas) |

### 2.2 Decisões Arquiteturais
- **Projeto separado** (`iv_platform/`) — isolado do vox_transc
- **Supabase real desde o início** — .env placeholders até credenciais disponíveis
- **Mobile-first** — design responsivo com prioridade para smartphones (uso majoritário)
- **WebRTC mesh** — adequado para <20 participantes, controle total
- **RLS (Row Level Security)** — segurança no nível do banco, não apenas no frontend

### 2.3 Reuso do vox_transc
| Origem | Destino | Adaptação |
|--------|---------|-----------|
| `ConferenceView.tsx` (~800 linhas) | `ClassroomView.tsx` | Remove features de IA (onStartAI, onStopAI, isAIActive). Adiciona auto-presença (join→present, leave→duration). Layout mobile-first. Professor=host automático. |
| `server.ts` (Socket.IO signaling) | `server.ts` | Mantém relay WebRTC (offer/answer/ICE/peer-state/disconnect). Remove rotas de API keys e sessions. Adiciona webhook de attendance no disconnect. |
| `ErrorBoundary.tsx` | Cópia direta | Rebrand mensagens |
| `lib/utils.ts` (cn) | Cópia direta | Nenhuma |
| `index.css` (estrutura tema) | Rebranding | Dark theme mantido, cores adaptadas para IV |
| Sidebar pattern (App.tsx) | `Layout.tsx` | Menu responsivo baseado em role, drawer mobile |

---

## 3. Design & UX

### 3.1 Tema Visual
- **Base**: Dark modern (similar ao vox_transc)
- **Background**: `#0f1117` (dark navy)
- **Cards**: `#1a1d27` (dark slate)
- **Texto**: `#ffffff` (primário), `#8e9299` (muted)
- **Accent geral**: `#6366f1` (indigo — identidade IV)
- **Fontes**: Inter (sans), JetBrains Mono (monospace/dados)
- **Glass morphism**: Painéis com backdrop-blur e bordas semi-transparentes

### 3.2 Cores dos Módulos
Cada módulo possui cor temática aplicada em: badges, cards de módulo, headers de aula, indicadores de progresso.

| Módulo | Cor Principal | Cor BG suave | Referência |
|--------|--------------|-------------|-----------|
| 1° Módulo | `#3b82f6` (blue-500) | `#1e3a5f` | Logo IV fundo azul |
| 2° Módulo | `#22c55e` (green-500) | `#1a4731` | Logo IV fundo verde |
| 3° Módulo | `#ef4444` (red-500) | `#5f1a1a` | Logo IV fundo vermelho |

### 3.3 Responsividade (Mobile-First)
- **Breakpoints**: `sm: 640px`, `md: 768px`, `lg: 1024px`
- **Sidebar**: Drawer overlay no mobile (hamburger menu), fixa no desktop
- **Video grid**: Stack vertical no mobile (1 col), grid no desktop
- **Self video**: PiP (picture-in-picture) flutuante no mobile
- **Controles de sala**: Bottom bar fixo no mobile (mute, camera, leave)
- **Tabelas**: Cards empilhados no mobile, tabela no desktop
- **Calendário**: Lista de agenda no mobile, grid semana/mês no desktop
- **Touch targets**: Mínimo 44x44px para todos botões interativos

### 3.4 Layout Responsivo

**Mobile (< 768px)**:
```
┌─────────────────────┐
│ Topbar (logo+menu)  │
├─────────────────────┤
│                     │
│    Content Area     │
│    (full width)     │
│                     │
├─────────────────────┤
│ Bottom Nav (5 itens)│
└─────────────────────┘
```

**Desktop (≥ 1024px)**:
```
┌────┬──────────────────────┐
│    │ Topbar               │
│ S  ├──────────────────────┤
│ I  │                      │
│ D  │   Content Area       │
│ E  │                      │
│ B  │                      │
│ A  │                      │
│ R  │                      │
└────┴──────────────────────┘
```

### 3.5 Layout da Sala de Aula (Mobile)
```
┌─────────────────────┐
│ Professor (destaque) │  ← vídeo grande
├──────┬──────┬───────┤
│ Aluno│Aluno │ Aluno │  ← grid scroll horizontal
├──────┴──────┴───────┤
│ [Self PiP flutuante]│  ← draggable, pequeno
├─────────────────────┤
│ 🎤  📷  🚪 Leave    │  ← bottom bar fixo
└─────────────────────┘
```

---

## 4. Papéis & Permissões

### 4.1 Definição de Papéis

| Papel | Descrição | Código |
|-------|-----------|--------|
| **Coordenação** | Administrador geral. Gerencia módulos, turmas, professores, alunos. | `coordenacao` |
| **Professor** | Ministra aulas. Controla presença nas suas turmas. | `professor` |
| **Aluno** | Assiste aulas. Visualiza próprio progresso e presenças. | `aluno` |

### 4.2 Matriz de Permissões

| Recurso | Coordenação | Professor | Aluno |
|---------|:-----------:|:---------:|:-----:|
| Dashboard (stats globais) | ✅ | ❌ | ❌ |
| Dashboard (suas turmas/aulas) | ✅ | ✅ | ✅ |
| Calendário (todas turmas) | ✅ | ❌ | ❌ |
| Calendário (suas turmas) | ✅ | ✅ | ✅ |
| Entrar sala de aula | ✅ | ✅ | ✅ |
| Encerrar sala (host) | ✅ | ✅ | ❌ |
| Módulos & Aulas (CRUD) | ✅ | ❌ | ❌ |
| Turmas (CRUD) | ✅ | ❌ | ❌ |
| Matrículas (CRUD) | ✅ | ❌ | ❌ |
| Marcar presença | ✅ | ✅ | ❌ |
| Justificar falta | ✅ | ✅ | ❌ |
| Ver presenças (todas turmas) | ✅ | ❌ | ❌ |
| Ver presenças (suas turmas) | ✅ | ✅ | ❌ |
| Ver próprias presenças | ✅ | ✅ | ✅ |
| Gerenciar alunos/professores | ✅ | ❌ | ❌ |
| Alterar roles de usuários | ✅ | ❌ | ❌ |
| Editar próprio perfil | ✅ | ✅ | ✅ |

---

## 5. Database Schema (Supabase Postgres)

### 5.1 Enums

```sql
CREATE TYPE user_role AS ENUM ('coordenacao', 'professor', 'aluno');
CREATE TYPE enrollment_status AS ENUM ('active', 'completed', 'dropped');
CREATE TYPE class_status AS ENUM ('active', 'completed', 'cancelled');
CREATE TYPE lesson_status AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');
CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'justified');
```

### 5.2 Tables

#### profiles
Sincronizado automaticamente com `auth.users` via database trigger.

| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK, FK → auth.users.id ON DELETE CASCADE |
| email | text | NOT NULL |
| full_name | text | NOT NULL |
| avatar_url | text | |
| role | user_role | NOT NULL DEFAULT 'aluno' |
| phone | text | |
| created_at | timestamptz | DEFAULT now() |
| updated_at | timestamptz | DEFAULT now() |

#### modules

| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK DEFAULT gen_random_uuid() |
| name | text | NOT NULL |
| description | text | |
| color | text | NOT NULL (hex color) |
| order_index | int | NOT NULL |
| created_at | timestamptz | DEFAULT now() |

#### lessons

| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK DEFAULT gen_random_uuid() |
| module_id | uuid | FK → modules.id ON DELETE CASCADE |
| title | text | NOT NULL |
| description | text | |
| order_index | int | NOT NULL |
| created_at | timestamptz | DEFAULT now() |

#### classes (turmas)

| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK DEFAULT gen_random_uuid() |
| name | text | NOT NULL |
| module_id | uuid | FK → modules.id |
| professor_id | uuid | FK → profiles.id |
| status | class_status | DEFAULT 'active' |
| created_at | timestamptz | DEFAULT now() |

#### enrollments (matrículas)

| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK DEFAULT gen_random_uuid() |
| class_id | uuid | FK → classes.id ON DELETE CASCADE |
| student_id | uuid | FK → profiles.id |
| status | enrollment_status | DEFAULT 'active' |
| enrolled_at | timestamptz | DEFAULT now() |
| | | UNIQUE(class_id, student_id) |

#### scheduled_lessons (aulas agendadas)

| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK DEFAULT gen_random_uuid() |
| class_id | uuid | FK → classes.id ON DELETE CASCADE |
| lesson_id | uuid | FK → lessons.id |
| scheduled_at | timestamptz | NOT NULL |
| duration_minutes | int | DEFAULT 60 |
| room_id | text | (UUID, gerado ao abrir sala) |
| status | lesson_status | DEFAULT 'scheduled' |
| started_at | timestamptz | |
| ended_at | timestamptz | |
| notes | text | |
| created_at | timestamptz | DEFAULT now() |

#### attendance (presenças)

| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | PK DEFAULT gen_random_uuid() |
| scheduled_lesson_id | uuid | FK → scheduled_lessons.id ON DELETE CASCADE |
| student_id | uuid | FK → profiles.id |
| status | attendance_status | DEFAULT 'absent' |
| joined_at | timestamptz | |
| left_at | timestamptz | |
| duration_seconds | int | |
| marked_by | uuid | FK → profiles.id (professor/coord que marcou) |
| notes | text | |
| | | UNIQUE(scheduled_lesson_id, student_id) |

### 5.3 Indexes
- `idx_lessons_module` ON lessons(module_id)
- `idx_classes_module` ON classes(module_id)
- `idx_classes_professor` ON classes(professor_id)
- `idx_enrollments_class` ON enrollments(class_id)
- `idx_enrollments_student` ON enrollments(student_id)
- `idx_scheduled_lessons_class` ON scheduled_lessons(class_id)
- `idx_scheduled_lessons_date` ON scheduled_lessons(scheduled_at)
- `idx_attendance_lesson` ON attendance(scheduled_lesson_id)
- `idx_attendance_student` ON attendance(student_id)

### 5.4 RLS Policies

**profiles**:
- SELECT: qualquer usuário autenticado
- UPDATE: próprio perfil OU role = 'coordenacao'
- INSERT: via trigger apenas

**modules / lessons**:
- SELECT: qualquer autenticado
- INSERT/UPDATE/DELETE: role = 'coordenacao'

**classes**:
- SELECT: qualquer autenticado
- INSERT/UPDATE/DELETE: role = 'coordenacao'

**enrollments**:
- SELECT: coordenacao = todos; professor = turmas onde é professor; aluno = próprias matrículas
- INSERT/UPDATE/DELETE: role = 'coordenacao'

**scheduled_lessons**:
- SELECT: coordenacao = todos; professor = turmas onde é professor; aluno = turmas onde está matriculado
- INSERT/UPDATE: coordenacao + professor (suas turmas)
- DELETE: coordenacao apenas

**attendance**:
- SELECT: coordenacao = todos; professor = turmas onde é professor; aluno = próprios registros
- INSERT/UPDATE: coordenacao + professor (turmas onde é professor)

### 5.5 Database Trigger

```sql
-- Cria perfil automaticamente quando um usuário se registra
CREATE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'aluno')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
```

### 5.6 Seed Data (Módulos e Aulas)

#### 1° Módulo (Azul — #3b82f6)
| # | Aula |
|---|------|
| 1 | Enfrentando o dia a dia I – Vida Social e Música |
| 2 | Enfrentando o dia a dia II – Vencendo as tentações |
| 3 | A arma do cristão I – Bíblia |
| 4 | A arma do cristão II – Oração e Jejum |
| 5 | As características de Deus |
| 6 | DEUS X PECADO – A obra redentora da cruz e o poder do nome de Jesus |
| 7 | O desenvolvimento da fé com a condução do Espírito Santo |
| 8 | Fé (Dízimo e ofertas) |
| 9 | Obediência |
| 10 | Benção e maldição |
| 11 | Guerra Espiritual – A armadura de Deus |
| 12 | A importância da casa de Deus |

#### 2° Módulo (Verde — #22c55e)
| # | Aula |
|---|------|
| 1 | Projeto de Deus x Decisão do homem |
| 2 | Caráter deformado: Mente distorcida |
| 3 | Caráter deformado: Emoções descontroladas |
| 4 | Caráter deformado: Vã maneira de viver |
| 5 | Caráter em construção: Valores organizados |
| 6 | O perfil do caráter cristão |
| 7 | Ser humano: Conceitos e a importância da cura da alma |
| 8 | Jesus o grande conselheiro |
| 9 | Instrumento da cura da alma |
| 10 | Como melhorar seus sentimentos |
| 11 | O verdadeiro amor |
| 12 | (Avaliação / Encerramento) |

#### 3° Módulo (Vermelho — #ef4444)
| # | Aula |
|---|------|
| 1 | Desenvolvendo o seu talento |
| 2 | Paixão pelo perdido |
| 3 | O chamado |
| 4 | TAC |
| 5 | A batalha pessoal do líder de células |
| 6 | A batalha de levar outros a Cristo |
| 7 | Escada do sucesso – Parte I |
| 8 | Escada do sucesso – Parte II |
| 9 | Construindo a aliança de discípulo |
| 10 | A mordomia do dinheiro no corpo de Cristo |
| 11 | Noções gerais e a força do louvor |
| 12 | A volta de Jesus |

---

## 6. Navegação & Views

### 6.1 Sidebar / Bottom Nav (por role)

| View | Ícone | Aluno | Professor | Coordenação | Rota |
|------|-------|:-----:|:---------:|:-----------:|------|
| Dashboard | LayoutDashboard | ✅ | ✅ | ✅ | `/` |
| Calendário | Calendar | ✅ | ✅ | ✅ | `/calendar` |
| Sala de Aula | Video | ✅ | ✅ | ✅ | `/classroom/:id` |
| Meu Perfil | User | ✅ | ✅ | ✅ | `/profile` |
| Turmas | Users | ❌ | ✅ | ✅ | `/classes` |
| Presenças | ClipboardCheck | ❌ | ✅ | ✅ | `/attendance` |
| Módulos | BookOpen | ❌ | ❌ | ✅ | `/modules` |
| Alunos | GraduationCap | ❌ | ❌ | ✅ | `/students` |

**Mobile bottom nav**: Mostra apenas 4-5 ícones principais por role. Overflow em "Mais" (•••).

### 6.2 Dashboard por Role

**Aluno**:
- Próximas aulas (hoje e amanhã)
- Frequência geral (% presença)
- Módulo atual + progresso
- Botão "Entrar na aula" (se aula ao vivo)

**Professor**:
- Próximas aulas que ministra
- Turmas ativas
- Presenças da última aula
- Alunos com baixa frequência

**Coordenação**:
- Stats gerais: total alunos, turmas ativas, aulas hoje
- Frequência geral do curso
- Últimas atividades
- Alertas (faltas recorrentes, aulas sem professor)

---

## 7. Funcionalidades Detalhadas

### 7.1 Autenticação
- **Registro**: Email + senha + nome completo (obrigatório)
- **Login**: Email + senha
- **Role padrão**: Todo novo registro é `aluno`. Coordenação promove manualmente.
- **JWT**: Supabase Auth gera JWT com user_id. RLS valida via `auth.uid()`.
- **Sessão**: Persistida no localStorage via Supabase client. Auto-refresh do token.

### 7.2 Módulos & Aulas (Coordenação)
- CRUD de módulos com nome, descrição, cor, ordem
- CRUD de aulas dentro de módulo com título, descrição, ordem
- Reordenação via drag-and-drop (stretching goal) ou setas
- Seed data populado via migration SQL

### 7.3 Turmas (Coordenação)
- Criar turma vinculada a um módulo + professor
- Matricular alunos na turma
- Ver lista de alunos matriculados
- Alterar status (active/completed/cancelled)

### 7.4 Calendário & Agendamento
- **Agendamento**: Coordenação ou professor agenda aulas (data/hora, turma, lição)
- **Visualização calendário**: Mês e semana (desktop), lista agenda (mobile)
- **Filtros**: Por turma, por professor, por módulo
- **Botão ação**: "Entrar na sala" quando aula está scheduled/in_progress

### 7.5 Sala de Aula Virtual (WebRTC)
- Entrar por `scheduled_lesson_id` — valida se o usuário é professor ou aluno matriculado
- Professor = host automático (controle de sala)
- Funcionalidades: mute, toggle camera, leave
- Host pode: mutar participante, remover participante
- Auto-attendance: student marked present on join, `joined_at` registrado
- Ao sair ou ser disconectado: `left_at` registrado, `duration_seconds` calculado
- Layout mobile-first: vídeo professor em destaque, peers em scroll horizontal, self como PiP

### 7.6 Presenças
- **Auto-tracking**: Presença registrada ao entrar na sala de aula
- **Manual**: Professor ou coordenação pode editar status (present/absent/justified)
- **Relatórios**: Por turma, por aluno, por período
- **Métricas**: % frequência, streak de presença, alertas de baixa frequência
- **Exportar**: (futuro) CSV/PDF

### 7.7 Perfil do Usuário
- Ver/editar nome, telefone, avatar
- Aluno vê: módulo atual, turma, histórico de presenças pessoal
- Professor vê: turmas que ministra, próximas aulas
- Coordenação vê: todas as informações

---

## 8. Estrutura de Arquivos

```
iv_platform/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── .env.example
├── server.ts                          # Express + Socket.IO signaling
│
├── supabase/
│   └── migrations/
│       ├── 001_initial_schema.sql     # Enums, tables, indexes, RLS
│       └── 002_seed_modules.sql       # 3 módulos + 36 aulas
│
├── src/
│   ├── main.tsx                       # React entry
│   ├── App.tsx                        # Router + AuthProvider + Layout
│   ├── index.css                      # Tailwind theme (IV dark)
│   ├── types.ts                       # All TS types
│   │
│   ├── lib/
│   │   ├── supabase.ts               # createClient()
│   │   ├── utils.ts                   # cn()
│   │   └── constants.ts              # Role labels, module colors, status maps
│   │
│   ├── contexts/
│   │   └── AuthContext.tsx            # AuthProvider + useAuth hook
│   │
│   ├── services/
│   │   ├── auth.service.ts           # signUp, signIn, signOut, onAuthStateChange
│   │   ├── profiles.service.ts       # getProfile, updateProfile, listByRole
│   │   ├── modules.service.ts        # CRUD modules + lessons
│   │   ├── classes.service.ts        # CRUD classes + enrollments
│   │   ├── schedule.service.ts       # CRUD scheduled_lessons + status transitions
│   │   └── attendance.service.ts     # CRUD attendance + reports/aggregations
│   │
│   ├── hooks/
│   │   ├── useProfile.ts             # Current user profile subscription
│   │   └── useRealtime.ts            # Supabase realtime subscription helper
│   │
│   ├── components/
│   │   ├── Layout.tsx                 # Sidebar (desktop) + BottomNav (mobile) + Topbar
│   │   ├── ProtectedRoute.tsx         # Role guard component
│   │   ├── Auth.tsx                   # Login/Register page
│   │   ├── ClassroomView.tsx          # WebRTC video classroom (port of ConferenceView)
│   │   │
│   │   ├── ui/
│   │   │   ├── ErrorBoundary.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── DataTable.tsx          # Responsive table → cards on mobile
│   │   │   ├── Calendar.tsx           # Week/month grid + mobile agenda
│   │   │   ├── StatusBadge.tsx        # Colored status pills
│   │   │   └── EmptyState.tsx         # Placeholder for empty lists
│   │   │
│   │   └── views/
│   │       ├── DashboardView.tsx      # Role-specific dashboard
│   │       ├── CalendarView.tsx       # Schedule view
│   │       ├── ModulesView.tsx        # Module + lesson CRUD
│   │       ├── ClassesView.tsx        # Class + enrollment management
│   │       ├── AttendanceView.tsx     # Mark attendance + reports
│   │       ├── StudentsView.tsx       # Student list + detail
│   │       └── ProfileView.tsx        # User profile + personal attendance
```

---

## 9. Fases de Implementação

### Fase 1: Scaffold + Schema (steps 1–6)
1. Criar `iv_platform/` com package.json, tsconfig.json, vite.config.ts, index.html
2. `npm install` deps: react, react-dom, @supabase/supabase-js, socket.io, socket.io-client, vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite, @tailwindcss/typography, lucide-react, motion, clsx, tailwind-merge, express, cors, typescript, @types/react, @types/react-dom, @types/express, @types/cors
3. Criar `supabase/migrations/001_initial_schema.sql` (enums, tables, indexes, RLS, trigger)
4. Criar `supabase/migrations/002_seed_modules.sql` (3 módulos + 36 aulas)
5. Criar `.env.example`, `src/lib/supabase.ts`, `src/lib/utils.ts`, `src/lib/constants.ts`
6. Criar `src/types.ts` (todos os tipos TS espelhando schema)

### Fase 2: Auth + Layout (steps 7–14, *depende Fase 1*)
7. `src/services/auth.service.ts` — Supabase Auth wrapper
8. `src/contexts/AuthContext.tsx` — AuthProvider + useAuth
9. `src/hooks/useProfile.ts` — perfil do usuário logado
10. `src/components/Auth.tsx` — tela Login/Registro responsiva
11. `src/index.css` — tema dark IV + module colors
12. `src/components/Layout.tsx` — sidebar desktop + bottom nav mobile + topbar
13. `src/components/ProtectedRoute.tsx` — role guard
14. `src/App.tsx` + `src/main.tsx` — roteamento + auth gate

### Fase 3: Services + Views (steps 15–26, *paralelo com Fase 4*)
15. `src/services/profiles.service.ts`
16. `src/services/modules.service.ts`
17. `src/services/classes.service.ts`
18. `src/services/schedule.service.ts`
19. `src/services/attendance.service.ts`
20. `src/components/views/DashboardView.tsx`
21. `src/components/views/ModulesView.tsx` + CRUD
22. `src/components/views/ClassesView.tsx` + enrollment management
23. `src/components/views/CalendarView.tsx`
24. `src/components/views/AttendanceView.tsx`
25. `src/components/views/StudentsView.tsx`
26. `src/components/views/ProfileView.tsx`

### Fase 4: Sala de Aula (steps 27–29, *paralelo com Fase 3*)
27. Port `server.ts` — Socket.IO WebRTC signaling
28. Port `ConferenceView` → `ClassroomView.tsx` (mobile-first, sem IA, com auto-attendance)
29. Integrar classroom com scheduled_lessons + attendance tracking

### Fase 5: Componentes UI (steps 30–36)
30. `src/components/ui/ErrorBoundary.tsx`
31. `src/components/ui/Modal.tsx`
32. `src/components/ui/DataTable.tsx` (responsive: table desktop / cards mobile)
33. `src/components/ui/Calendar.tsx` (grid desktop / agenda mobile)
34. `src/components/ui/StatusBadge.tsx`
35. `src/components/ui/EmptyState.tsx`
36. `src/lib/constants.ts` — labels, colors, maps

### Fase 6: Verificação (steps 37–41)
37. `npx tsc --noEmit` — zero erros TypeScript
38. `npm run dev` — app carrega, auth funciona
39. Teste: registro → login → dashboard por role
40. Teste: módulo → aula → turma → matrícula → agendamento
41. Teste mobile: acessar sala de aula, verificar layout responsivo

---

## 10. Escopo Excluído (Futuro)

| Feature | Prioridade | Motivo de exclusão |
|---------|-----------|-------------------|
| Chat na sala de aula | Média | Manter MVP simples |
| Levantamento de mão | Baixa | Não prioritário para <20 alunos |
| Compartilhamento de tela | Média | Complexidade WebRTC adicional |
| Upload de materiais/apostilas | Média | Requer storage Supabase |
| Sistema de notas/avaliações | Alta | Fase 2 do produto |
| Notificações push/email | Média | Requer infra adicional |
| App mobile nativo | Baixa | PWA via web é suficiente |
| Gravação de aulas | Média | Requer MediaRecorder + storage |
| Integração Google Calendar | Baixa | Nice-to-have |
| Relatórios PDF/CSV | Média | Fase 2 após validação |

---
