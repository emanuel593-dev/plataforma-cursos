# Auditoria — Presença Automática + WebRTC/TURN

> Data: 2026-05-12  
> Escopo: cálculo de presença (`duration_seconds`, `ratio`, `status`, `notes`),
> fluxo de reconexão de aluno e infraestrutura WebRTC/TURN/áudio.  
> **Nenhuma correção foi aplicada ainda** — este documento é a base para a próxima fase.

---

## 0. Cenário observado

Aula de 11/05/2026 (`Projeto de Deus x Decisão do homem` / Turma `Obr Marcelo`).

Relatório (vista do coordenador):

| Aluno | Permaneceu | Status | Observação |
|---|---|---|---|
| Marcus Vinicius | 47 min | **Ausente** | "permaneceu 73% (mín. 75%)" — 2/2 verificações |
| Andreia Alves | 38 min | Ausente | "permaneceu 63%" — 3/3 verificações |
| Obr Marcelo (host) | 42 min | Ausente | "permaneceu 37%" |
| Aluno 60df86… | 1 min | Ausente | "permaneceu 1%" |

Header da aula informa **duração total = 54 min**.  
Tela de chamada (`/presencas`) mostra **Marcus = Presente, 46 min, 73%, 2/2**.

Inconsistências aparentes:

1. **Matemática não bate**: 47/54 = 87 %, não 73 %. 38/54 = 70 %, não 63 %. 42/54 = 78 %, não 37 %.
2. **Status divergente entre telas**: Marcus aparece `Presente` na chamada e `Ausente` no relatório.
3. **Nota antiga sobrevive a override**: nota fala em "permaneceu 73 %" mesmo após a coordenação ter alterado o status para Presente.
4. **Permaneceu ≠ duração mostrada na nota**: chamada diz 46 min, relatório diz 47 min.

---

## 1. Mapa do fluxo (referência de código)

### 1.1 Cliente — captura de tempo
[src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx)

- `recordAttendanceJoin` (L425-L448): UPSERT delegado a [src/lib/attendanceJoin.ts](src/lib/attendanceJoin.ts) — preserva `joined_at` mais antigo, **só seta `status='present'` no primeiro join** (rejoin não sobrescreve).
- `recordAttendanceLeave({ final })` (L449-L535):
  - `baseStart = max(joinedAt, lessonStart)` → conta apenas tempo após "Iniciar aula".
  - `sessionSeconds = round((Date.now() - baseStart) / 1000)`.
  - Envia delta ao RPC `attendance_increment_duration`.
  - **No `final`**, calcula:
    ```ts
    const ratio = (priorDurationRef.current + sessionSeconds) / (classDurationRef.current * 60);
    if (ratio < MIN_DURATION_RATIO /* 0.75 */) status = 'absent';
    note = `Presença automática removida: permaneceu ${Math.round(ratio*100)}% da aula (mín. 75%).`;
    ```
