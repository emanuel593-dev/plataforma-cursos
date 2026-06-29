# Classroom (WebRTC) — Roadmap de Produção

Plano de correções para deixar a sala de aula pronta para uso em produção real.
Itens organizados por severidade. Marcar `[x]` ao concluir.

---

## 🔴 Fase 1 — Crítica (bloqueadores)

- [x] **1. Validação client-side de host nos broadcasts**
  Eventos `kicked`, `mute-remote` e `room-closed` agora carregam `senderUserId`.
  Cada cliente compara contra o host conhecido e ignora silenciosamente
  eventos forjados. Combinado com o item 6, o host é autoritativo (vem
  de `classes.professor_id`).
  *Arquivo:* `src/hooks/useWebRTC.ts`

- [ ] **2. Adicionar TURN servers** *(adiado — sem credenciais)*
  Sem TURN, ~30% das conexões falham silenciosamente em redes corporativas,
  4G/5G e NAT simétrico. Configuração já é via env, basta providenciar
  credenciais (Twilio, Metered.ca, Cloudflare Calls ou self-hosted coturn).
  Variáveis: `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`.
  *Arquivo:* `src/hooks/useWebRTC.ts`

---

## 🟠 Fase 2 — Alto

- [x] **3. Substituir `alert()` nativos por toast**
  *Arquivos:* `src/components/views/ClassroomView.tsx`

- [x] **4. Salvar relatório também ao "Sair da sala"**
  Se o host clica `PhoneOff`, agora aparece confirmação "Encerrar aula?".
  Confirmando, dispara `closeRoom()` que gera o relatório e marca a aula
  `completed`. Comportamento de aluno saindo permanece igual (apenas
  registra `attendance.left_at`).
  *Arquivo:* `src/components/views/ClassroomView.tsx`

- [x] **5. Topologia mesh — limitar bitrate por sender**
  Aplicado `RTCRtpSender.setParameters` ao adicionar tracks e ao
  trocar tracks (camera ↔ screen). Caps:
  - Vídeo (câmera): 350 kbps
  - Tela compartilhada: 800 kbps
  - Áudio (Opus): 40 kbps
  Para >8 participantes simultâneos, considerar SFU (mediasoup, LiveKit) — fora do escopo.
  *Arquivo:* `src/hooks/useWebRTC.ts`

---

## 🟡 Fase 3 — Médio

- [x] **6. Host autoritativo (sobrevive reconexão)**
  Ao invés de criar coluna nova, o `professor_id` da classe associada
  passa a ser o host de fato. `useWebRTC` aceita `expectedHostId` e o
  usa para sobrepor a heurística de presence (que vira fallback).
  Isso resolve "host perdido após reconexão" e impede que um aluno
  forje host entrando primeiro.
  *Arquivos:* `src/hooks/useWebRTC.ts`, `src/components/views/ClassroomView.tsx`

- [x] **7. AudioContext compartilhado**
  Singleton com refcount em `useSpeakingDetection`. Resolve o limite
  de ~6 AudioContexts do Chrome (que quebrava aulas com 7+ participantes).
  Resume automático se suspenso (autoplay policy).
  *Arquivo:* `src/hooks/useSpeakingDetection.ts`

- [x] **8. Unificar `joinedAtRef` / `joinedAtRef2`**
  `useWebRTC` agora expõe `getJoinedAt()`. ClassroomView removeu
  o ref duplicado e usa o do hook como fonte única da verdade.
  *Arquivos:* `src/hooks/useWebRTC.ts`, `src/components/views/ClassroomView.tsx`

---

## 🔵 Fase 4 — Baixo / melhorias

- [x] **9. Persistência de chat**
  Nova tabela `lesson_chat_messages` com RLS (alunos matriculados,
  professor da classe ou coordenação podem ler; só o autor pode inserir).
  `useWebRTC` carrega histórico ao conectar (até 500 msgs) e persiste
  cada mensagem enviada. Late-joiners e reconexões agora veem o histórico.
  *Arquivos:* `supabase/migrations/010_lesson_chat_messages.sql`,
  `src/services/chat.service.ts`, `src/hooks/useWebRTC.ts`

- [x] **10. Remover `attendanceIdRef` (código morto)**
  *Arquivo:* `src/components/views/ClassroomView.tsx`

- [x] **11. Limpar Socket.IO de `server.ts`**
  Toda lógica de salas via Socket.IO removida (era código morto após
  migração para Supabase Realtime). `server.ts` agora é apenas um
  espelho local dos endpoints Express usados no dev (`npm run server`).
  Em produção, esses endpoints são servidos pelas Netlify Functions.
  *Arquivo:* `server.ts`

---

## Próximos passos manuais

1. **Aplicar migration 010** no Supabase:
   ```bash
   supabase db push
   ```
   (ou rodar o SQL direto no painel SQL Editor se não usar CLI)
2. **(Opcional) Configurar TURN** no Netlify quando contratar:
   - `VITE_TURN_URL` (ex: `turn:relay.example.com:3478`)
   - `VITE_TURN_USERNAME`
   - `VITE_TURN_CREDENTIAL`
3. **Limpar dependências** que viraram não-usadas em `package.json` (opcional):
   - `socket.io`, `socket.io-client` se ainda estiverem listadas.
