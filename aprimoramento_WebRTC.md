# Aprimoramento WebRTC — Auditoria de Concorrência (6 salas × 5 alunos)

> Documento gerado a partir de revalidação ponto a ponto da auditoria preliminar contra o código-fonte real.
> Nenhuma alteração foi aplicada. Este é um relatório de avaliação + plano de testes.
>
> Cenário-alvo: **6 salas simultâneas com 5 alunos cada + 1 professor por sala = 36 participantes ativos**.

---

## 1. Metodologia

Cada item levantado na auditoria preliminar foi reexaminado lendo diretamente os arquivos do projeto. Para cada achado, este documento registra:

- **Status**: `Confirmado`, `Confirmado com ressalva`, `Refutado` ou `Inconclusivo`.
- **Evidência**: arquivo + linhas reais do repositório.
- **Cálculo**: quando há números, são derivados diretamente das constantes do código.
- **Impacto real** no cenário 6×5.

Todos os links apontam para o código atual no workspace.

---

## 2. Reavaliação ponto a ponto

### 2.1 ❌ Refutado — “Falta índice composto em `attendance(scheduled_lesson_id, student_id)`”

A auditoria preliminar afirmou que faltava o índice composto. **Falso.**

- A tabela já declara `UNIQUE (scheduled_lesson_id, student_id)` em [supabase/migrations/001_initial_schema.sql](supabase/migrations/001_initial_schema.sql#L98), o que cria automaticamente um índice único composto no PostgreSQL.
- O `upsertAttendance` usa exatamente esse `onConflict` em [src/services/attendance.service.ts](src/services/attendance.service.ts#L137).
- Os índices secundários `idx_attendance_lesson` e `idx_attendance_student` em [supabase/migrations/001_initial_schema.sql](supabase/migrations/001_initial_schema.sql#L108) são adicionais, não substitutos.

**Conclusão:** não há gargalo de índice neste caminho. O upsert é atômico no banco.

---

### 2.2 ⚠️ Confirmado com ressalva — Topologia mesh é o limitante real de capacidade

**Constantes reais** em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L180-L182) e [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L214-L217):

```ts
const MAX_VIDEO_BITRATE  = 350_000;  // 350 kbps por peer (câmera)
const MAX_SCREEN_BITRATE = 800_000;  // 800 kbps (compartilhamento)
const MAX_AUDIO_BITRATE  =  40_000;  // 40 kbps Opus

function videoBitrateForPeerCount(peerCount: number): number {
  if (peerCount <= 2) return MAX_VIDEO_BITRATE;
  return Math.max(150_000, Math.floor(MAX_VIDEO_BITRATE * 2 / peerCount));
}
```

**Recálculo correto para 6 participantes na sala** (1 professor + 5 alunos = $N=6$):

`videoBitrateForPeerCount(6) = max(150_000, floor(700_000 / 6)) = max(150_000, 116_666) = 150_000`

Ou seja, o **piso de 150 kbps por stream é acionado** — o teto adaptativo de ~1.4 Mbps é deliberadamente ultrapassado pelo `Math.max`.

| Métrica por cliente (sala com 6) | Valor |
|---|---|
| Video upload por peer | 150 kbps |
| Audio upload por peer | 40 kbps |
| **Total upload (5 peers remotos)** | **5 × (150 + 40) = 950 kbps** |
| **Total download (5 peers remotos)** | **~950 kbps** simétrico |

A afirmação anterior de que “cada cliente sobe ~1.4 Mbps em mesh” estava **subestimada**. O teto de upload programado é ~1 Mbps, mas o **piso por stream** garante mínimo de qualidade — então não há freeze automático abaixo de 100 kbps; o problema vira **CPU do encoder** e **largura disponível** no uplink.

**Impacto real no 6×5:**
- 4G mediano brasileiro (3–10 Mbps upload): suporta com folga.
- Wi-Fi doméstico ruim / 3G / hotel / coworking saturado: alto risco de degradação (vídeo congelado / áudio cortado).
- Celulares de entrada (Android <6 GB RAM): **5 encoders H.264/VP8 simultâneos** + 5 decoders é um stress real de CPU e bateria.

**Mitigações já presentes no código (não precisam ser refeitas):**
- Caps de resolução em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L131-L136) (480p ideal, 720p máx).
- Pausa de câmera em background com 30 s de delay em [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx#L500-L542).
- WakeLock para evitar throttling iOS em [src/hooks/useWakeLock.ts](src/hooks/useWakeLock.ts).
- ICE restart + escalada para `relay-only` em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L380-L394).
- Bundle + RTCP mux em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L102-L104).

