# Plano de Correções — Sessão Avançada (06/05/2026)

> Status atualizado após implementação. ✅ = aplicado e build-verificado.

---

## 1. WebRTC — Áudio sem câmera ✅ (defensivo) / 🟡 a validar runtime

### Diagnóstico
Após análise profunda do `useWebRTC.ts`, o fluxo de getUserMedia + addTrack PARECE correto:
- `getUserMediaWithFallback(true, true)` falha → catch tenta `(true, false)` audio-only ✓
- `localStreamRef.current = stream` antes de criar peers ✓
- `createPeerConnection` itera `localStreamRef.current.getTracks()` e chama `pc.addTrack` para cada um ✓

Mas há um suspeito: race entre `onnegotiationneeded` (auto-disparado por addTrack) e o `createOffer` explícito no handler de presence. O ofereço auto pode ganhar e a SDP pode acabar sem `m=audio sendrecv` em casos edge.

### Fix aplicado (defensivo)
[useWebRTC.ts](src/hooks/useWebRTC.ts) — em `createPeerConnection`:
- **`pc.addTransceiver('audio', { direction: 'sendrecv' })`** explicitamente ANTES do addTrack, garantindo que a m-line de áudio sempre exista na SDP
- **`pc.addTransceiver('video', { direction: 'recvonly' })`** quando dispositivo não tem câmera local — preserva capacidade de receber vídeo dos outros
- Sender é vinculado ao transceiver pré-criado via `replaceTrack` quando possível
- **Diagnostic log**: `console.log('[IV] PC created for X', { senders: [...] })` — ao reproduzir o bug, copiar o log do console e enviar para análise

### Próximo passo se ainda falhar
Pedir ao usuário capturar o log do console do dispositivo SEM câmera ao entrar na sala. Ver se senders incluem audio. Se sim, o bug é no transporte (TURN/STUN/firewall). Se não, é negociação SDP.

### Status: ✅ código aplicado | 🟡 validação runtime pendente

---

## 2. Câmera/microfone não desligam após encerrar ✅

### Fix aplicado em [useWebRTC.ts](src/hooks/useWebRTC.ts) `disconnect()`:
- **Track stop SÍNCRONO**: removido o `queueMicrotask` ao redor de `track.stop()`. Anteriormente isso atrasava a liberação do device em ~1 frame, mas no mobile podia deixar o ícone do Chrome ativo por segundos enquanto a navegação acontecia. Agora `track.stop()` roda imediatamente, e apenas o `pc.close()` (caro) fica deferido.
- **`beforeunload`/`pagehide` safety net**: novo useEffect com listeners que param tracks se a página é fechada/navegada bruscamente, antes mesmo do React unmount

### Status: ✅ aplicado

---

## 3. Pop-up de confirmação no botão "Iniciar" ✅

[CalendarView.tsx::handleStart](src/components/views/CalendarView.tsx) usa `setConfirmOpen(true)` com mensagem:
> "Ao iniciar, a sala da aula '{título}' ficará aberta para acesso dos alunos. Você ainda precisará clicar em 'Iniciar Aula' dentro da sala para começar a contar o tempo. Deseja continuar?"

### Status: ✅ aplicado

---

## 4. Sistema de Professor Titular ✅ (3 críticos)

### O que foi aplicado

#### 4.1 Backend gating (security)
[schedule.service.ts](src/services/schedule.service.ts) — nova helper `assertLessonTitular(lessonId)`:
- Coordenação: bypass total
- Professor: precisa ser `lesson.professor_id` E lesson precisa TER `professor_id` definido
- Aplicada em `startLesson`, `markLessonStarted`, `endLesson`, `cancelLesson`
- Mensagem: "Apenas o professor titular desta aula pode executar esta ação. Solicite uma troca se necessário."
- Mensagem para aula sem titular: "Esta aula ainda não tem um professor titular designado. Peça à coordenação para atribuir um titular antes de iniciar."

#### 4.2 UI criação de aula (completeness)
[ClassDetailView.tsx](src/components/views/ClassDetailView.tsx) — modal "Agendar Nova Aula":
- Novo dropdown **"Professor titular *"** (obrigatório)
- Lista filtrada para `professors ∈ classProfessorIds` (apenas profs vinculados à turma)
- Auto-preenchido se houver apenas 1 professor na turma
- Aviso amber se nenhum prof está vinculado
- `handleCreateLesson` valida + envia `professor_id` para `createScheduledLesson`
- Texto explicativo: "Apenas o titular poderá iniciar, encerrar e gravar esta aula. A coordenação pode trocar o titular depois pela edição da aula."

