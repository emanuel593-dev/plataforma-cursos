# Planejamento Arquitetural: Otimizações Gerais (06/2026)
Este documento mapeia a implementação tática para transformar a aplicação atual em um sistema resiliente, rápido e tolerante a falhas (Crash-Resistant) visando o médio prazo.

---

## 1. Resiliência de Gravações (IndexedDB Caching)
**Objetivo:** Impedir perda total de aulas gravadas por quedas de energia, tabs fechadas acidentalmente ou RAM estourada.
- **Instalação:** Adição da dependência `localforage` (wrapper elegante para IndexedDB).
- **Modificação em `src/hooks/useRecording.ts`:**
  - Injetar no bloco `recorder.ondataavailable` a instrução para escrever assincronamente os *blobs* sequenciais no disco local (via `localforage`), chaveados por ID da Aula.
  - No evento de encerramento limpo (`handleUpload`), assim que o Google Drive acusar sucesso, esvaziamos a chave no IndexedDB para liberar espaço.
- **Novo Hook (`useRecoverRecording`):**
  - Implementado no ciclo de vida de Login/Carregamento da aplicação.
  - Se houver vestígios de uma aula não finalizada no banco de dados local (IndexedDB), exibirá um Modal emergencial alertando sobre o rascunho.
  - **Regra de Negócio (Descarte):** Caso o professor recuse a recuperação da aula travada, o sistema **deletará imediatamente** o rascunho do disco, prevenindo acúmulos desnecessários e vazamentos de memória no IndexedDB.
  - Caso o professor aceite, o sistema junta os chunks lidos do disco e invoca o `uploadToDrive`.

---

## 2. Otimização de Chamadas e Frontend State (React Query)
**Objetivo:** Eliminar "Flashes de Loading", reduzir o uso da cota de requisições da Supabase e limpar o *boilerplate* do React. A migração será feita de forma **gradual**, priorizando as Views mais pesadas do sistema.
- **Instalação:** `@tanstack/react-query`.
- **Configuração Global:** Configuração do `<QueryClientProvider>` no `main.tsx` ou `App.tsx`.
- **Estrutura:** Criação da pasta `src/queries/` contendo arquivos modulares (ex: `useLessonsQuery.ts`, `useProfilesQuery.ts`).
- **Alvos Prioritários da Fase 1:**
  - **`ReportsView.tsx`:** Onde carregamos múltiplas tabelas simultâneas.
  - **`GestaoView.tsx`:** Painel administrativo com grande volume de perfis e configurações.
  - Nestes componentes, substituiremos os enormes blocos de `useEffect` baseados em arrays vazios `[]` por chamadas diretas como `const { data: lessons, isLoading } = useLessonsQuery()`. A interface ganhará cache automático e não fará requisições duplicadas ao trocar de abas.

---

## 3. Aperfeiçoamento do PWA (Offline-First)
**Objetivo:** Melhorar a navegação em conexões móveis/lentas provendo respostas otimizadas.
- **Vite Config (`vite.config.ts`):** 
  - Aumentar a robustez do Workbox.
  - Configurar rotas críticas (REST API do Supabase) para a estratégia `StaleWhileRevalidate`. A tela mostra os dados do cache anterior quase instantaneamente, enquanto checa silenciosamente se há novos no servidor, atualizando se necessário sem travar o usuário.
- **UI Responsiva de Rede (`Layout.tsx`):**
  - Implementar verificação de rede global usando o hook nativo `navigator.onLine`. 
  - Adicionar um banner minimalista de desconexão para gerenciar a expectativa do usuário (ex: alertar que está vendo dados em cache).

---

## 4. Estudo de Viabilidade SFU (Cloudflare Calls)
*Revisado com análise técnica aprofundada em 06/2026 — baseada no código real do `useWebRTC.ts` (2.236 linhas).*

### Status: Manter Mesh P2P. Reavaliar quando gatilhos de escala forem atingidos.

