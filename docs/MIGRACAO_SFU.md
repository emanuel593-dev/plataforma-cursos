# Migração para SFU — Cloudflare Realtime

> Plano técnico de migração de **mesh P2P** para **SFU (Selective Forwarding Unit)**
> usando **Cloudflare Realtime SFU**, mantendo o TURN da Cloudflare já configurado.
>
> Status: **planejamento**. Sem implementação até decisão.
> Discussão: ver thread "fase média/longa" da auditoria.

---

## 1. Por que migrar?

### 1.1 Arquitetura atual (mesh P2P)

```
            Aluno A ────── audio/video ──────► Aluno B
              │  ▲                                ▲ │
              │  └────────── audio/video ─────────┘ │
              │                                     │
              └─────────── audio/video ─────────► Aluno C
                                                    │
              ┌──────────── audio/video ◄───────────┘
              ▼
            Professor
```

- Cada participante mantém uma `RTCPeerConnection` para **cada outro** participante.
- Em uma sala com `N` pessoas, cada cliente envia `N-1` cópias de seu próprio
  vídeo/áudio (upload) e recebe `N-1` streams (download).
- Mídia **não passa por nenhum servidor nosso** — é direto cliente↔cliente, com
  fallback para o TURN da Cloudflare quando o NAT bloqueia (~15-20% dos casos).

**Implicações práticas (caps atuais: vídeo 350 kbps, áudio 40 kbps por stream):**

| Sala | Upload por cliente | CPU encode |
|------|--------------------|------------|
| 4 pessoas | ~1,17 Mbps | 3 encoders |
| 6 pessoas | ~1,95 Mbps | 5 encoders |
| 8 pessoas | ~2,73 Mbps | 7 encoders |
| 10 pessoas | ~3,51 Mbps | 9 encoders |
| 12 pessoas | ~4,29 Mbps | 11 encoders |

A partir de ~9 pessoas, qualquer aluno em ADSL doméstico (5-10 Mbps de upload)
está consumindo 35-50% do upload em vídeo, sem sobra para overhead, retransmissões
e áudio limpo. Em celular 4G isso é ainda pior — bateria drena rapidamente
porque o encoder roda em loop apertado.

### 1.2 Arquitetura com SFU

```
       Aluno A ──── 1 stream up ────► [ SFU CF ] ──── streams ────► Aluno B
                                          │  ▲                          ▲
                                          │  └──── 1 stream up ─────────┘
       Professor ── 1 stream up ────►     │
                                          │
                            streams ◄─────┘
                              │
                              ▼
                            Aluno C
```

- Cada cliente sobe **1 cópia** do seu vídeo/áudio para o SFU.
- O SFU **encaminha** (não decodifica/reencoda) para cada peer interessado.
- Com **simulcast**, cada cliente publica 2-3 camadas (alta/média/baixa) e o
  SFU entrega a mais adequada conforme banda do destinatário (ex.: aluno em
  thumbnail recebe a camada baixa).

**Mesma sala com SFU:**

| Sala | Upload por cliente (com simulcast) | CPU encode |
|------|------------------------------------|------------|
| 4 pessoas | ~600 kbps (simulcast 3 camadas) | 1 encoder com 3 saídas |
| 8 pessoas | ~600 kbps | igual |
| 12 pessoas | ~600 kbps | igual |
| 50 pessoas | ~600 kbps | igual |

O upload é **constante** independente do tamanho da sala. O download cresce
linearmente, mas o SFU pode mandar a camada baixa para os tiles em thumbnail —
na prática o cliente baixa **menos** dados do que em mesh.

---

## 2. Por que **Cloudflare Realtime SFU**?

| Critério | Cloudflare Realtime | LiveKit Cloud | mediasoup self-hosted |
|---|---|---|---|
| Modelo de cobrança | $0,05/GB egress | $0,001/participant-min | servidor próprio (~$50-200/mês) |
| Free tier | 1.000 GB/mês (compartilhado SFU+TURN) | 10k participantes-min/mês | n/a |
| Já integrado no projeto | Sim (TURN) | Não | Não |
| Codecs | Opus, H264, VP8, VP9, AV1, H265 | mesmos | mesmos |
| Simulcast | Suportado | Suportado | Suportado |
| DataChannels | Suportado | Suportado | Suportado |
| Gravação server-side | Via WebSocket adapter (DIY) | Nativo | DIY |
| Latência | Edge global (~50ms BR) | Edge regional | depende do servidor |
| Lock-in | Baixo (HTTP API REST) | Médio (SDK próprio) | Zero |
| Operação | Zero ops | Zero ops | DevOps real |

**Conclusão**: Cloudflare é a escolha óbvia para nosso perfil — preço imbatível,
free tier generoso, **mesma conta/dashboard/credencial** que já usamos para TURN,
e tráfego TURN↔SFU **não é cobrado em dobro**.

### 2.1 Estimativa de custo real

Premissa atual: 4 turmas × 1 aula/semana × 2h × 8 pessoas pico = ~32 horas-aula/mês.

