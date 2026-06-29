# Auditoria Profunda: Qualidade WebRTC — Caso Turma com Problema de Áudio/Vídeo

> Investigação sem alterações de código. Baseada em leitura completa do `useWebRTC.ts` (2126 linhas), `mediaQuality.ts`, `turn-credentials.ts`, documentação interna em `/docs` e tentativa de consulta a `audit_logs` (DB local offline — apenas produção tem dados reais).

---

## 1. Resumo do Caso (Aula 15/06/2026)

| Participante | Dispositivo | Conexão | Sintoma |
|---|---|---|---|
| Professor (host) | Notebook | Wi-Fi pessoal | Transmitia áudio + vídeo |
| Aluno A | Notebook | Wi-Fi pessoal | Muitos cortes de áudio do professor |
| Aluno B | Celular | Dados móveis (4G) | Mesmos cortes de áudio |

**Pista principal:** Ao desligar o vídeo do professor, o áudio ficou estável. Isso é o dado mais revelador da investigação.

---

## 2. Arquitetura de Rede Atual (Como funciona a Sala)

### Supabase Realtime — o que faz e o que NÃO faz

O Supabase **não roteia mídia**. Ele é exclusivamente usado como "mesa telefônica":

| Evento Supabase | Função |
|---|---|
| `channel.on('presence', 'join')` | Detecta que um novo usuário entrou; dispara o WebRTC Offer |
| `channel.on('presence', 'leave')` | Remove o peer da UI e fecha o `RTCPeerConnection` |
| `broadcast: 'offer'` / `'answer'` | Troca o SDP de negociação inicial (tráfego de bytes, não de mídia) |
| `broadcast: 'ice-candidate'` | Troca os candidatos ICE (endereços de rede para o WebRTC) |
| `broadcast: 'heartbeat-ping'` | Pulso de vida de 15 em 15 segundos para detecção de zumbis |
| `broadcast: 'peer-state-change'` | Notifica os demais que alguém ligou/desligou câmera ou mic |
| `broadcast: 'mute-remote'` / `'kicked'` | Moderação — validada por assinatura do host |

Após a sinalização, todo áudio e vídeo trafegam **diretamente entre os aparelhos** (P2P), sem passar pelo Supabase.

### TURN — O Servidor Intermediário

O TURN (Cloudflare Realtime) é acionado quando a conexão P2P direta falha (ex: NAT/Firewall). Quando ativo, o **áudio e vídeo passam pelo servidor da Cloudflare**.

**Configuração identificada:**
- Provedor: **Cloudflare Realtime TURN**
- Função serverless: `netlify/functions/turn-credentials.ts` — emite credenciais com TTL de 24h
- Fallback final: apenas STUN (Google) — sem TURN — o que faz ~30% das conexões 4G/corporativas falharem completamente
- `bundlePolicy: 'max-bundle'` — toda mídia numa única conexão para economizar banda

---

## 3. Diagnóstico Técnico do Sintoma: Vídeo ON → Áudio ruim / Vídeo OFF → Áudio melhora

Este padrão é um **diagnóstico clássico de saturação de uplink do professor**. Veja o raciocínio:

### 3.1 Como o Professor Transmite no Mesh (P2P)

Em uma sala com 3 pessoas (Professor + 2 alunos), o professor abre **2 pares de conexão separados**:
- Uma conexão completa com Aluno A (enviando áudio + vídeo)
- Uma conexão completa com Aluno B (enviando áudio + vídeo)

Isso significa que o professor, com a câmera ligada, está **fazendo UPLOAD simultâneo de 2 streams de vídeo + 2 streams de áudio**.

### 3.2 A Tabela de Bitrate do Sistema

```
Vídeo por peer (≤2 alunos): MAX_VIDEO_BITRATE = 350.000 bps (350 kbps)
Áudio por peer:             MAX_AUDIO_BITRATE = 40.000 bps (40 kbps)
```

**Com câmera ligada, o professor precisa enviar:**
- Para Aluno A: 350 kbps vídeo + 40 kbps áudio = ~390 kbps
- Para Aluno B: 350 kbps vídeo + 40 kbps áudio = ~390 kbps
- **Total de UPLOAD necessário: ~780 kbps (~0,8 Mbps)**

**Com câmera desligada, o professor precisa enviar:**
- Para Aluno A: 40 kbps áudio
- Para Aluno B: 40 kbps áudio
- **Total de UPLOAD necessário: ~80 kbps**

### 3.3 O Ponto Crítico: Saturação de Uplink em Wi-Fi Residencial

Wi-Fi residencial no Brasil tem **upload tipicamente limitado** (5–10 Mbps em planos melhores, mas muitas vezes 1–3 Mbps em planos básicos). O upload é geralmente muito menor que o download.