### Arquitetura atual (Mesh P2P)
O `useWebRTC.ts` implementa Full Mesh P2P onde cada participante abre uma `RTCPeerConnection` direta com cada outro. Com N pessoas, N(N-1)/2 conexões são abertas. O professor faz N-1 uploads simultâneos.

O bitrate é dinamicamente balanceado por `videoBitrateForPeerCount()`:
- Até 2 pessoas: 350 kbps/peer
- 12 pessoas: 150 kbps/peer → ~1,65 Mbps de upload do professor
- 20 pessoas: 150 kbps/peer → ~2,85 Mbps de upload do professor

O mesh **não é simples**: possui ICE escalonado por peer, zombie detection (heartbeat 15s), SDP munging para Opus com FEC, auto-degrade de qualidade, reconexão exponencial e telemetria auditada.

### Por que NÃO migrar agora
1. **Volume insuficiente para justificar:** 12 participantes/semana em salas de até 6 pessoas → professor faz ~900 kbps — qualquer banda residencial suporta.
2. **Código atual é robusto:** Reescrever 2.236 linhas testadas em produção para zero ganho perceptível é custo sem retorno.
3. **Custo financeiro = $0 em ambos os cenários:** Cloudflare Calls free tier: 1.000 GB/mês. Consumo estimado atual: ~18,5 GB/mês.
4. **Esforço de migração:** 40-80h estimadas (reescrita de `useWebRTC.ts`, testes, edge cases multi-track).

### Gatilhos para reavaliar a migração
- Salas regulares com **10+ participantes** com reclamações de qualidade
- Professor com **upload saturado** durante a aula (> 3 Mbps)
- Expansão para **> 5 salas simultâneas**
- Necessidade de **gravação server-side**

### O que muda no código (quando executar)
- `useWebRTC.ts`: Reescrita completa de `createPeerConnection()` → `createSessionWithCloudflare()` e loop de peers → `publishTrack()` / `pullTrack()`
- NOVO: `src/services/cloudflare-calls.service.ts` (client REST da API)
- NOVO: `src/hooks/useWebRTCSFU.ts` (hook paralelo durante transição, sem remover o mesh)
- **Sem alteração:** `ClassroomView.tsx`, `VideoTile`, `RecordingControls`, Supabase Realtime (continua para presença e chat), autenticação, banco

### Plano de execução futuro (quando os gatilhos ocorrerem)
1. **Fase 0:** Criar `cloudflare-calls.service.ts` + `useWebRTCSFU.ts` paralelo
2. **Fase 1:** Feature flag `VITE_USE_SFU=true`, hook condicional em `ClassroomView`
3. **Fase 2:** Rollout gradual por turma, monitorar telemetria
4. **Fase 3:** Deprecar `useWebRTC.ts` após 2 meses sem regressão

> Documento de referência completo: `estudo_sfu_vs_mesh.md` (gerado em 06/2026).

---

## 5. Correção do Compartilhamento de Tela (Screen Sharing)
**Objetivo:** Restaurar a usabilidade e a renderização correta da apresentação de tela para o professor e alunos, eliminando bugs visuais e conflitos de UX na gravação da aula.

**Diagnóstico Estrutural dos Bugs Atuais:**
1. **Ponto Cego do Apresentador:** O `useWebRTC.ts` captura a tela e envia aos alunos, mas não retorna o stream visual de volta ao componente da tela do professor. Ele continua renderizando sua própria webcam.
2. **Efeito Espelho (Texto Invertido):** O componente `<VideoTile>` força um `scale-x-[-1]` para a visão local atuar como espelho, o que faz os textos de slides do professor ficarem invertidos.
3. **Corte Lateral (Aspect-Ratio):** O CSS da janela usa `object-cover`. Compartilhamentos de tela exigem `object-contain` para que margens não sejam cortadas em proporções de monitor diferentes.
4. **Duplo Compartilhamento (Conflito):** A gravação da aula no `useRecording.ts` possui sua captura isolada. Gravar e Compartilhar simultaneamente força o navegador a abrir duas popups de permissão independentes.

