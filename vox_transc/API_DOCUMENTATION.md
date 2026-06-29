# VoxTranscribe Pro - API Documentation

Bem-vindo à documentação da API REST do VoxTranscribe Pro. Esta API permite que sistemas externos (como ATS, CRM, ERP) integrem-se à nossa plataforma para criar salas de entrevista, consultar históricos de sessões, obter transcrições e resumos gerados por IA, e gerenciar dados.

## URL Base
Todas as requisições devem ser feitas para o caminho base da sua aplicação:
```
https://<seu-dominio>/api/v1
```

## Autenticação
A API utiliza autenticação baseada em chaves de API (API Keys). 
Você deve enviar a sua chave no cabeçalho (header) `x-api-key` em todas as requisições.

**Exemplo de Headers:**
```http
x-api-key: vox_org123_abcdef1234567890abcdef
Content-Type: application/json
```

*Nota: As chaves de API podem ser geradas no painel do VoxTranscribe Pro (Menu Settings -> API Keys).*

## Limite de Requisições (Rate Limiting)
Para garantir a estabilidade da plataforma, a API possui um limite de **100 requisições a cada 15 minutos por IP**. Caso o limite seja excedido, a API retornará o status \`429 Too Many Requests\`.

---

## Endpoints

### 1. Criar Sala de Reunião (Entrevista)
Cria um link único e seguro para uma sessão de entrevista/reunião, vinculando-a a um ID do seu sistema externo.

*   **URL:** \`/rooms/create\`
*   **Método:** \`POST\`
*   **Corpo da Requisição (JSON):**

| Campo | Tipo | Obrigatório | Descrição |
| :--- | :--- | :--- | :--- |
| \`externalId\` | string | Sim | ID único do candidato ou processo no seu sistema (Max: 128 caracteres). |
| \`candidateName\` | string | Não | Nome do candidato para exibição na sala (Max: 100 caracteres). |

**Exemplo de Requisição:**
\`\`\`json
{
  "externalId": "candidato_98765",
  "candidateName": "João Silva"
}
\`\`\`

**Exemplo de Resposta (201 Created):**
\`\`\`json
{
  "roomId": "550e8400-e29b-41d4-a716-446655440000",
  "orgId": "org_abc123",
  "externalId": "candidato_98765",
  "url": "https://seu-dominio.com/room/550e8400-e29b-41d4-a716-446655440000?externalId=candidato_98765&candidate=Jo%C3%A3o%20Silva"
}
\`\`\`
*(O sistema externo deve enviar a \`url\` retornada para o candidato acessar a sala).*

---

### 2. Listar Sessões (Histórico)
Busca o histórico de sessões realizadas pela sua organização. Útil para encontrar a sessão de um candidato específico após a entrevista.

*   **URL:** \`/sessions\`
*   **Método:** \`GET\`
*   **Parâmetros de Query (Opcionais):**

| Parâmetro | Tipo | Descrição |
| :--- | :--- | :--- |
| \`externalId\` | string | Filtra as sessões por um ID do seu sistema. |
| \`limit\` | number | Número máximo de resultados a retornar (Padrão: 50). |

**Exemplo de Requisição:**
\`\`\`http
GET /api/v1/sessions?externalId=candidato_98765&limit=10
\`\`\`

**Exemplo de Resposta (200 OK):**
\`\`\`json
{
  "sessions": [
    {
      "id": "sess_123abc",
      "externalId": "candidato_98765",
      "duration": 1450,
      "timestamp": "2026-03-26T14:30:00.000Z",
      "mode": "meeting"
    }
  ]
}
\`\`\`

---

### 3. Obter Resumo e Transcrições (Insights)
Recupera a análise comportamental (resumo gerado pela IA) e, opcionalmente, a transcrição completa de uma sessão específica.

*   **URL:** \`/sessions/:sessionId/insights\`
*   **Método:** \`GET\`
*   **Parâmetros de Rota:**
    *   \`sessionId\` (string): O ID da sessão retornado na listagem.
*   **Parâmetros de Query (Opcionais):**
    *   \`includeTranscriptions\` (boolean): Se \`true\`, retorna o array com todas as falas transcritas.

**Exemplo de Requisição:**
\`\`\`http
GET /api/v1/sessions/sess_123abc/insights?includeTranscriptions=true
\`\`\`

**Exemplo de Resposta (200 OK):**
\`\`\`json
{
  "id": "sess_123abc",
  "externalId": "candidato_98765",
  "duration": 1450,
  "timestamp": "2026-03-26T14:30:00.000Z",
  "mode": "meeting",
  "summary": "## Resumo da Entrevista\nO candidato demonstrou confiança ao falar sobre suas experiências anteriores. Tom de voz calmo e articulado...\n\n**Pontos Fortes:**\n- Comunicação clara\n- Foco em resultados",
  "transcriptions": [
    {
      "id": "transc_1",
      "text": "Olá, bom dia. Meu nome é João.",
      "type": "user",
      "timestamp": "2026-03-26T14:30:05.000Z"
    },
    {
      "id": "transc_2",
      "text": "O candidato sorriu e manteve contato visual ao se apresentar.",
      "type": "model",
      "timestamp": "2026-03-26T14:30:06.000Z"
    }
  ]
}
\`\`\`

---

### 4. Deletar Sessão (LGPD / Limpeza)
Apaga permanentemente uma sessão e todos os seus dados (resumos e transcrições) do banco de dados. Ideal para manter a conformidade com leis de proteção de dados (como a LGPD).

*   **URL:** \`/sessions/:sessionId\`
*   **Método:** \`DELETE\`
*   **Parâmetros de Rota:**
    *   \`sessionId\` (string): O ID da sessão a ser deletada.

**Exemplo de Requisição:**
\`\`\`http
DELETE /api/v1/sessions/sess_123abc
\`\`\`

**Exemplo de Resposta (200 OK):**
\`\`\`json
{
  "success": true,
  "message": "Session deleted successfully"
}
\`\`\`

---

## Códigos de Erro Comuns

| Código HTTP | Descrição |
| :--- | :--- |
| \`400 Bad Request\` | Parâmetros inválidos ou faltando na requisição. |
| \`401 Unauthorized\` | Chave de API (\`x-api-key\`) ausente ou inválida. |
| \`403 Forbidden\` | A chave de API é válida, mas a organização não tem permissão para acessar o recurso solicitado. |
| \`404 Not Found\` | O recurso solicitado (ex: sessão) não foi encontrado. |
| \`429 Too Many Requests\` | Limite de requisições excedido (Rate Limit). |
| \`500 Internal Server Error\` | Erro interno no servidor. |