Egress estimado por aula (8 pessoas, simulcast realista):
- Por participante: ~190 kbps médio = ~170 MB/h
- 8 × 2h × 0,17 GB ≈ **~2,7 GB por aula**
- 16 aulas/mês × 2,7 GB ≈ **~43 GB/mês** → 4% do free tier

Projeção multi-filial (10 filiais, mesmo perfil): ~430 GB/mês → ainda free.
Ponto de quebra (passa do free tier): ~23 filiais. Acima disso: **$0,05/GB**.

### 2.2 Limites técnicos

- **Sem cobrança por sessão, participante ou minuto** — só egress.
- 50 API calls/segundo por sessão.
- Até 64 tracks por API call (mais que suficiente).
- Track expira em 30 s sem mídia (cleanup automático).
- PeerConnection deve estar `connected` para operar (timeout de 5 s).
- Codecs áudio: Opus, G.711 (já usamos Opus).
- Codecs vídeo: H264, H265, VP8, VP9, AV1.

---

## 3. Benefícios concretos

### 3.1 Para o aluno
- **Bateria de celular**: ~1/N do consumo de encode. Em uma sala de 8, gasta ~7×
  menos CPU/bateria publicando vídeo.
- **Conexões fracas**: alunos em 4G rural ou ADSL com upload ruim conseguem
  participar de salas grandes sem travar — antes saturavam com 4-5 peers.
- **Qualidade adaptativa**: SFU manda menos bits para tiles em thumbnail e mais
  para o tile em foco.

### 3.2 Para o professor
- **Compartilhar tela em sala grande**: no mesh, screen share (800 kbps) × N peers
  satura o upload. No SFU, sobe 1× e o SFU distribui.
- **Áudio mais limpo**: menos jitter porque há um único hop estável (cliente↔CF)
  em vez de N caminhos diferentes.

### 3.3 Para a plataforma
- **Escalabilidade**: hoje o limite prático é ~10 pessoas. Com SFU, salas de
  30-50 viram viáveis sem mudanças de produto.
- **Telemetria centralizada**: o SFU expõe métricas de cada track via API, o que
  facilita debug ("aluno X teve 12% de packet loss durante o item Y").
- **Gravação server-side**: futuro. Hoje a gravação seria client-side (instável).
  Com SFU dá para conectar um WHEP recorder que grava sem afetar os clientes.

### 3.4 O que **não** muda
- **Custo de servidor próprio**: continua $0 (Netlify free tier para sinalização).
- **Privacidade**: a mídia passa pela Cloudflare (não é E2E), mas TURN já
  fazia isso em ~20% dos casos. Para nossa aplicação (aulas de igreja, não
  telemedicina), é aceitável.
- **Stack**: continua TypeScript + Supabase + Netlify Functions. SFU é só uma
  HTTP API que substitui parte da sinalização.

---

## 4. Caminho de migração

### 4.1 Pré-requisitos (1 dia)

1. Criar **App Realtime SFU** no dashboard Cloudflare:
   - Dashboard → **Realtime** → **SFU** → "Create App".
   - Anotar **App ID** e **App Secret**.
2. Adicionar variáveis de ambiente no Netlify:
   - `CLOUDFLARE_REALTIME_APP_ID`
   - `CLOUDFLARE_REALTIME_APP_SECRET`
   - (TURN já está configurado: `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`)
