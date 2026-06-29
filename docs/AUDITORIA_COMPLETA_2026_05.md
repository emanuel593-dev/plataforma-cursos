# Auditoria Completa — Sistema IV  
**Data:** 18/05/2026  
**Escopo:** código + migrations efetivamente aplicadas no Supabase (`iqltmpkqudhtkfqgqfwl`)  
**Método:** cruzamento entre repositório local + queries diretas em `pg_proc`, `pg_policies`, `information_schema.triggers`, `schema_migrations` + verificação manual de funções Netlify e componentes React.

---

## 0. Sumário Executivo

| Categoria | Itens | Status |
|---|---:|---|
| 🔴 CRÍTICO — exposição ativa | 3 | Pendente |
| 🔴 CRÍTICO — design defensivo | 1 | Pendente |
| 🟠 ALTO — bugs funcionais (WebRTC + dados) | 4 | Pendente |
| 🟡 MÉDIO — integridade / UX / resiliência | 6 | Pendente |
| 🟢 BAIXO — cosmético / observabilidade | 3 | Pendente |
| ✅ Verificado seguro | 5 | OK |

**Total de itens acionáveis: 17**

---

## 1. Inventário do Schema

### 1.1 Migrations aplicadas (`schema_migrations`)
39 versões registradas (001 → 039). As migrations **040** (`recordings_source`) e **041** (`attendance_recompute_manual_override`) foram aplicadas via SQL raw na Management API, **sem registro em `schema_migrations`** — colunas/funções já existem no schema (verificado via `pg_proc` e `information_schema.columns`) mas o registro de versão ficou desatualizado.

**Ação L1:** inserir manualmente os registros para evitar que o Supabase CLI tente re-aplicar:
```sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values
  ('040', 'recordings_source', array['-- already applied via raw SQL']),
  ('041', 'fix_attendance_recompute_manual_override', array['-- already applied via raw SQL']);
```

### 1.2 RLS coverage
- Todas as 30+ tabelas em `public` têm RLS habilitada.
- Única exceção controlada: `push_dispatch_log` tem RLS habilitada mas **sem nenhuma policy** → totalmente bloqueada para roles `anon`/`authenticated` (somente `service_role` acessa). Verificar se a UI alguma vez lê esse log — se sim, faltam policies.

### 1.3 SECURITY DEFINER + search_path
✅ Todas as funções DEFINER têm `search_path` fixo (efeito da migration 039). Nenhuma exposta a search_path hijacking.

### 1.4 Triggers críticos verificados
| Tabela | Trigger | Quando | Função |
|---|---|---|---|
| `attendance` | `attendance_recompute_trg` | BEFORE INS/UPD | `attendance_recompute_one()` (já corrigida em 041) |
| `attendance` | `attendance_log_auto_absent_trg` | AFTER UPD | `attendance_log_auto_absent()` |
| `makeup_submissions` | `makeup_submissions_enforce_writes` | BEFORE UPD | `enforce_makeup_submission_writes()` |
| `makeup_submissions` | `makeup_submissions_history_aiu` | AFTER INS/UPD | `record_makeup_submission_event()` |
| `scheduled_lessons` | `lesson_recompute_attendance_trg` | AFTER UPD | `lesson_recompute_attendance()` |
| `scheduled_lessons` | `scheduled_lessons_status_history` | AFTER UPD | `record_lesson_status_change()` |

**Ausência relevante:** não há trigger em `makeup_submissions` que atualize `attendance` quando `status` muda para `'approved'`. Ver M1.

---

## 2. Achados Detalhados

### 🔴 CRÍTICO — Exposição ativa (exploit possível agora)