#### 4.3 Realtime expectedHostId (UX/security)
[ClassroomView.tsx](src/components/views/ClassroomView.tsx) — novo useEffect:
- `supabase.channel('scheduled-lesson:{id}')` com `postgres_changes` filtrado em `id=eq.{scheduledLessonId}`
- Quando `professor_id` muda → atualiza `setExpectedHostId` ao vivo
- Bonus: também responde a `started_at` (atualiza clock) e `status='completed'` (auto-leave)
- Cleanup remove channel ao desmontar

### O que NÃO foi feito (deliberadamente fora do escopo)

| Item | Razão |
|---|---|
| Migration `NOT NULL` em professor_id | Requer backfill manual de aulas legadas. SQL sugerido: `UPDATE scheduled_lessons SET professor_id = (SELECT professor_id FROM class_professors WHERE class_id = scheduled_lessons.class_id LIMIT 1) WHERE professor_id IS NULL;` depois `ALTER TABLE ... SET NOT NULL` |
| Realtime em CalendarView (mySwaps) | UX nice-to-have; usuário pode recarregar |
| Botão "Forçar troca rápida" para coord | Coord já consegue via Editar aula → dropdown professor |

### Status: ✅ 3 itens críticos aplicados

---

## 5. Drive Upload 403 ✅ (código) / ⚠️ AÇÃO MANUAL NECESSÁRIA

### Causa raiz confirmada
OAuth feito ANTES de cadastrar test users no Google Cloud Console. **Apps em status "Testing"**:
- Refresh tokens **expiram em 7 dias**
- Refresh tokens **invalidados quando lista de Test Users muda**

### Fix de código aplicado
1. **[gdrive-token.ts](netlify/functions/gdrive-token.ts)**: detecta `invalid_grant` e retorna 401 com mensagem clara explicando o problema dos Test Users
2. **[recording.service.ts uploadToDrive](src/services/recording.service.ts)**: detecta 401/403 e gera mensagem explícita pedindo reconexão

### 🛠️ AÇÃO MANUAL — playbook de recuperação

**Passo 1 — Limpar autorização anterior:**
1. Acesse https://myaccount.google.com/permissions com `admin@demo.com`
2. Encontre o app (provavelmente "iv-cloud" ou nome do projeto)
3. Clique em **"Remover acesso"** — invalida tokens antigos

**Passo 2 — Confirmar Test Users no GCP:**
1. https://console.cloud.google.com/auth/audience?project=iv-cloud-495420
2. Status do app: **Testing**
3. Em **Test users**, confirmar que `admin@demo.com` está listado
4. **NÃO MEXER MAIS** na lista (qualquer mudança invalida tokens existentes)

**Passo 3 — Reconectar via app:**
1. Logue como coordenação
2. Vá em **Gestão → Google Drive**
3. Clique conectar → popup OAuth → escolha `admin@demo.com` → autorize
4. Backend salva novo `refresh_token` em `system_gdrive_token`

**Passo 4 — Testar:**
1. Iniciar uma aula e gravar
2. Aguardar upload
3. Se 403 ainda aparecer, copiar mensagem completa (agora explícita)

### Solução definitiva (futura)
**Publicar o app no GCP** (sair do "Testing"). Requer política de privacidade e possível verificação Google. Após publicado, refresh tokens são permanentes.

### Status: ✅ código pronto | ⚠️ ação manual pendente

---

## Resumo de arquivos modificados

| Arquivo | Mudança |
|---|---|
| `src/components/views/CalendarView.tsx` | Confirmação de Iniciar |
| `src/hooks/useWebRTC.ts` | addTransceiver defensivo + log + sync track stop + beforeunload |
| `src/services/schedule.service.ts` | `assertLessonTitular` em start/end/cancel/markStarted |
| `src/components/views/ClassDetailView.tsx` | Dropdown professor titular obrigatório |
| `src/components/views/ClassroomView.tsx` | Subscribe realtime em scheduled_lessons + import supabase |
| `netlify/functions/gdrive-token.ts` | Mensagem específica para invalid_grant |
| `src/services/recording.service.ts` | Mensagem específica para 401/403 no upload |

## Próximos passos

1. Commit + push (deploy auto via Netlify)
2. Executar playbook do Drive (#5) — passos manuais acima
3. Testar em produção e relatar se #1 (áudio sem câmera) persiste — anexar `[IV] PC created for X` log do console se sim