Quando o professor precisa de 780 kbps de upload e a conexão Wi-Fi oscila ou está sobrecarregada (outros dispositivos na rede), o roteador começa a **descartar pacotes**. O WebRTC tenta manter o vídeo (maior volume), então o **áudio perde fatia de banda e começa a cortar**.

Isso explica perfeitamente o relato: desligando o vídeo, o upload cai de 780 kbps para 80 kbps, e o áudio flui sem cortes.

### 3.4 O `networkBitrateFactor` não ajuda neste caso

O sistema usa `navigator.connection.effectiveType` para reduzir bitrates em redes 2G/3G. **Porém:**
- Esta API só funciona no Chrome/Android, não no Safari/iOS e não no Firefox
- Ela reporta a qualidade de *download*, não de *upload*
- Redes Wi-Fi são sempre reportadas como `'4g'` → fator 1.0 (sem redução)

**O sistema não tem mecanismo de detecção de saturação de upload.**

### 3.5 A Auto-Degradação não protege o Professor

O mecanismo de `shouldAutoDegrade` só desativa a câmera LOCAL de quem tem qualidade ruim na RECEPÇÃO (`ConnectionQuality === 'poor'`). A lógica verifica RTT e packet loss **dos pacotes recebidos** (`inbound-rtp`), não dos enviados.

O professor pode ter excelente recepção (seus alunos chegam bem até ele) mas péssima transmissão (os pacotes que ele envia chegam cortados nos alunos). O sistema **não detecta isso automaticamente** porque `poor` é medido do ponto de vista de quem recebe.

---

## 4. O Aluno em Dados Móveis (4G) — Cenário Independente

**Situação específica do Aluno B (celular + 4G):**

O 4G tem uma característica crítica: **banda assimétrica e variável**. A qualidade do sinal muda a cada segundo conforme o aparelho se move ou alterna entre torres.

O `networkBitrateFactor()` detecta `effectiveType` no Chrome/Android e reduz o bitrate de vídeo:
- `'4g'` → fator 1.0 (sem redução — trata como boa conexão)
- `'3g'` → fator 0.4 (reduz para 140 kbps)

Mas em dados móveis **o sinal pode oscilar entre 3G e 4G em segundos**. O Chrome pode reportar `'4g'` quando na prática o link é instável.

---

## 5. Mapa Completo das Camadas de Preservação de Chamada

O sistema tem múltiplas camadas de proteção. Aqui estão todas em ordem de acionamento:

### Camada 1: Stats Monitor (a cada 5 segundos)
Coleta RTT e packet loss via `getStats()`. Classifica a qualidade:
- RTT > 300ms ou loss > 10% → `'poor'`
- RTT > 150ms ou loss > 3% → `'good'`

### Camada 2: Auto-Degradação de Vídeo (Sprint 4.3)
Após 2 amostras consecutivas `'poor'` (10 segundos), e com 30 segundos de carência após entrar e 30 segundos de carência após ligar manualmente, a câmera local é desativada automaticamente.

> **⚠️ Falha Crítica Identificada:** Este mecanismo só desativa a câmera de quem **recebe mal**. O professor com uplink saturado pode nunca ser auto-degradado porque seus alunos não enviam pings suficientes para ele (ou ele recebe bem). A saturação é unidirecional.

### Camada 3: ICE Restart (1ª falha)
Quando `connectionState === 'failed'`, `restartIce()` é chamado. Isso tenta renegociar o caminho ICE sem recriar a conexão.

### Camada 4: Escalada TURN-only (2ª falha)
Se ICE fail ocorre 2 vezes, `relayOnlyRef.current = true` e o peer é recriado forçando o roteamento exclusivo via TURN (Cloudflare). Isso resolve bloqueios de NAT, mas **adiciona latência** e pode **piorar a qualidade de upload** pois os pacotes agora têm que ir professor → Cloudflare → aluno.

### Camada 5: Timeout de Desconexão (7 segundos de graça)
`connectionState === 'disconnected'` aciona um timer de 7 segundos antes de remover o peer. Wi-Fi handoffs e oscilações 4G normalmente se resolvem nesse período.

### Camada 6: Reconexão do Canal Supabase (backoff exponencial)
Se o canal Supabase (`CHANNEL_ERROR` / `CLOSED`) cair, o sistema tenta reconectar até 5 vezes com delay de 1s, 2s, 4s, 8s, 16s. Durante este período, o WebRTC P2P continua ativo — a perda do canal Supabase não quebra a chamada, apenas impede novos peers de entrar.

### Camada 7: Zombie Watchdog
Peers que param de enviar heartbeat por mais de 45 segundos são removidos da UI, mesmo que o `RTCPeerConnection.connectionState` ainda marque `'connected'` (pode mentir após crash do OS).

---

## 6. Mapeamento de Falhas Identificadas no Código

