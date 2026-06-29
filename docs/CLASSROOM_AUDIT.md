# Auditoria — Sala de Aula (Videoconferência)

> Auditoria realizada em 15/04/2026 sobre `ClassroomView.tsx`, `useWebRTC.ts`, `server.ts`, `useSpeakingDetection.ts`

---

## Achados Problemáticos

### BUG #1 — `syncPeers()` sobrescreve estado de áudio/vídeo remoto
**Severidade: Alta** | Arquivo: `useWebRTC.ts`

O `syncPeers()` reconstrói a lista de peers sempre com `audioEnabled: true, videoEnabled: true` hardcoded, sobrescrevendo o estado real recebido via socket `peer-state-change`. Resultado: peers mutados/com câmera desligada aparecem como ativos na UI.

### BUG #2 — Listeners duplicados no `join-room` (server)
**Severidade: Alta** | Arquivo: `server.ts`

Os handlers de `offer`, `answer`, `ice-candidate`, `peer-state-change`, `chat-message`, `mute-participant`, `kick-participant`, `mute-all`, `close-room` são registrados **dentro** do handler `join-room`. Se reconectar, os listeners se acumulam — mensagens/signaling duplicados.

### BUG #3 — SettingsPopover não funcional durante chamada
**Severidade: Média** | Arquivo: `ClassroomView.tsx`

Os `<select>` de dispositivos no SettingsPopover não possuem `onChange` e não trocam o stream ativo. Puramente decorativo.

### GAP #4 — Botão "Silenciar Todos" ausente no cliente
**Severidade: Baixa** | Arquivo: `ClassroomView.tsx`

O server implementa `mute-all` mas o cliente não expõe um botão para o host disparar essa ação.

### GAP #5 — Chat sem persistência / sem histórico
**Severidade: Baixa** | Archivos: `server.ts`, `useWebRTC.ts`

Mensagens de chat são relay-only. Novos participantes não veem mensagens anteriores. Refresh da página perde tudo.

### GAP #6 — Socket sem autenticação (JWT)
**Severidade: Média** | Arquivo: `server.ts`

O `userId` no `join-room` vem do próprio cliente sem validação. Um client malicioso poderia enviar qualquer `userId` e assumir controle de host.

---

## Fases de Correção

### Fase 1 — Bugs Críticos (funcionalidade quebrada)
- [x] **BUG #1**: Manter estado `audioEnabled`/`videoEnabled` por peer no `syncPeers()`
- [x] **BUG #2**: Mover listeners para fora do `join-room`; usar variáveis de escopo do socket

### Fase 2 — Funcionalidade Incompleta
- [x] **BUG #3**: SettingsPopover funcional com troca de dispositivo em tempo real
- [x] **GAP #4**: Adicionar botão "Silenciar Todos" na barra de controles do host

### Fase 3 — Melhorias de Robustez
- [x] **GAP #5**: Buffer de mensagens no server, enviar histórico no join
- [x] **GAP #6**: Autenticação JWT no handshake do Socket.IO

### Descartado (não é problema atual)
- Sem servidor TURN — será adicionado quando necessário para redes restritivas

---

## Progresso

| Fase | Status | Data |
|------|--------|------|
| Fase 1 | ✅ Concluída | 15/04/2026 |
| Fase 2 | ✅ Concluída | 15/04/2026 |
| Fase 3 | ✅ Concluída | 15/04/2026 |