**Passos Sugeridos e Fases de Implementação:**
- **Fase 1: Exposição do Stream (`useWebRTC.ts` e `ClassroomView.tsx`)**
  - Armazenar o `screenStream` num State local e retorná-lo no export do hook `useWebRTC.ts`.
  - No `ClassroomView.tsx`, atualizar a injeção condicional. Quando `screenSharing` for verdadeiro, injetamos o `screenStream` no tile focado do apresentador (em vez do `localStream` de câmera).
  - Adicionar uma nova Prop `isScreenShare={true}` ao componente base.
- **Fase 2: Ajuste Visual e Matemático (`VideoTile.tsx`)**
  - Condicionar o CSS: Se `isScreenShare` for verdadeiro, removemos a classe `scale-x-[-1]` (desliga o espelho).
  - Alterar dinamicamente a propriedade `object-cover` para `object-contain` (com preenchimento nas margens) protegendo o conteúdo do slide.
- **Fase 3: Unificação da Gravação (`useRecording.ts`)**
  - Reestruturar o início da Gravação para reconhecer se o `screenStream` já está ativo. Caso o professor já esteja compartilhando a tela, a Gravação usará nativamente o mesmo pacote de vídeo, abolindo o segundo prompt de permissão invasivo do Chrome.

---

## Cronograma e Fases de Execução (Roadmap de Refatoração)

Para garantir a estabilidade do sistema em produção, a execução de código será dividida em entregas menores e isoladas, seguindo a ordem de criticidade operacional (UX que afeta a Sala de Aula diária no Topo).

### 🚀 Fase 1: Correção Visual Crítica (Compartilhamento de Tela)
*Impacto:* Resolve imediatamente um bug visual ativo reportado por professores durante as aulas.
- **Passo 1:** Modificar `useWebRTC.ts` para persistir e exportar o ponteiro do `screenStream`.
- **Passo 2:** Refatorar `ClassroomView.tsx` garantindo que o Apresentador veja a própria tela em destaque ao invés do próprio rosto.
- **Passo 3:** Ajustar a injeção do componente `<VideoTile>`, adicionando validações condicionais do Tailwind (`object-contain` sem `scale-x-[-1]`).
- **Passo 4:** Realizar o *fallback* de mídia em `useRecording.ts` para impedir a abertura de dois prompts de permissão independentes do navegador.

### 🛡️ Fase 2: Blindagem de Dados Críticos (IndexedDB Caching)
*Impacto:* Elimina o risco severo de perda total de uma vídeo-aula de 2h por falta de RAM ou travamento do notebook do educador.
- **Passo 1:** Adicionar pacote do `localforage` ao ambiente.
- **Passo 2:** Refatorar as linhas de processamento (`ondataavailable`) em `useRecording.ts` para realizar o "dump" contínuo dos blobs de mídia no disco do navegador.
- **Passo 3:** Codificar o serviço de checagem do ciclo de vida, disparando a rotina de exclusão ou de concatenação para recuperação em caso de rascunhos largados.

### ⚡ Fase 3: Performance Global e Economia de Requests (React Query)
*Impacto:* Melhora drástica na velocidade de renderização da interface e redução massiva de faturamento junto ao Supabase (menos leituras).
- **Passo 1:** Setup da arquitetura TanStack Query.
- **Passo 2:** Modularizar os getters pesados (Lessons, Profiles).
- **Passo 3:** Cirurgia invasiva em `ReportsView.tsx`, desativando chamadas baseadas em `useEffect` a favor da integração reativa.
- **Passo 4:** Procedimento idêntico espelhado em `GestaoView.tsx`.

### 🌐 Fase 4: Otimização Mobile e Redes Lentas (PWA & Workbox)
*Impacto:* Proporciona resiliência de cache para cenários móveis em locomoção (internet variando de 4G para E).
- **Passo 1:** Redefinir políticas de invalidação de Cache na API Rest do Supabase pelo `vite.config.ts`.
- **Passo 2:** Melhorias de UX visual e responsiva para comunicar quedas de tráfego.