### 🔴 FALHA CRÍTICA — Sem Detecção de Saturação de Upload
**Origem:** `mediaQuality.ts` (`shouldAutoDegrade`) + `useWebRTC.ts` (`startStatsMonitor`)
**Problema:** O sistema mede qualidade de **download** (o que chega para você), não de **upload** (o que você envia). O professor com câmera sobrecarregando seu Wi-Fi nunca aciona a auto-degradação porque seus pacotes de *recepção* chegam bem.
**Impacto Direto:** Corresponde exatamente ao sintoma da aula de 15/06/2026.

### 🟡 FALHA MÉDIA — `networkBitrateFactor` cego para upload e Safari
**Origem:** `useWebRTC.ts` L627–L653
**Problema:** A API `navigator.connection.effectiveType` não existe no Safari e no Firefox. Nesses browsers, o fator é sempre 1.0 independente da qualidade real da rede. Além disso, mesmo quando disponível, mede download, não upload. Usuários iOS (iPhone/iPad) nunca têm redução automática de bitrate.

### 🟡 FALHA MÉDIA — TURN sem confirmação de ativação
**Origem:** `turn-credentials.ts` + `getCachedIceServers()`
**Problema:** Se o endpoint `/api/turn/credentials` falhar (Cloudflare offline, Netlify Functions timeout, rede do professor bloqueando HTTPS), o sistema silenciosamente cai para STUN-only. O usuário não vê aviso. A chamada pode prosseguir mas ~30% das conexões 4G (NAT simétrico) falham sem TURN.

### 🟡 FALHA MÉDIA — `iceFailureCountRef` global, não por-peer
**Origem:** `useWebRTC.ts` L684, L995–L1006
**Problema:** O contador de falhas ICE é compartilhado entre todos os peers. Se o link com Aluno A falhar 2 vezes, o sistema ativa `relayOnlyRef = true` para TODOS os peers, incluindo o link com Aluno B que pode estar funcionando perfeitamente. Isso pode prejudicar conexões saudáveis.

### 🟢 INFO — `disconnected` aguarda 7s antes de remover peer
**Origem:** `useWebRTC.ts` L1008–L1023
**Avaliação:** Saudável. Evita o problema relatado em auditoria anterior de "múltiplas quedas" por blips de Wi-Fi.

---

## 7. Correlação com Documentação Interna

A documentação interna em `AUDITORIA_PRESENCA_E_WEBRTC.md` (criada em 12/05/2026) já havia catalogado e proposto correções para H1 (AGC), H3 (FEC/BWE) e H5 (Mesh CPU). As correções H1 (AGC default off) e H3 (SDP munging com `useinbandfec=1`) **já foram implementadas** com sucesso nas sprints anteriores.

O problema da aula de 15/06 é um **novo sintoma** que não se encaixa em H1 ou H3 (já corrigidos), mas sim numa **variante de H5 (Mesh CPU / uplink saturation)** que a documentação rotulou como "confirmar medindo `framesEncoded`".

---

## 8. Hipótese Principal e Confirmação

**Hipótese mais provável:** Saturação de uplink do professor (Wi-Fi residencial com upload limitado incapaz de sustentar 2× vídeo simultâneo de 350 kbps + 2× áudio de 40 kbps ≈ 780 kbps total).

**Como confirmar de forma definitiva:**
1. Na próxima aula dessa turma, pedir ao professor abrir o console do Chrome e colar:
   ```js
   // Cole no console do Chrome durante a aula
   setInterval(async()=>{
     for(const [id,pc] of Object.entries(window.__webrtcPeers||{})){
       const s=await pc.getStats();
       s.forEach(r=>{if(r.type==='outbound-rtp')console.log(id,r.kind,r.bytesSent,r.targetBitrate)});
     }
   },5000)
   ```
2. Observar se `targetBitrate` do áudio cai progressivamente enquanto o vídeo está ativo.
3. Verificar a aba `chrome://webrtc-internals` e olhar o gráfico `bweforvideo` (Bandwidth Estimate) — se estiver oscilando enquanto o vídeo está ativo, confirma saturação de uplink.

**Por que os outros alunos de outras turmas não reclamam?** Variáveis: plano de internet do professor diferente por turma, horário diferente (congestionamento do provedor), número de participantes diferente.

---

## 9. Conclusão

A investigação aponta que o problema é **arquitetural do modelo P2P Mesh** combinado com a **ausência de medição de qualidade de upload**. O sistema preserva bem a chamada para quedas de rede passageiras (ICE restart, TURN fallback, zombie watchdog), mas não tem mecanismo para detectar que o *emissor* (professor) está saturando seu próprio uplink com múltiplos streams de vídeo simultâneos.

A solução de curto prazo mais impactante seria permitir ao professor reduzir o bitrate de vídeo manualmente ou introduzir detecção via `outbound-rtp.qualityLimitationReason === 'bandwidth'` (disponível no Chrome) para disparar auto-degradação também do lado do emissor.

> **Sem alterações realizadas.** Este documento é puramente analítico.