#### C1. `invite.ts` sem autenticação JWT
- **Arquivo:** [netlify/functions/invite.ts](../netlify/functions/invite.ts#L1-L70)
- **Vulnerabilidade:** handler aceita POST anônimo com `email`, `fullName`, `password` arbitrários e dispara e-mail via Resend contendo credenciais.
- **Impacto:** phishing dirigido em nome do Instituto, enumeração de contas, esgotamento da quota do Resend, possível blacklist do domínio remetente.
- **PoC:** `curl -X POST https://demo-lms.netlify.app/api/invite -d '{"email":"x@x","fullName":"X","password":"y"}'`
- **Correção:** validar header `Authorization: Bearer <jwt>` contra `/auth/v1/user` + checar `profiles.role IN ('coordenacao')`. Adicionar rate-limit por IP (10/h).

#### C2. `gdrive-token.ts` sem autenticação JWT
- **Arquivo:** [netlify/functions/gdrive-token.ts](../netlify/functions/gdrive-token.ts#L26-L65)
- **Vulnerabilidade:** GET anônimo retorna `access_token` OAuth válido do Drive institucional. CORS `*` agrava.
- **Impacto:** leitura/escrita/exclusão de qualquer arquivo no Drive da coordenação por qualquer pessoa na internet. Vazamento massivo de gravações de aulas.
- **PoC:** `curl https://demo-lms.netlify.app/api/gdrive/token` → retorna token utilizável em `googleapis.com`.
- **Correção:** exigir JWT válido (qualquer role autenticado é aceitável, pois a UI faz upload por trás), restringir CORS para `SITE_URL`.

#### C3. `turn-credentials.ts` sem autenticação JWT
- **Arquivo:** [netlify/functions/turn-credentials.ts](../netlify/functions/turn-credentials.ts#L35-L68)
- **Vulnerabilidade:** GET anônimo gera credenciais TURN do Cloudflare a cada chamada — cada credencial conta na quota/billing.
- **Impacto:** DoS de billing (custo direto), exaustão do plano TURN da conta Cloudflare, possível queda do serviço WebRTC para usuários legítimos.
- **PoC:** `for ($i=0;$i -lt 10000;$i++){ Invoke-WebRequest .../api/turn/credentials }`
- **Correção:** exigir JWT válido, manter CORS, opcional: rate-limit por IP+JWT.

#### C4. `ProtectedRoute` default-allow quando `allowedRoles` omitido
- **Arquivo:** [src/components/ProtectedRoute.tsx](../src/components/ProtectedRoute.tsx#L21-L31)
- **Vulnerabilidade:** se `allowedRoles` não for passado, **todos os roles autenticados passam**. Hoje todas as rotas em [App.tsx](../src/App.tsx#L86-L131) declaram explicitamente, então **não há exposição ativa**, mas é uma armadilha latente para qualquer rota futura.
- **Impacto potencial:** rota nova sem `allowedRoles` exporia view de coordenação para alunos.
- **Correção:** tornar `allowedRoles` obrigatório no tipo (`UserRole[]` não opcional) → TypeScript bloqueia uso inseguro em compile-time.

---

### 🟠 ALTO — Bugs funcionais que afetam aulas ao vivo

#### A1. WebRTC: `addTransceiver(recvonly)` no answerer quebra m-line order
- **Arquivo:** [src/hooks/useWebRTC.ts:820-826](../src/hooks/useWebRTC.ts#L820-L826)
- **Bug:** `createPeerConnection` chama `pc.addTransceiver('video', { direction: 'recvonly' })` quando não há câmera local, **sem distinguir offerer vs answerer**. O próprio comentário acima do código alerta para o problema mas não é honrado.
- **Sintoma observado em produção:** `InvalidAccessError: Failed to set local offer sdp: The order of m-lines in subsequent offer doesn't match order from previous offer/answer`.
- **Quando ocorre:** sempre que há renegotiation (toggle de câmera, screen-share, addTrack tardio) em uma sala onde algum peer entrou audio-only.
- **Correção:** parametrizar `createPeerConnection` com `isOfferer: boolean` e só pré-criar o transceiver no offerer:
  ```ts
  if (isOfferer && !localStreamRef.current?.getVideoTracks().length) {
    pc.addTransceiver('video', { direction: 'recvonly' });
  }
  ```

#### A2. WebRTC: upgrade áudio→vídeo duplica m-line
- **Arquivo:** [src/hooks/useWebRTC.ts:1509-1527](../src/hooks/useWebRTC.ts#L1509-L1527)
- **Bug:** `toggleVideo` quando aluno entrou só com áudio faz `peer.pc.getSenders().find(s => s.track?.kind === 'video')` — transceiver `recvonly` **não tem sender** (só receiver) → `find` retorna `undefined` → cai no `addTrack(newTrack)` que **cria outro transceiver**, duplicando o m-line.
- **Sintoma:** câmera nunca é vista pelos pares após habilitar; pode falhar a renegotiation.
- **Correção:** guardar referência ao `RTCRtpTransceiver` retornado por `addTransceiver` (Map por `remoteUserId`) e usar `transceiver.sender.replaceTrack(newTrack)` + `transceiver.direction = 'sendrecv'`.

#### A3. WebRTC: `attemptReconnect` não recria peers `failed`
- **Arquivo:** [src/hooks/useWebRTC.ts:1445-1471](../src/hooks/useWebRTC.ts#L1445-L1471)
- **Bug:** ao receber `CHANNEL_ERROR`/`CLOSED` no Realtime, só re-subscreve o canal. Peers que estavam em `failed` antes ficam zumbis (sem ICE restart, sem reoferta).
- **Sintoma:** telas pretas que não se recuperam mesmo após o "Reconnecting…" voltar a `SUBSCRIBED`.
- **Correção:** antes do `channel.subscribe()`, percorrer `peersRef` e chamar `removePeer(id)` para qualquer peer com `connectionState in ('failed','disconnected','closed')`. Presence sync os recriará via fluxo normal.

#### A4. `expire-makeup-deadlines` audit_logs com `actor_id NULL`
- **Arquivo:** [netlify/functions/expire-makeup-deadlines.ts:173-184](../netlify/functions/expire-makeup-deadlines.ts#L173-L184)
- **Bug:** PATCH direto via REST com service_role. O trigger `attendance_log_auto_absent_trg` dispara, mas a função `attendance_log_auto_absent()` insere com `actor_id = NULL` (não há sessão Supabase associada). Auditoria forense fica anônima.
- **Correção:** chamar RPC dedicada `auto_expire_makeup_deadline(p_attendance_id uuid)` que registra `actor_id = '00000000-0000-0000-0000-000000000000'` ou usa coluna `actor_system text` com valor `'cron'`.

---

### 🟡 MÉDIO — Integridade, UX, resiliência

#### M1. Aprovação de reposição não reconcilia attendance
- **Arquivos:** [src/services/makeup.service.ts:154-173](../src/services/makeup.service.ts#L154-L173), [supabase/migrations/018_makeup_submissions.sql](../supabase/migrations/018_makeup_submissions.sql)
- **Problema:** ao aprovar uma submissão, `makeup_submissions.status='approved'` é gravado mas o `attendance` correspondente continua `status='justified'` com `makeup_deadline` setado. Métricas de "FJ pendentes" ficam infladas; relatórios para o aluno mostram a obrigação como aberta.
- **Decisão de design necessária:** confirmar com stakeholders o comportamento esperado. Duas opções:
  - **Opção A:** trigger AFTER UPDATE em `makeup_submissions` que, quando `status='approved'`, limpa `attendance.makeup_deadline` e marca um novo campo `attendance.makeup_satisfied boolean`. FJ continua FJ mas obrigação "fecha".
  - **Opção B:** trigger muda `attendance.status='present'` com `notes='FJ aprovada via reposição em <data>'`. Esconde a falta original — pode confundir histórico.
- **Recomendação:** Opção A (preserva auditoria).

#### M2. UI otimista da aprovação não atualiza grade FJ
- **Arquivo:** [src/components/views/ReposicoesView.tsx:568-590](../src/components/views/ReposicoesView.tsx#L568-L590)
- **Problema:** após aprovação, só o card de submissão muda; a linha de FJ no topo continua "em risco" até reload manual.
- **Correção:** após `reviewSubmission`, refazer fetch de `fjRows` OU remover a linha do FJ da lista local pelo `id`.

#### M3. CORS `*` em endpoints OAuth
- **Arquivos:** [netlify/functions/gdrive-auth.ts](../netlify/functions/gdrive-auth.ts), [netlify/functions/gdrive-token.ts](../netlify/functions/gdrive-token.ts)
- **Problema:** `Access-Control-Allow-Origin: '*'` permite que qualquer site execute requests via fetch em nome do usuário (combinado com C2 = exfil).
- **Correção:** trocar para `process.env.SITE_URL ?? 'https://demo-lms.netlify.app'`.

#### M4. `push-send.ts` header case-sensitivity
- **Arquivo:** [netlify/functions/push-send.ts:43](../netlify/functions/push-send.ts#L43)
- **Problema:** `headers['X-Internal-Key']` — Netlify normaliza headers para lowercase, então o lookup com camelCase nunca casa. O bypass interno para scheduled functions provavelmente não funciona.
- **Correção:** sempre normalizar antes: `Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(), v]))`.

#### M5. AuthContext sem refresh proativo
- **Arquivo:** [src/contexts/AuthContext.tsx:60-70](../src/contexts/AuthContext.tsx#L60-L70)
- **Problema:** Supabase auth-js refresca o token em chamadas REST, mas em telas que só usam Realtime (sala de aula longa, dashboard idle) o JWT expira e o socket cai. Sessões >1h ficam instáveis.
- **Correção:** `setInterval` de 55 min chamando `supabase.auth.refreshSession()`; cancelar no unmount.

#### M6. Mutações de attendance não-flush sem idempotência
- **Arquivos:** `src/services/attendance.service.ts` (funções `markPresent`/`markAbsent`/`markJustified`)
- **Problema:** sem `request_id`; em retry de rede pode gerar 2 escritas. UPSERT com `ON CONFLICT` mitiga parcialmente, mas notes/timestamps podem ser sobrescritos.
- **Correção:** adicionar parâmetro `requestId?: string` + tabela `attendance_idempotency_keys` (TTL 5min) consultada no início do RPC, replicando padrão da migration 032.

---

### 🟢 BAIXO

#### L1. Migrations 040/041 não em `schema_migrations`
Ver §1.1. Resolução: 2 `INSERT` manuais.

#### L2. `lesson_evaluations` duplo caminho para `classes`
- **Arquivo:** [supabase/migrations/029_lesson_evaluations.sql](../supabase/migrations/029_lesson_evaluations.sql)
- Mitigado em [src/services/lessonEvaluations.service.ts](../src/services/lessonEvaluations.service.ts) com queries paralelas. Adicionar CHECK constraint para garantir consistência:
  ```sql
  ALTER TABLE lesson_evaluations
    ADD CONSTRAINT chk_eval_class_matches_lesson
    CHECK (class_id = (SELECT class_id FROM scheduled_lessons WHERE id = scheduled_lesson_id));
  ```
  ⚠️ CHECK com subquery não é suportado em Postgres — usar trigger BEFORE INS/UPD.

#### L3. `ProtectedRoute` não loga role mismatch
Adicionar `console.warn` (ou audit_logs via RPC) quando uma view nega acesso por role — facilita detectar bugs de UI e tentativas suspeitas.

---

### ✅ Verificado seguro

1. **Secrets server-side**: `SUPABASE_SERVICE_ROLE_KEY`, `GDRIVE_CLIENT_SECRET`, `VAPID_PRIVATE_KEY`, `CLOUDFLARE_TURN_API_TOKEN` não aparecem no bundle (`import.meta.env.VITE_*` só expõe URL+anon key).
2. **RLS habilitada** em todas as tabelas críticas (profiles, attendance, makeup_submissions, lesson_evaluations, recordings, etc.).
3. **SECURITY DEFINER + search_path** fixos pós-039.
4. **`audit_logs` INSERT** bloqueado para clientes (mig 039) — clientes só leem; escritas via funções DEFINER.
5. **`admin-create-user`, `admin-promote-managed`, `admin-user`, `push-send`** validam JWT + role `coordenacao` corretamente.

---

## 3. Plano de Ação Faseado

### 🚨 Fase 0 — Hotfix Segurança (HOJE — máx 1h de trabalho)
Objetivo: fechar exposições anônimas críticas. Risco residual aceitável.

- [ ] **C1** — `invite.ts`: helper `verifyCoordinator(authHeader)` (copiar de `admin-promote-managed.ts`), retornar 401 se falhar.
- [ ] **C2** — `gdrive-token.ts`: validar JWT (qualquer authenticated), restringir CORS.
- [ ] **C3** — `turn-credentials.ts`: validar JWT (qualquer authenticated).
- [ ] **C4** — `ProtectedRoute`: tornar `allowedRoles` obrigatório no tipo.
- [ ] Build + commit + push → deploy Netlify automático.
- [ ] Smoke test: tentar `curl` anônimo nas 3 funções → esperar 401.

**Entregável:** commit único `security: enforce JWT on invite/gdrive-token/turn-credentials + require allowedRoles`.

---

### 🛠️ Fase 1 — Estabilidade WebRTC (1–2 dias)
Objetivo: parar `InvalidAccessError` em produção e garantir recuperação de queda.

- [ ] **A1** — refatorar `createPeerConnection(remoteUserId, remoteUserName, isOfferer)` em `useWebRTC.ts`.
- [ ] **A2** — armazenar `Map<remoteUserId, RTCRtpTransceiver>` para transceiver de vídeo recvonly; usar no `toggleVideo`.
- [ ] **A3** — em `attemptReconnect`, sweep e remoção de peers em estado terminal antes de re-subscribe.
- [ ] Testar manualmente:
  - Aluno A (audio-only) + aluno B (com câmera) — ambos veem o outro.
  - Aluno A liga câmera mid-aula — B passa a ver.
  - Screen-share ON/OFF 3× — sem erros.
  - Forçar `disconnect` no DevTools 5s — esperar recovery sem reload.

**Entregável:** commit `fix(webrtc): m-line stability + audio-only upgrade + reconnect recovery`.

---

### 📊 Fase 2 — Integridade de Dados (1 semana)
Objetivo: métricas e fluxo de reposição confiáveis.

- [ ] **M1** — alinhar com coordenação a semântica de "FJ aprovada via reposição". Implementar trigger Option A após decisão. Nova migration 042.
- [ ] **M2** — `ReposicoesView`: refetch FJ rows após approve/reject.
- [ ] **A4** — RPC dedicada `auto_expire_makeup_deadline()` chamada pelo cron com `actor_system='cron'`.
- [ ] **L2** — trigger de validação `lesson_evaluations.class_id` ↔ `scheduled_lessons.class_id`.
- [ ] **L1** — registrar migrations 040/041 em `schema_migrations`.

**Entregável:** 1–2 migrations + ajustes de UI.

---

### 🔒 Fase 3 — Hardening Operacional (1 semana)
Objetivo: resiliência em sessões longas + observabilidade.

- [ ] **M3** — restringir CORS dos endpoints gdrive para `SITE_URL`.
- [ ] **M4** — normalizar headers em todas as Netlify functions.
- [ ] **M5** — refresh proativo de token a cada 55min em `AuthContext`.
- [ ] **M6** — adicionar `requestId` nas mutações pontuais de attendance.
- [ ] **L3** — log/audit em ProtectedRoute deny.
- [ ] Documentar variáveis de ambiente obrigatórias em `docs/ENV.md`.
- [ ] Adicionar rate-limit (Upstash Redis ou Netlify Edge) em `invite.ts`, `gdrive-token.ts`, `turn-credentials.ts`.

**Entregável:** commit de hardening + documentação operacional.

---

### 🧪 Fase 4 — Validação e Cobertura (contínuo)
- [ ] Cobertura de testes para `attendance_recompute_one` (insertar attendance presencial → garantir que não recomputa).
- [ ] E2E (Playwright) cobrindo: login coordenador → criar aluno → enviar invite → aluno aceita → marca presença.
- [ ] Health-check endpoint público (sem token sensível) para uptime monitoring.
- [ ] Painel admin de métricas (rate de erros WebRTC, peers em failed, latência ICE).

---

## 4. Anexos

### A. Comandos úteis

**Aplicar migration via Management API:**
```powershell
$sql = Get-Content supabase\migrations\042_xxx.sql -Raw
$body = @{ query = $sql } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post `
  -Uri "https://api.supabase.com/v1/projects/iqltmpkqudhtkfqgqfwl/database/query" `
  -Headers @{ Authorization = "Bearer $env:SUPABASE_ACCESS_TOKEN"; "Content-Type" = "application/json" } `
  -Body $body
```

**Listar todas as policies:**
```sql
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies where schemaname='public' order by tablename, policyname;
```

**Smoke test pós-fix C1/C2/C3 (esperar 401):**
```powershell
Invoke-WebRequest -Method POST -Uri "https://demo-lms.netlify.app/api/invite" -Body '{}' -ContentType 'application/json' -UseBasicParsing
Invoke-WebRequest -Method GET  -Uri "https://demo-lms.netlify.app/api/gdrive/token" -UseBasicParsing
Invoke-WebRequest -Method GET  -Uri "https://demo-lms.netlify.app/api/turn/credentials" -UseBasicParsing
```

### B. Glossário de roles
- `coordenacao` — admin completo (gestão de turmas, alunos, professores, reposições)
- `professor` — vê suas turmas, marca presença, avalia monitor
- `monitor` — auxilia professor em aulas, marca presença, registra evaluations
- `aluno` — vê próprias aulas, presenças, FJ, envia reposições, gravações

### C. Histórico recente de commits relevantes
- `93c496b` — hotfix calendar null modality
- `648a0e6` — audit_logs RLS noise silenciado + mobile-web-app-capable
- `51959a7` — migration 041 attendance trigger fix
- `005db90` — mobile UX (avaliações cards + video player max-h) + classes(name) fix
- `137eaba` — feature: reposições standalone + recordings externas

---

**Próximo passo imediato:** executar Fase 0 (C1–C4).
