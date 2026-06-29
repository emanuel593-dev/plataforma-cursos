# Roadmap Técnico e Gaps de Arquitetura (VoxTranscribe Pro)

Este documento detalha os gaps técnicos atuais do projeto e o roadmap de melhorias necessárias para escalar a aplicação de um estágio "Beta Seguro" para um produto SaaS comercial (Enterprise-ready) de alta disponibilidade e performance.

---

## 1. Escalabilidade e Performance (Implementação de Redis)

### 🔴 Gap Atual
Atualmente, o sistema depende exclusivamente do Firebase/Firestore para armazenamento de estado, validação de chaves e controle de sessões. O servidor Node.js gerencia as conexões WebSocket (Socket.IO) em memória local.
* **Problema 1:** Se o tráfego aumentar e precisarmos subir 2 ou mais instâncias do servidor Node.js, os WebSockets perderão a sincronia (um usuário conectado no Servidor A não conseguirá se comunicar com um processo no Servidor B).
* **Problema 2:** O *Rate Limiting* (limite de requisições) atual usa a memória RAM do servidor Node.js. Se o servidor reiniciar, os limites são zerados.
* **Problema 3:** Consultar o Firestore a cada requisição de API para validar o hash da chave de API gera latência e custos desnecessários de leitura no banco de dados.

### 🟢 Solução Proposta
Implementar um banco de dados em memória (Redis).

### 🛠 Detalhes Técnicos
1. **Socket.IO Redis Adapter:** Utilizar o `@socket.io/redis-adapter` para que múltiplas instâncias do servidor Node.js possam compartilhar eventos de WebSocket.
2. **Rate Limiting Distribuído:** Substituir o armazenamento em memória do `express-rate-limit` pelo `rate-limit-redis`, garantindo que os limites de API sejam globais e persistentes.
3. **Cache de Chaves de API:** Fazer cache do hash das chaves de API no Redis com um TTL (Time To Live) de 5 a 10 minutos. Isso reduzirá drasticamente as leituras no Firestore (economia de custos) e diminuirá a latência da API para os clientes.

---

## 2. Monetização e Controle de Planos (Integração de Pagamentos)

### 🔴 Gap Atual
A estrutura de banco de dados já prevê o campo `plan` (free, pro, enterprise) na coleção `organizations`, mas não existe um motor de cobrança ou bloqueio de recursos automatizado.
* **Problema:** Não há como cobrar os usuários pelo uso da IA, nem limitar o tempo de gravação ou a quantidade de chamadas de API com base no plano contratado.

### 🟢 Solução Proposta
Integração com gateway de pagamento (ex: Stripe ou Mercado Pago).

### 🛠 Detalhes Técnicos
1. **Stripe Checkout / Billing:** Implementar o fluxo de assinatura onde o usuário escolhe um plano e insere o cartão de crédito.
2. **Webhooks de Pagamento:** Criar um endpoint seguro (`/api/webhooks/stripe`) no `server.ts` para ouvir eventos do Stripe (ex: `invoice.paid`, `customer.subscription.deleted`).
3. **Sincronização de Estado:** Quando o webhook confirmar o pagamento, o backend atualiza o campo `plan` da organização no Firestore.
4. **Enforcement (Bloqueios):** Adicionar middlewares no backend e verificações no frontend para limitar:
   * Duração máxima da reunião (ex: Free = 15 min, Pro = Ilimitado).
   * Limite de requisições de API por mês.
   * Acesso a recursos premium (ex: Resumos avançados, exportação para ATS).

---

## 3. Processamento e Armazenamento de Áudio (Cloud Storage)

### 🔴 Gap Atual
O áudio é processado em tempo real via streaming para a API do Gemini. Não há armazenamento persistente do áudio bruto (raw audio).
* **Problema 1:** Se a conexão com o Gemini falhar no meio da reunião, a transcrição daquele trecho é perdida para sempre.
* **Problema 2:** Não é possível reprocessar uma reunião antiga com um prompt diferente, pois o áudio original não foi salvo.
* **Problema 3:** Para integrações com ATS ou CRMs, os clientes podem exigir o link do arquivo de áudio original como prova/registro.

### 🟢 Solução Proposta
Armazenamento em nuvem (Google Cloud Storage ou AWS S3) e filas de processamento.

### 🛠 Detalhes Técnicos
1. **Upload em Chunks:** Modificar o frontend para, além de enviar o áudio via WebSocket, fazer upload de chunks de áudio para um bucket do Cloud Storage.
2. **Filas (Message Brokers):** Para transcrições assíncronas de arquivos pesados (upload de MP3), implementar uma fila (ex: BullMQ com Redis ou Google Cloud Pub/Sub) para processar o áudio em background sem travar o servidor Node.js.
3. **Políticas de Retenção:** Configurar exclusão automática de áudios após X dias (dependendo do plano do usuário) para economizar custos de storage e manter conformidade com a LGPD.

---

## 4. Integrações Externas (Webhooks Outbound)

### 🔴 Gap Atual
O sistema permite criar chaves de API para que sistemas externos (ATS, CRMs) *puxem* (Pull) os dados da nossa plataforma. No entanto, não conseguimos *empurrar* (Push) os dados ativamente quando uma reunião termina.
* **Problema:** O cliente precisa ficar fazendo *polling* (perguntando "já acabou?") na nossa API, o que é ineficiente.

### 🟢 Solução Proposta
Implementar Webhooks Outbound (envio de eventos para os clientes).

### 🛠 Detalhes Técnicos
1. **Registro de Endpoints:** A interface de administração já prevê `webhookUrl` e `webhookSecret` no Blueprint. Precisamos criar a UI para o usuário cadastrar essas URLs.
2. **Disparo de Eventos:** Quando uma sessão for concluída e o resumo gerado, o backend deve disparar um `POST` para a URL do cliente com o payload da transcrição.
3. **Assinatura de Segurança (HMAC):** Assinar o payload do webhook usando o `webhookSecret` do cliente, para que ele possa verificar que a requisição realmente veio do VoxTranscribe Pro.
4. **Retry Logic:** Implementar um sistema de tentativas (ex: tentar enviar 3 vezes com backoff exponencial caso o servidor do cliente esteja fora do ar).

---

## 5. Observabilidade e Monitoramento

### 🔴 Gap Atual
Os erros são logados apenas no console do servidor ou do navegador.
* **Problema:** Em produção, se a API do Gemini começar a falhar ou se os usuários enfrentarem bugs no frontend, a equipe técnica não será alertada proativamente.

### 🟢 Solução Proposta
Ferramentas de APM (Application Performance Monitoring) e Error Tracking.

### 🛠 Detalhes Técnicos
1. **Sentry (Frontend e Backend):** Integrar o SDK do Sentry para capturar exceções não tratadas, erros de React e falhas de rotas da API.
2. **Logs Estruturados:** Substituir os `console.log` do backend por uma biblioteca de logs estruturados (como `pino` ou `winston`), formatando os logs em JSON para fácil ingestão em ferramentas como Datadog ou Google Cloud Logging.
3. **Métricas de Negócio:** Monitorar ativamente o consumo de tokens da API do Gemini para prever custos e evitar surpresas no faturamento.