3. Estudar a [Connection API](https://developers.cloudflare.com/realtime/sfu/https-api/):
   - `POST /apps/{appId}/sessions/new` → cria sessão (retorna `sessionId`)
   - `POST /apps/{appId}/sessions/{sessionId}/tracks/new` → publica tracks
   - `POST /apps/{appId}/sessions/{sessionId}/tracks/close` → encerra
   - `PUT /apps/{appId}/sessions/{sessionId}/renegotiate` → nova SDP

### 4.2 Implementação (1 sprint, ~5-7 dias úteis)

**Fase 1 — Backend (Netlify Functions)**

Novo arquivo `netlify/functions/sfu-session.ts`:
- POST com `{ roomId, userId, action: 'new'|'publish'|'subscribe' }`
- Proxy autenticado para a API REST da Cloudflare (esconde `App Secret`).
- Reaproveita verificação de auth do Supabase (`X-Supabase-JWT`).

Novo arquivo `netlify/functions/sfu-renegotiate.ts`:
- PUT com `{ sessionId, sdp }` para renegociar quando alguém entra/sai.

**Fase 2 — Cliente (`useWebRTC`)**

Refator do hook em **dois modos**, controlados por feature flag
`iv:sfu:enabled` em localStorage:

```typescript
type Topology = 'mesh' | 'sfu';

interface UseWebRTCOptions {
  topology: Topology;
  // ... existentes
}
```

- **mesh**: caminho atual, intacto. Mantém compatibilidade.
- **sfu**:
  - 1 `RTCPeerConnection` para o SFU (não N-1 PCs).
  - `addTransceiver` para cada track local com `simulcast` configurado
    (`sendEncodings: [{ rid: 'h', scaleResolutionDownBy: 1 }, { rid: 'm', scaleResolutionDownBy: 2 }, { rid: 'l', scaleResolutionDownBy: 4 }]`).
  - Para cada peer remoto, faz `tracks/new` com `kind: 'remote'` e adiciona o
    transceiver retornado.
  - Sinalização de "quem está na sala" continua via Supabase Realtime (presence
    channel) — só substituímos a parte de transporte de mídia.

**Fase 3 — UI**

- `<TopologyIndicator>` no canto da sala mostrando "SFU" / "Mesh" para debug.
- Toggle em `ProfileView` (apenas dev/coordenação): "Forçar mesh / SFU / auto".
- Auto-detect: usar SFU se `participantes >= 5`, senão mesh.

**Fase 4 — Telemetria**

Aproveitar o `webrtc.audio_snapshot` que já temos. Adicionar campo
`topology: 'mesh' | 'sfu'` no `details` jsonb. Permite comparar qualidade
entre os dois modos durante rollout.

### 4.3 Rollout gradual (2-3 semanas)

| Semana | Quem | Modo |
|---|---|---|
| 1 | Coordenação (testes internos) | SFU forçado |
| 2 | 1 turma piloto | SFU forçado, monitorar telemetria |
| 3 | Todas as turmas | Auto-detect (SFU para ≥5 pessoas) |
| 4+ | Default mudado para SFU | Mesh vira fallback de emergência |

### 4.4 Rollback

Se algo der errado: alterar default da feature flag para `mesh` no
`localStorage` (ou em uma config remota via Supabase). Zero deploy necessário.

---

## 5. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Cloudflare Realtime ainda em **Beta** | API estável há 2 anos; demos de produção (Cloudflare Orange Meets) rodam em escala. SLA não é garantido — mitigação é manter o caminho mesh como fallback. |
| Curva de aprendizado da Connection API | Estudar repo `cloudflare/orange` (referência oficial). HTTP API é bem documentada. |
| Mudança de SDP a cada peer entrar/sair | Renegociação obrigatória. Em mesh isso já existe (uma negociação por par); no SFU é uma só, mas mais frequente. Idempotência via `tracks/new` + retries. |
| Latência adicional (+1 hop) | Negligível para ensino (~30-50 ms). Não afeta percepção. |
| Free tier estourar | Monitorar dashboard. Estimativa atual: 4% do free. Margem de 25× para crescimento. Ao atingir 70%, avaliar otimizações (codec AV1, simulcast 2 camadas em vez de 3). |
| Privacidade (mídia trafega por CF) | Aceitável para o caso de uso (aulas internas). Documentar na política de privacidade. TURN já fazia isso parcialmente. |
| Quebrar uso atual durante rollout | Feature flag + auto-detect. Sempre há fallback para mesh. |

---

## 6. Quando migrar?

### Gatilhos sugeridos (qualquer um basta)

1. **Aparecer 1ª turma com 9+ participantes ativos** — mesh começa a saturar
   nessa faixa em conexões domésticas brasileiras.
2. **Começar planejamento concreto de multi-filial** — multi-tenant em mesh é
   frágil porque não controlamos o upload das casas dos alunos.
3. **Telemetria pós-fase A/B/C indicar packet loss > 3% médio em audio_snapshot**
   por causa de saturação de upload (não de rede ruim do aluno).
4. **Reclamação recorrente de "vídeo travando" em alunos com fibra** —
   indicador clássico de saturação de mesh.

### Não-gatilhos (não precisa migrar)

- Reclamação de áudio "abaixando" → era AGC, já corrigido.
- Reclamação de "vídeo borrado" → é cap de bitrate, ajuste o cap.
- Custo do servidor → não há servidor próprio para reduzir.

---

## 7. Decisão atual

**Não migrar agora.** Razões:

1. Acabamos de aplicar correções significativas em mesh (Opus FEC, AGC off,
   bitrate caps reaplicados, telemetria). Precisamos de **2-3 aulas de baseline**
   para saber se o áudio melhorou — sem mover o transporte ao mesmo tempo.
2. Turmas atuais (5-8 pessoas) rodam bem em mesh.
3. Free tier do CF cobre tanto mesh+TURN quanto SFU futuro — não há urgência
   financeira.
4. Migração é trabalho contido (~1 sprint), pode ser feita quando demanda
   aparecer sem bloquear nada.

**Próxima reavaliação**: após 3 aulas pós-correções OU quando algum dos gatilhos
da seção 6 disparar.

---

## 8. Referências

- [Cloudflare Realtime SFU — Overview](https://developers.cloudflare.com/realtime/sfu/)
- [Connection API](https://developers.cloudflare.com/realtime/sfu/https-api/)
- [Sessions and Tracks](https://developers.cloudflare.com/realtime/sfu/sessions-tracks/)
- [Simulcast](https://developers.cloudflare.com/realtime/sfu/simulcast/)
- [Pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)
- [Limits](https://developers.cloudflare.com/realtime/sfu/limits/)
- [Orange Meets — demo oficial CF](https://github.com/cloudflare/orange)
- [Realtime vs Regular SFUs](https://developers.cloudflare.com/realtime/sfu/calls-vs-sfus/)