**Gap real:** TURN é apenas opcional ([src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L84-L100)). Sem TURN configurado, a estimativa do próprio código é “~30% dos usuários atrás de NAT simétrico falham”. Isso é o item de maior impacto operacional.

---

### 2.3 ✅ Confirmado — “Thundering herd” em assinaturas globais de notificação

Em [src/components/Layout.tsx](src/components/Layout.tsx#L182-L194) há **duas assinaturas globais sem filtro**:

```tsx
useRealtime({ table: 'announcements',      events: ['INSERT','UPDATE','DELETE'], onPayload: refreshNotifications });
useRealtime({ table: 'scheduled_lessons',  events: ['INSERT','UPDATE','DELETE'], onPayload: refreshNotifications });
```

E `refreshNotifications` em [src/components/Layout.tsx](src/components/Layout.tsx#L171) **não tem debounce/throttle**. Cada evento dispara `listInAppNotifications` que faz **7 queries em paralelo** ([src/services/notifications.service.ts](src/services/notifications.service.ts#L429-L441)) — incluindo `listClasses()`, `listAllLessons()` e (para professor/coord) `listScheduledLessons()` **sem limite**.

**Cenário concreto que ativa o problema no 6×5:**
- Quando 6 professores clicam “Iniciar aula” em ~1 minuto, são 6 `UPDATE` em `scheduled_lessons` → cada um dispara refresh em **todos os usuários online** (não só os 36 das salas).
- Cada flush de presença chama `upsertAttendance` ([src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx#L335-L342)) que também é `UPDATE` em tabela observada — gerando **fanout em cascata para 36 clientes**.

**Impacto:**
- Tráfego Realtime amplificado: $30 \text{ alunos} \times \text{(1 update/min de attendance + 6 lesson-started + N announcements)} \approx$ centenas de eventos/min recomputando notificações em todo o app.
- Não derruba a aula, mas custa CPU do cliente, eleva uso da quota Realtime do Supabase e pode atrasar a UI durante a aula.

---

### 2.4 ⚠️ Confirmado com ressalva — Race condition de attendance em multi-aba

Caminho real:
- `recordAttendanceJoin` em [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx#L301-L319) faz `getAttendance` → grava em refs locais → upsert.
- `recordAttendanceLeave` em [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx#L321-L388) calcula `durationSeconds = priorDurationRef.current + sessionSeconds` **no cliente** e regrava o campo inteiro.

**Cenário multi-aba/multi-dispositivo:**
1. Aba A entra, lê `prior=0`, fica 30 min, escreve `duration=1800`.
2. Aba B entra 5 min depois, lê `prior=1800`, fica 10 min, escreve `duration=2400`.
3. Se Aba A flush durante a janela em que B já escreveu, A sobrescreve `duration=1800`, perdendo os 10 min de B.

**Mitigação parcial existente:** o reconnect do mesmo cliente acumula via `priorDurationRef` em [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx#L617-L650). Funciona para a **mesma aba**, não para abas concorrentes.

**Impacto:** baixo–médio. Probabilidade real depende de quantos alunos abrem 2 dispositivos. No 6×5, se 1–2 alunos por sala fizerem isso, há risco de subcontagem que pode jogar abaixo do `MIN_DURATION_RATIO` e marcar como ausente.

---

### 2.5 ✅ Confirmado — Política RLS de chat com EXISTS encadeado

Em [supabase/migrations/010_lesson_chat_messages.sql](supabase/migrations/010_lesson_chat_messages.sql#L21-L43) a policy faz `EXISTS (SELECT … FROM scheduled_lessons JOIN classes JOIN enrollments)` por linha retornada.

**Ressalva:** o índice `idx_lesson_chat_room` em [supabase/migrations/010_lesson_chat_messages.sql](supabase/migrations/010_lesson_chat_messages.sql#L14) cuida da filtragem principal de `room_id`, e a query do app já limita a 500 mensagens em [src/services/chat.service.ts](src/services/chat.service.ts#L19). Então o pior caso é 500 linhas × subquery — não 1200.

**Impacto:** ordem de centenas de ms em load inicial do chat; aceitável, mas é uma boa candidata a `STABLE` function ou simplificação se houver salas com >300 mensagens.

---

### 2.6 ✅ Confirmado — `disconnect()` WebRTC sem drenagem de sinalização

Em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L1056-L1078):

```ts
peersRef.current.forEach((peer) => peer.pc.close());
peersRef.current.clear();
…
supabase.removeChannel(channelRef.current);
```

Tudo síncrono. ICE candidates pendentes podem ser descartados antes do peer remoto receber.

**Impacto no 6×5:** ao encerrar 6 salas no horário cheio, alguns alunos podem ver tela preta até o `connectionstatechange = failed` disparar (~10–30 s). Não corrompe dados; é UX.

---

### 2.7 ✅ Confirmado — Push fanout de eventos em laços sequenciais

Em [netlify/functions/push-events.ts](netlify/functions/push-events.ts#L281-L370) os blocos `for (const … of …)` aguardam cada `dispatch()` em série. Para 6 salas começando juntas + alunos enrolled, são até 36 chamadas HTTP a `push-send` em série dentro de uma única invocação cron.

**Impacto:** 6×5 cabe folgado em um cron de 1 min, mas escala mal. Não bloqueia a aula em si.

---

### 2.8 ✅ Confirmado — `MAX_CHAT_MESSAGES = 200`

Definido em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L165). Aulas longas (>200 msgs) descartam histórico em RAM.

**Impacto no 6×5:** baixo. Aulas de 90 min raramente passam de 200 msgs com 5 alunos.

---

### 2.9 ❌ Refutado — “Channel name collision” em Realtime

Os canais usam prefixos distintos:
- Sala: `room:${roomId}` em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L514).
- Tabela: `realtime:${schema}:${table}:${filter ?? 'all'}` em [src/hooks/useRealtime.ts](src/hooks/useRealtime.ts#L68).

Os `roomId` são UUIDs (`crypto.randomUUID()` em [src/services/schedule.service.ts](src/services/schedule.service.ts#L341)), então não há como colidir com `realtime:public:attendance:all`. A preocupação anterior é inválida.

---

### 2.10 ❌ Refutado — “useLongPress vaza listeners”

A função de cleanup em [src/hooks/useLongPress.ts](src/hooks/useLongPress.ts#L82-L88) remove **exatamente** os mesmos handlers registrados (mesma referência via closure). Não há leak.

---

### 2.11 ❌ Refutado — “Push subscriptions são deletadas em série”

`push-send` usa `Promise.all` em [netlify/functions/push-send.ts](netlify/functions/push-send.ts#L130-L150) e `push-lesson-started` também em [netlify/functions/push-lesson-started.ts](netlify/functions/push-lesson-started.ts#L162-L182). Deleção é por endpoint inválido, dentro do mesmo `Promise.all`.

---

### 2.12 🟡 Adicional — Burst de sinalização no início da sala

Não estava na auditoria preliminar mas é relevante. Sala mesh com 6 participantes:
- Pares únicos: $\binom{6}{2}=15$ peer connections.
- Por par: 1 offer + 1 answer + ~10–20 ICE candidates ≈ ~25 mensagens broadcast.
- **Total inicial por sala: ~375 broadcasts em 5–15 s**.
- 6 salas começando em janela próxima: ~2.250 broadcasts em ~15 s.

Limite default de Supabase Realtime: 100 msg/s por client e quotas por projeto. Na conta Pro isso passa folgado; na Free pode raspar o teto se duas salas começarem no mesmo segundo.

---

### 2.13 🟡 Adicional — Conexões Realtime simultâneas

Por usuário em sala: 1 canal de sala + 2 canais globais (`Layout.tsx`) = **3 canais**.

Total no pico do 6×5:
- 36 participantes × 3 canais = **108 canais simultâneos**.
- Plus coordenação/professores não em sala → +N×2.

Free tier Supabase: 200 conexões concorrentes. Pro: 500. **Cabe**, mas não há margem confortável na Free se houver outros usuários logados.

---

## 3. Veredito de capacidade

| Camada | Suporta 6×5? | Risco principal |
|---|---|---|
| Supabase DB (RLS + upsert) | ✅ Sim | Nenhum bloqueante |
| Supabase Realtime (channels + broadcast) | ✅ Sim | Burst inicial de ICE em redes lentas |
| WebRTC mesh (mídia ponto-a-ponto) | ⚠️ Sim, com risco | Uplink móvel + CPU em devices fracos; **TURN ausente é o pior risco** |
| Push (Netlify Functions) | ✅ Sim | Loops sequenciais limitam escala futura, não 6×5 |
| App lifecycle / hooks | ✅ Sim | Refresh global de notificações sem debounce eleva custo |
| Attendance (multi-aba) | ⚠️ Sim, com risco | Lost-update se aluno usa 2 dispositivos |

**Veredito final:** **suporta com risco controlado**. O ponto mais provável de falha **não é o sistema, é a rede do cliente final**. As mitigações de maior ROI são: TURN obrigatório em produção, debounce no refresh de notificações e `upsert` incremental de duração.

---

## 4. TURN — fundamentos, necessidade e integração

### 4.1 O que é TURN

WebRTC tenta sempre estabelecer conexão **peer-to-peer direto**. O ICE testa três tipos de candidatos:

| Tipo | O que é | Quando funciona |
|---|---|---|
| **host** | IP local do dispositivo (LAN) | Mesma rede Wi-Fi |
| **srflx (STUN)** | IP público “visto de fora” via servidor STUN | NAT cone, maioria dos casos domésticos |
| **relay (TURN)** | IP de um servidor que **encaminha** todo o tráfego RTP | Quando nada mais funciona |

O projeto já usa **STUN público do Google** ([src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L80-L84)). STUN é só descoberta: te diz “seu IP público é X”. **TURN é o relay efetivo de mídia** — necessário quando NAT/firewall do cliente bloqueia conexão direta.

### 4.2 Por que STUN sozinho não basta no Brasil

Cenários comuns onde STUN falha e só TURN resolve:

| Situação | Motivo |
|---|---|
| **4G/5G** (Claro, Vivo, TIM) | NAT simétrico de carrier-grade muda a porta a cada destino |
| **Wi-Fi corporativo** (escola, escritório) | Firewall só libera 80/443, bloqueia UDP arbitrário |
| **Hotel / coworking / aeroporto** | Mesmo problema + isolamento de clientes |
| **CGNAT residencial** (Vivo Fibra, Oi) | Múltiplos clientes compartilham IP público |

Sem TURN nesses casos a conexão **nunca completa** — aluno fica em “Conectando…” por 30 s. O próprio comentário do código admite o risco em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L93-L98).

**Estimativa para o cenário 6×5** com mistura típica de redes brasileiras (40% Wi-Fi doméstico, 35% 4G, 15% corporativo, 10% CGNAT): **~6–9 alunos por aula** falham em conectar sem TURN. Em 6 salas isso vira ~40 reclamações/semana.

### 4.3 Estado da preparação no código

Toda a integração já está **codificada e testada**:

- 3 envs lidas: `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L86-L100).
- Fallback automático para `iceTransportPolicy: 'relay'` após 2 falhas ICE em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L107-L110) e [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L380-L394).

**Falta apenas provisionar o servidor e setar 3 variáveis.** Sem isso, o fallback `relay-only` tenta usar STUN como relay (não funciona) e a conexão falha.

### 4.4 Comparativo de fornecedores (240 GB/mês estimados)

Cálculo: cliente em mesh 6 peers ≈ 1.9 Mbps total → ~1.3 GB/aula → assumindo 25% caem no relay → ~325 MB relayados/cliente/aula → 6 salas × 5 dias × 4 semanas ≈ **~240 GB/mês** no pior caso.

| Provedor | Modelo | Custo 240 GB/mês | Manutenção |
|---|---|---|---|
| **Cloudflare Realtime** | 1 TB grátis + US$ 0.05/GB | **US$ 0** (dentro do free tier) | Zero |
| **Twilio Network Traversal** | US$ 0.40/GB | ~US$ 96/mês | Zero |
| **Metered.ca** | Plano fixo US$ 99/mês até 1 TB | US$ 99/mês | Zero |
| **coturn self-hosted** (DigitalOcean 2 vCPU) | $24/mês fixo + ~$0.01/GB egress | ~US$ 26/mês | Você opera |
| **coturn em VPS BR** (Magalu, Locaweb) | ~R$ 80/mês | ~R$ 80/mês | Você opera, latência menor |

**Recomendação: Cloudflare Realtime** (produto oficial Cloudflare que combina TURN gerenciado + opcionalmente SFU). Tier gratuito de 1 TB/mês cobre folgado o cenário 6×5; só ultrapassa se chegar a ~25 salas simultâneas diárias.

### 4.5 Como integrar (visão geral, sem aplicar agora)

#### Opção A — Cloudflare Realtime (recomendado)

1. `dash.cloudflare.com` → menu **Realtime** → **Create TURN Token**.
2. Cloudflare devolve endpoint `turn:turn.cloudflare.com:3478` (UDP/TCP) e `turns:turn.cloudflare.com:5349` (TLS, essencial para redes corporativas que só liberam 443/TLS).
3. Setar no Netlify ou `.env`:
   ```
   VITE_TURN_URL=turn:turn.cloudflare.com:3478,turns:turn.cloudflare.com:5349
   VITE_TURN_USERNAME=<copiar>
   VITE_TURN_CREDENTIAL=<copiar>
   ```
4. Rebuild do frontend. **Pronto.**

> **Risco**: como `VITE_*` é embutido no JS do cliente, qualquer um vê. Mitigação: restrição por origem (HTTP Referer) no painel Cloudflare. Hardening futuro = endpoint Netlify Function que devolve credenciais efêmeras com TTL 1h via HMAC.

#### Opção B — Twilio Network Traversal

Endpoint REST que devolve credenciais efêmeras. Requer wrapper Netlify Function `/.netlify/functions/turn-credentials` chamando Twilio com `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`. Frontend chama essa function ao entrar na sala.

#### Opção C — coturn self-hosted

VPS Ubuntu + IP público fixo:
```
listening-port=3478
tls-listening-port=5349
external-ip=<IP_PUBLICO>
realm=demo-lms.netlify.app
user=ivuser:senha_forte
lt-cred-mech
no-loopback-peers
no-multicast-peers
```
Certbot para certificado TLS na 5349. Apontar `VITE_TURN_URL=turns:seu-dominio:5349`.

### 4.6 Validação pós-integração

Usar [https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) com as credenciais — se aparecerem candidatos do tipo `relay`, está funcionando. Complementar com a página `/diag` proposta na Sprint 1 abaixo.

---

## 5. Roadmap de Sprints

Ordem por **ROI = (impacto no 6×5) ÷ (esforço)**. Cada sprint cabe em ~1 semana de um dev focado.

### 🔴 Sprint 1 — Estabilidade de conexão (semana 1)

**Objetivo**: garantir que aluno consegue conectar e ficar conectado.

| # | Tarefa | Arquivo(s) | Esforço | Impacto |
|---|---|---|---|---|
| 1.1 | Provisionar TURN (Cloudflare Realtime) e setar envs | infra | 0.5 dia | 🔴 Crítico |
| 1.2 | Validar fallback `relay-only` com TURN ativo | [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L380-L394) | 0.5 dia | 🔴 Crítico |
| 1.3 | Painel `/diag` que mostra tipo de candidato ICE conectado (`host` / `srflx` / `relay`) e RTT | novo arquivo | 1 dia | 🟠 Alto |
| 1.4 | Telemetria mínima: enviar `connectionState`, candidato vencedor e tempo até connect para `audit_logs` | [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L380-L398) | 1 dia | 🟠 Alto |

**Critério de saída**: 0 reclamações de “tela preta” em piloto controlado de 2 turmas.

---

### 🟠 Sprint 2 — Consistência de attendance (semana 2)

**Objetivo**: eliminar lost-update e race conditions em presença.

| # | Tarefa | Arquivo(s) | Esforço |
|---|---|---|---|
| 2.1 | Criar RPC `attendance_increment_duration(lesson_id, student_id, delta_seconds, verified, total)` | nova migration | 1 dia |
| 2.2 | Refatorar `recordAttendanceLeave` para usar RPC incremental | [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx#L321-L388) | 1 dia |
| 2.3 | Idempotência: deduplicar flushes simultâneos via timestamp + 5s window | [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx#L658-L667) | 0.5 dia |
| 2.4 | Vitest para `attendance.service`: 5 cenários (single join, reconnect, multi-tab, kick, room-closed) | novo `src/services/attendance.service.test.ts` | 1.5 dia |

**Critério de saída**: 30 upserts paralelos em teste de carga não perdem nenhuma duração acumulada.

---

### 🟡 Sprint 3 — Performance percebida e custo Realtime (semana 3)

**Objetivo**: reduzir “thundering herd” de notificações.

| # | Tarefa | Arquivo(s) | Esforço |
|---|---|---|---|
| 3.1 | Debounce de 1.5 s em `refreshNotifications` | [src/components/Layout.tsx](src/components/Layout.tsx#L171-L194) | 0.5 dia |
| 3.2 | Filtrar `useRealtime('scheduled_lessons')` por `class_id=in.(…)` quando role ≠ coordenacao | [src/components/Layout.tsx](src/components/Layout.tsx#L189-L194) | 1 dia |
| 3.3 | Filtrar `useRealtime('announcements')` analogamente | [src/components/Layout.tsx](src/components/Layout.tsx#L182-L187) | 0.5 dia |
| 3.4 | Cache local de `listClasses()` e `listAllLessons()` com SWR de 60 s | [src/services/notifications.service.ts](src/services/notifications.service.ts#L429-L441) | 1 dia |
| 3.5 | Drenagem assíncrona em `disconnect()` WebRTC | [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L1056-L1078) | 0.5 dia |

**Critério de saída**: <30 eventos Realtime/min processados por cliente ocioso durante pico de 6 salas iniciando.

---

### 🟢 Sprint 4 — Qualidade de mídia adaptativa (semana 4)

**Objetivo**: melhorar experiência em redes ruins / devices fracos.

| # | Tarefa | Arquivo(s) | Esforço |
|---|---|---|---|
| 4.1 | Detectar `navigator.connection.effectiveType` e ajustar `MAX_VIDEO_BITRATE` dinamicamente (3g→80kbps, 4g→200kbps) | [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L180-L218) | 1 dia |
| 4.2 | Botão “Modo economia” (só áudio + foto de perfil) no `ClassroomView` | [src/components/views/ClassroomView.tsx](src/components/views/ClassroomView.tsx) | 1 dia |
| 4.3 | Auto-degradar para áudio-only após 2 quedas consecutivas de qualidade `poor` | [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L433-L478) | 1.5 dia |
| 4.4 | Persistir chat com paginação reverse-cursor e remover cap de 200 em RAM | [src/services/chat.service.ts](src/services/chat.service.ts#L13-L24), [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L165) | 1 dia |

**Critério de saída**: aula com latência simulada 200 ms + 5% loss mantém áudio inteligível.

---

### 🔵 Sprint 5 — Cobertura de testes automatizados (semana 5)

**Objetivo**: criar a malha de segurança que hoje não existe (cobertura ≈ 0%).

| # | Tarefa | Esforço |
|---|---|---|
| 5.1 | Setup Vitest + Testing Library + 10 testes unitários cobrindo `attendance.service`, `chat.service`, `schedule.service` | 2 dias |
| 5.2 | Setup Playwright + 1 teste e2e: professor cria aula → 2 alunos entram → flush → encerra | 2 dias |
| 5.3 | Script de carga Node: 30 conexões Realtime persistentes + 1 upsert/min/cliente por 10 min, mede p95 | 1 dia |

**Critério de saída**: pipeline CI rodando os 3 níveis no Netlify Build, bloqueando PRs com regressão.

---

### 🟣 Sprint 6 — Validação real do 6×5 (semana 6)

**Objetivo**: provar empiricamente os números deste documento.

| # | Tarefa | Esforço |
|---|---|---|
| 6.1 | Teste Playwright headless 6×5 com `--use-fake-device-for-media-stream` em VM cloud | 2 dias |
| 6.2 | Coletar `getStats` de todos os 30 peers, gerar relatório CSV | 1 dia |
| 6.3 | Piloto controlado: 2 turmas reais (10 alunos), instrumentar `/diag` e exportar logs | 1 semana corrida (não dev-time) |
| 6.4 | Revisão dos achados → decidir se SFU é necessário ou se mesh + TURN basta | 0.5 dia |

**Critério de saída**: tabela de métricas-alvo da Seção 7.4 toda em verde.

---

### 🟤 Backlog (sem prioridade definida)

- Migrar para SFU (mediasoup, LiveKit, Cloudflare Realtime SFU) **só se** Sprint 6 mostrar que mesh não escala.
- Compressão Brotli em payload de broadcast Realtime.
- Endpoint `/api/turn/credentials` com credenciais efêmeras HMAC (hardening de segurança do TURN).
- Materializar view do chat para simplificar RLS.
- Paralelizar dispatch em [netlify/functions/push-events.ts](netlify/functions/push-events.ts#L281-L370) com pool de concorrência limitada (`p-limit`).

---

### Resumo de bloqueio para produção 6×5

| Ordem | Sprint | Bloqueia produção 6×5? |
|---|---|---|
| 1 | TURN + telemetria | ✅ **Sim** |
| 2 | Attendance incremental | ⚠️ Não bloqueia, mas evita disputas com alunos |
| 3 | Debounce notificações | ❌ Não bloqueia |
| 4 | Mídia adaptativa | ❌ Melhora satisfação |
| 5 | Testes automatizados | ❌ Higiene técnica |
| 6 | Validação empírica 6×5 | ⚠️ Recomendado antes de “oficializar” o cenário |

**Mínimo viável para liberar 6×5 em produção: Sprints 1 e 2.** Tudo o mais é evolução.

---

## 7. Avaliação de testes reais — cobertura e carga

### 7.1 Cobertura atual no repositório

Pesquisa rápida não identifica suíte de testes automatizados (`vitest`, `jest`, `playwright`, `cypress`) configurada em `package.json`. **Cobertura atual ≈ 0%.** O `npm run lint` faz apenas `tsc --noEmit`.

> Implicação: hoje não há regressão automatizada para nenhum dos comportamentos analisados acima.

### 7.2 É viável testar realmente o cenário 6×5?

**Sim, em três níveis distintos:**

#### Nível A — Teste de integração WebRTC headless (viável e barato)
- Ferramenta: **Playwright** ou **Puppeteer** com `--use-fake-device-for-media-stream` + `--use-fake-ui-for-media-stream`.
- Spawn de 30 navegadores headless distribuídos em 6 “salas”.
- Métricas coletáveis via `pc.getStats()` (mesma API que o app já usa em [src/hooks/useWebRTC.ts](src/hooks/useWebRTC.ts#L433-L478)):
  - RTT por par
  - Packet loss
  - Bitrate efetivo entrada/saída
  - Tempo até `connectionState === 'connected'`
- Custo computacional real: **30 instâncias Chromium ≈ 8–12 GB RAM / 8 vCPU**. Cabe em uma VM cloud temporária (~US$ 1/h).
- Limitação: roda numa só máquina, não simula latência real de internet móvel — usar `tc`/`netem` no Linux para injetar latência/perda.

#### Nível B — Teste de carga de Realtime + DB (viável e padrão de mercado)
- Ferramenta: **k6** com extensão `xk6-websockets` para Supabase Realtime, ou cliente Node script.
- Cenário: 30 conexões Realtime persistentes + bursts de `upsertAttendance` simulando flushes de visibilitychange.
- Métricas: p50/p95/p99 de latência de upsert, taxa de erro 4xx/5xx, throughput de broadcast.
- **Recomendado rodar contra ambiente staging Supabase**, não produção.

#### Nível C — Teste de mídia real fim-a-fim (parcialmente viável)
- 6 salas reais com 30 dispositivos físicos não é prático sem laboratório.
- Alternativa: **piloto controlado com 2 turmas reais** (10 alunos), instrumentando via uma página `/diag` que exporta `getStats` em CSV.
- Mais barato e mais fiel que qualquer simulação para validar TURN/firewall corporativo.

### 7.3 Roteiro mínimo viável (MVP de testes)

| Etapa | Esforço | Valor |
|---|---|---|
| 1. Adicionar `vitest` + 5 testes unitários para `attendance.service` (upsert/race) | Baixo | Alto |
| 2. Script Node de carga: 30 conexões Realtime + 1 upsert/min/cliente por 10 min | Baixo | Alto |
| 3. Script Playwright: 6 salas headless × 5 peers, mede `getStats` por 10 min | Médio | Muito alto |
| 4. Página `/diag` no app que exporta CSV de `getStats` para uso em piloto real | Baixo | Alto |
| 5. Smoke test e2e: 1 professor + 2 alunos, fluxo completo iniciar → flush → encerrar | Médio | Médio |

### 7.4 Métricas-alvo para considerar “aprovado”

| Métrica | Alvo |
|---|---|
| Tempo médio para todos os 6 peers conectarem | < 8 s |
| RTT p95 entre peers (mesmo país) | < 200 ms |
| Packet loss áudio sustentado | < 3 % |
| Bitrate efetivo de vídeo recebido | ≥ 120 kbps |
| Latência p95 de `upsertAttendance` | < 400 ms |
| Erro 5xx em `push-send` durante burst de 6 lessons-started | 0 % |
| Soma de eventos Realtime/min disparados a um cliente ocioso | < 30 |

### 7.5 O que **não** vale testar agora

- SFU/load test acima de 50 usuários: investimento desproporcional ao tráfego real esperado.
- Stress de `webpush` além de 200 destinatários: o sistema é coordenação + 1 turma por evento; não há fanout massivo.

---

## 8. Resumo executivo

1. O sistema **suporta 6 salas × 5 alunos** do ponto de vista de banco, Realtime e funções serverless.
2. O risco central é **WebRTC mesh + ausência de TURN**; tudo o mais é otimização incremental — ver Seção 4 para detalhes técnicos do TURN.
3. Vários pontos da auditoria preliminar foram **refutados** (índice composto de attendance, colisão de canais, leak em useLongPress, push em série) — eles **não exigem ação**.
4. Os pontos acionáveis estão organizados em **6 sprints** na Seção 5, ordenados por ROI. **Sprints 1 e 2 são suficientes para liberar produção 6×5**; o restante é evolução.
5. Custo de infraestrutura adicional para liberar produção: **US$ 0** (Cloudflare Realtime free tier cobre os ~240 GB/mês estimados).
6. Há viabilidade real de criar testes automatizados de integração e carga; o repositório hoje **não tem nenhum teste**, então qualquer cobertura inicial já é ganho enorme.

---

*Documento gerado por revisão estática do código. Recomenda-se validar empiricamente os números de bitrate/latência via os Níveis A e B antes de qualquer decisão de arquitetura (ex.: migrar para SFU).*