- `priorDurationRef` (L174) é re-semeado a cada join via [attendanceJoin.ts](src/lib/attendanceJoin.ts#L48-L55) lendo `attendance.duration_seconds` do banco.

### 1.2 Reconexão (Realtime drop / WebRTC drop)
[src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx#L786-L820)

- `connected: true → false` enquanto `joined`: dispara `recordAttendanceLeave({ final:false })` para persistir o segmento atual.
- `connected: false → true`: re-executa `recordAttendanceJoin()`, que **lê o `duration_seconds` atualizado do banco** e re-semeia `priorDurationRef`. Reseta `lastFlushedSessionSecondsRef = 0` para começar novo segmento.

### 1.3 Lock cross-tab
[src/lib/attendanceFlushLock.ts](src/lib/attendanceFlushLock.ts) — janela de 5 s em `localStorage` para evitar duplo flush entre tabs do mesmo usuário. Final flush ignora a janela.

### 1.4 Servidor — soma atômica
[supabase/migrations/015_attendance_increment_rpc.sql](supabase/migrations/015_attendance_increment_rpc.sql)

```sql
duration_seconds = COALESCE(attendance.duration_seconds, 0) + p_delta_seconds,
verified_checks  = attendance.verified_checks + p_verified_checks_delta,
total_checks     = attendance.total_checks    + p_total_checks_delta,
joined_at        = LEAST(...),  -- preserva o mais antigo
left_at          = COALESCE(EXCLUDED.left_at, attendance.left_at),
status           = COALESCE(EXCLUDED.status, attendance.status),
notes            = CASE WHEN p_status IS NOT NULL THEN EXCLUDED.notes ELSE attendance.notes END
```

→ **Status e notas só são atualizados quando o cliente envia `p_status` não-NULL**.  
→ Em flushes intermediários (drop / visibility), `status=NULL` ⇒ apenas o contador sobe.  
→ No final flush, o cliente decide e envia `status='absent'` + nota com %.

### 1.5 Override manual (coordenação / professor)
[src/services/attendance.service.ts](src/services/attendance.service.ts) — `upsertAttendance({status})` via PostgREST.  
**Hipótese a confirmar**: o caminho de override (clicar P/F/FJ no grid) provavelmente não passa `notes: null`, então a nota automática antiga persiste mesmo após mudança manual de status (caso Marcus na chamada).

### 1.6 Relatório
[src/components/views/ReportsView.tsx](src/components/views/ReportsView.tsx#L1230-L1330)
- "Permaneceu" = `formatSeconds(attendance.duration_seconds)`.
- "Status" = badge baseado em `attendance.status`.
- "Observação" = `attendance.notes`.
- Header da aula = `report.duration_minutes`.

---

## 2. Bugs identificados

### 🔴 BUG A — Denominador volátil entre flush e relatório

**Sintoma**: 47 min / 54 min ≠ 73 %.

**Hipótese principal**: no momento do final-flush, `classDurationRef.current` valia outra coisa. O ref é populado em [ClassroomView.tsx L225](src/components/views/ClassroomView.tsx#L225) a partir de `sl.duration_minutes`. Se o agendamento foi **editado depois** (ex.: coordenação ajusta a duração para 54 min após a aula), a nota persistida congelou o denominador antigo (e.g. 64 min).

| Aluno | min | % nota | denominador implícito (min/%) |
|---|---|---|---|
| Marcus | 47 | 73 % | ≈ 64 |
| Andreia | 38 | 63 % | ≈ 60 |
| Marcelo | 42 | 37 % | ≈ 113 (ver BUG E) |

**Ação proposta**: parar de armazenar a % na coluna `notes`. Calcular sempre na hora do render usando `min(now, ended_at) - started_at` (duração efetiva) como denominador.

---

### 🔴 BUG B — `duration_seconds` continua subindo após decisão final

**Sintoma**: nota diz "73 %" (calculado com 47 min), mas a coluna `Permaneceu` mostra 47 min ainda — o que dá 87 %.

**Causa**: depois do final-flush, qualquer flush adicional (visibility-change tardio, beforeunload de outra aba, race do `recordAttendanceLeave` com `disconnect()`) cai no caminho intermediário (`p_status=NULL`) e **soma mais segundos** sem reavaliar `status`/`notes`.

**Ação proposta**: tornar a decisão de status **derivada** (computada no render ou em view SQL) em vez de armazenada/congelada.

---

### 🔴 BUG C — Critério usa duração AGENDADA, não REAL

[ClassroomView.tsx L484](src/components/views/ClassroomView.tsx#L484):

```ts
const classDurationSeconds = classDurationRef.current * 60; // sl.duration_minutes
const ratio = durationSeconds / classDurationSeconds;
```

Se a aula foi **encerrada cedo** pelo professor (botão "Encerrar"), `ended_at - started_at` pode ser muito menor que `duration_minutes`. Aluno que ficou 47 min de uma aula que durou 54 min reais (87 %) é punido por critério de 64 min agendados (73 %).

**Ação proposta**: quando `sl.ended_at IS NOT NULL`, usar `(ended_at - started_at)` como denominador de referência. Se ainda em andamento, usar `duration_minutes`.

---

### 🔴 BUG D — Override manual não limpa nota automática

**Sintoma**: tooltip da chamada mostra `Presente` + nota "permaneceu 73 %, removida" — combinação contraditória.

**Causa provável**: `upsertAttendance({ status:'present' })` chamado pelo grid de chamada (`AttendanceView`) **não passa `notes: null` explicitamente**, então o `EXCLUDED.notes` é `NULL` e a `notes` antiga é preservada. (RPC sobrescreve nota só quando `p_status` é NÃO-NULL; o caminho REST direto (sem RPC) tem comportamento parecido por omissão de campo.)

**Ação proposta**: no override manual, sempre setar `notes = null` (ou um marcador "Ajustado manualmente em DD/MM/YYYY por <coord>").

---

### 🟡 BUG E — Host (professor) somando tempo pré-`Iniciar aula`

**Sintoma**: Marcelo entrou 19:13 (1 min antes do `scheduled_at` 19:14), aparece com 42 min mas nota = 37 %.

**Análise**:
- `baseStart = max(joinedAt, lessonStart)` — host normalmente entra antes de clicar "Iniciar aula", então `lessonStart > joinedAt` e o pré-tempo é descontado.
- Porém, se o host abriu a sala (status `in_progress` mas `lessonStartedClient` ainda `null` no cliente até realmente clicar "Iniciar aula"), o flush parcial entra no caminho de [L466-L472](src/components/views/ClassroomView.tsx#L466-L472):

  ```ts
  if (lessonStart === null) {
    finalStatus = 'absent';
    note = 'Aula não iniciada formalmente pelo anfitrião…';
  }
  ```

  Mas o relatório de Marcelo diz "permaneceu 37 %", não "Aula não iniciada formalmente" → **flush passou pelo caminho do `ratio < 0.75`**, sugerindo que `lessonStart` não era null mas o cálculo somou tempo de uma sessão errada (vide BUG F).

**Ação proposta**: sempre logar (apenas em audit_logs) `{ priorDuration, sessionSeconds, classDurationSeconds, ratio, decisionPath }` no momento da decisão para facilitar autópsia.

---

### 🔴 BUG F — Hipótese do usuário CONFIRMADA: reconexão pode duplicar contagem

> Hipótese original do usuário: *"o aluno cai por erro do sistema ou falha de conexão, e ao entrar novamente ele pode iniciar uma nova contagem e tentar somar a anterior"*.

**Análise do código**:

1. `priorDurationRef.current` é semeado em `recordAttendanceJoin` lendo `attendance.duration_seconds` ([attendanceJoin.ts L48-L55](src/lib/attendanceJoin.ts#L48-L55)). Isto é **CORRETO** — em teoria evita duplicação.

2. **PORÉM**, o flush não tem chave de idempotência além da janela de 5 s do localStorage. Cenários reais que escapam:

   - **Flush em voo durante o drop**: `connected: true → false` dispara `recordAttendanceLeave({ final:false })`. A request POST/RPC pode estar sendo enviada quando a rede cai → o servidor recebe e soma, **mas o cliente não recebe a resposta** e o ref `lastFlushedSessionSecondsRef` **não é atualizado**. Depois, `connected: false → true` chama `recordAttendanceJoin` que lê o novo `duration_seconds` (já atualizado!) e reseta refs → tudo bem. Mas se **antes do reconnect** o `recordAttendanceLeave` é chamado novamente (race com beforeunload por exemplo), ele vai computar `sessionDelta = sessionSeconds - lastFlushedSessionSecondsRef.current` baseado em refs **não atualizados** → re-envia o mesmo período.

   - **Lock cross-tab é só 5 s**: dois eventos a >5 s de distância (ex.: `visibilitychange` ao trocar de aba e voltar minutos depois) **passam ambos**. Cada um envia `sessionSeconds - lastFlushed = sessionSeconds`, somando ao banco que já tinha aquele tempo.

   - **Final flush ignora a janela**: ao sair manualmente, o final flush sempre roda. Se uma rota de saída disparou `disconnect()` que disparou `recordAttendanceLeave` no caminho de cleanup E o usuário também clicou "Sair" (que aciona o `final:true` direto), os dois caminhos correm sem dedup → soma dupla.

   - **Multi-device**: lock está em `localStorage` (escopo por origem+device). Se o aluno está em celular + computador na mesma aula, **cada device flusha independente**. O banco soma os dois.

3. **Regra do `recordAttendanceJoinCore`**: `if (!existing) updates.status = 'present'`. **Em rejoin não toca `status`** → bom para preservar `absent` decidido antes. Mas isto **invalida** o caso "aluno ficou abaixo de 75 % por queda transitória, voltou e completou os 75 %": status fica `absent` para sempre.

**Ações propostas**:

- (a) Tornar o flush idempotente por `(lesson_id, student_id, segment_started_at)` — RPC rejeita se o último flush teve `segment_started_at` igual.
- (b) Aumentar janela do lock para 30 s OU adicionar `requestId` (UUID) gerado por flush e gravado no banco (`last_flush_id`).
- (c) Mover a decisão de `status` para uma **view SQL** ou função `RECOMPUTE_ATTENDANCE_STATUS(lesson_id)` que roda quando `sl.ended_at` é setado — fonte única de verdade, recalcula tudo a partir de `duration_seconds + ended_at - started_at`.
- (d) No multi-device, idealmente eleger o "device líder" (último `joined_at`) ou consolidar por servidor, não por cliente.

---

### 🟡 BUG G — Verificações periódicas não influenciam o `ratio`

Andreia: 3/3 verificações respondidas, ainda assim 63 %. Marcus: 2/2 respondidas, 73 %. Verificações comprovam presença ativa, mas o critério **só usa tempo**. Aluno com 70 % de tempo + 100 % de verificações = ausente.

**Ação proposta**: critério composto. Ex.: `(ratio >= 0.75) OR (ratio >= 0.5 AND verified/total == 1)`.

---

## 3. WebRTC / TURN — análise do problema de áudio

### 3.1 Configuração atual

| Item | Valor / fonte |
|---|---|
| TURN provider | **Cloudflare Realtime TURN** ([netlify/functions/turn-credentials.ts](netlify/functions/turn-credentials.ts)) |
| Endpoint cliente | `GET /api/turn/credentials` ([useWebRTC.ts L121](src/hooks/useWebRTC.ts#L121)) |
| Credenciais | Ephemerais, TTL 24 h, refresh 5 min antes da expiração ([L120-L137](src/hooks/useWebRTC.ts#L120-L137)) |
| Token server-side | Envs `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN` |
| Override estático | `VITE_TURN_URL/USERNAME/CREDENTIAL` (build-time, opcional) |
| Fallback final | STUN-only (Google) — ~30 % das conexões atrás de NAT simétrico falham |
| Cache cliente | `Cache-Control: private, max-age=80% TTL` (browser) + `iceCache` em memória |
| Política | `bundlePolicy: 'max-bundle'`, `rtcpMuxPolicy: 'require'`, `iceCandidatePoolSize: 2` |
| Escalada relay-only | Após 2 falhas seguidas de ICE → recria `pc` com `iceTransportPolicy: 'relay'` ([L710-L723](src/hooks/useWebRTC.ts#L710-L723)) |
| Áudio constraints | `echoCancellation/noiseSuppression/autoGainControl: true` ([L283-L286](src/hooks/useWebRTC.ts#L283-L286)) |
| Bitrate cap áudio | `MAX_AUDIO_BITRATE = 40_000` (40 kbps Opus) — aplicado via `sender.setParameters()` |

### 3.2 Sintoma reportado

> "Ao iniciar era possível ouvir claramente o professor, mas gradualmente o áudio ia falhando e ficando 'baixo'. Era necessário sair e entrar novamente para resolver."  
> Aluno A: queda de áudio, sem queda de internet.  
> Aluno B (mesma aula): conexão instável e quedas, mas **sem** queda de áudio.

### 3.3 Hipóteses por probabilidade

#### H1 — `autoGainControl + noiseSuppression` agressivos sem ruído (mais provável p/ Aluno A)

`autoGainControl: true` eleva o ganho quando detecta silêncio prolongado, e `noiseSuppression` aplica um filtro AEC3/RNNoise. Em condições de baixo ruído ambiente (sala silenciosa), o AGC pode **abaixar progressivamente** o ganho de captura do professor (cada peer aplica AGC localmente no microfone do próprio peer; o professor, falando pausadamente, vai sendo "comprimido" para baixo).  
*Sair e entrar* recria a `MediaStream` ⇒ AGC reseta ao baseline.

**Confirmação**: peça ao aluno na próxima ocorrência reproduzir a aula gravada — se a faixa de áudio ORIGINAL do professor (no log de Cloudflare ou stats `audioLevel`) está estável, o problema é local; se está caindo, é o microfone do professor ou seu próprio AGC.

**Ação proposta**: testar `autoGainControl: false` ou expor toggle no perfil do usuário.

#### H2 — Bitrate cap áudio aplicado em `negotiationneeded` repetido

`MAX_AUDIO_BITRATE = 40_000` é aplicado uma vez no `addTrack` ([L619](src/hooks/useWebRTC.ts#L619)). Cada renegociação **não** reaplica, mas se um screen-share / rejoin recria o sender, o cap pode ser perdido até a próxima rebalance — e 40 kbps é confortável para Opus, descartável.  
**Status**: improvável. Caso confirmado seria estouro de banda, não queda gradual.

#### H3 — Pacotes de áudio descartados por congestionamento BWE local

Sem RED/FEC explícito (não há SDP munging para `useinbandfec=1` ou `usedtx=1`). Se a banda do peer-pair degrada, o GCC do Chromium reduz bitrate de áudio progressivamente, audível como "ficando baixo / abafado".

**Confirmação**: `getStats()` por peer → `outbound-rtp[kind=audio].targetBitrate` ao longo da aula. Se cai de 40 k → 20 k → 8 k, é BWE.

**Ação proposta**: forçar `useinbandfec=1; usedtx=0; maxaveragebitrate=40000` via SDP munging no answer/offer; considerar `priority: 'high'` no `RTCRtpEncodingParameters` de áudio.

#### H4 — TURN-relay degradado / refresh de credenciais expira mid-call

Credenciais Cloudflare têm TTL 24 h, refresh 5 min antes. Mas o `iceCache` está em memória do cliente; se a tab fica >24 h aberta sem refresh efetivo (ex.: serviceworker pausado), o relay pode parar de aceitar pacotes.

**Confirmação**: para a aula em questão, sessão durou ~50 min ⇒ TTL não foi atingido. Improvável.

#### H5 — Mesh CPU pressure no professor

6 alunos × encode separado por peer no professor (mesh, sem SFU). Se a CPU do professor satura (~80 %), o Opus encoder pode dropar samples → som "tremido / abafado" para todos os peers.

**Confirmação**: pedir ao professor `chrome://webrtc-internals` ou medir `getStats().[encoder].framesEncoded` taxa.

**Ação proposta**: documentado no [aprimoramento_WebRTC.md](aprimoramento_WebRTC.md) (mesh é o limitante para >4 participantes).

### 3.4 Por que aluno B não teve problema mesmo com queda

Cada peer-pair é **independente** no mesh. A queda do Aluno B afeta só o link `Professor↔B`. Aluno A pode ter problema só no link `Professor↔A` por motivos ortogonais (CPU local, AGC, BWE local). Isto é **consistente** com o relato.

### 3.5 Recomendações priorizadas (não aplicar agora)

| # | Ação | Custo | Benefício |
|---|---|---|---|
| 1 | Toggle `autoGainControl` no perfil + valor padrão `false` | baixo | alto p/ H1 |
| 2 | Logar `getStats()` áudio a cada 30 s em `audit_logs` (sample 10 %) | médio | diagnóstico |
| 3 | SDP munging: `useinbandfec=1; usedtx=0; maxaveragebitrate=40000` | médio | mitiga H3 |
| 4 | Reaplicar `MAX_AUDIO_BITRATE` no `onnegotiationneeded` | baixo | preventivo H2 |
| 5 | Migrar para SFU (LiveKit/Mediasoup) quando >4 participantes | alto | resolve H5 |

---

## 4. Plano sugerido para correções de presença

### Fase A (rápida, alto impacto)
1. **Override manual deve limpar nota automática**: em `AttendanceView` ao mudar status manualmente, passar `notes: null` (ou nota "Ajustado manualmente").
2. **Recalcular % no render do relatório** (já temos `started_at`, `ended_at`, `duration_seconds`): exibir % derivada, não a do `notes`.
3. **Critério composto**: `present` se `ratio_real >= 0.75` OU `(ratio_real >= 0.5 AND verified == total)`.

### Fase B (média, mexe em RPC)
4. **Função `recompute_attendance_status(lesson_id uuid)`**: roda no `endLesson` e a qualquer override; recalcula `status` a partir de `duration_seconds + ended_at - started_at`. Override manual seta um flag `manually_overridden=true` que bloqueia recompute futuro.
5. **Token de idempotência por flush** (`request_id uuid`): RPC rejeita duplicado dentro de janela de 60 s.
6. **Lock cross-tab subir para 30 s** + segregação por device opcional.

### Fase C (longa, melhora UX)
7. **Mostrar ao aluno em tempo real** o % atual e o restante para atingir 75 % (já existe ring indicator, mas sem ratio).
8. **Multi-device**: detectar e avisar usuário, não somar ambos.
9. **Notificação push quando status final muda** ("sua presença foi removida automaticamente porque...").

---

## 5. Plano sugerido para áudio WebRTC

(ver §3.5, deixar para fase própria após estabilizar presença).

---

## 6. Apêndice — Como reproduzir bug F (reconexão duplicando)

```bash
# Aluno em rede instável
1. Entrar na sala (joined_at=t0)
2. Ficar 10 min — duration_seconds=600
3. Forçar drop Wi-Fi por 30 s (Realtime drop)
   → connected: true→false → recordAttendanceLeave({final:false}) sai pela rede caindo
   → POST falha SEM atualizar lastFlushedSessionSecondsRef
4. Wi-Fi volta → recordAttendanceJoin lê duration_seconds=600 (caso o POST tenha chegado)
   → priorDurationRef=600, lastFlushedSessionSecondsRef=0
5. Ficar mais 10 min, sair → final flush envia delta=600
   → banco: duration_seconds = 600 + 600 = 1200 ✓ (correto)

# Cenário de duplicação:
3'. POST chegou no banco (duration=600), mas resposta perdeu pacote.
    Cliente NÃO atualizou lastFlushedSessionSecondsRef (continua 0).
4'. Antes do reconnect, beforeunload dispara → outro recordAttendanceLeave.
    sessionSeconds=600, sessionDelta=600-0=600 → REENVIADO.
    banco: duration_seconds = 600 + 600 = 1200 ❌ (deveria ser 600).
5'. Reconnect lê 1200, segue daí. Aluno terá tempo dobrado.
```

A solução é o `request_id` + tabela `attendance_flush_log(request_id PK, lesson_id, student_id, applied_at)`.

---

**Aguardando decisão do usuário sobre quais fases implementar.**
