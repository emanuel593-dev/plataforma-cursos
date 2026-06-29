# Base de Progresso da Coordenação

Data de referência: 2026-05-25  
Commit base para rollback: b3cec67

Status: Documento-base para guiar evolução operacional e de produto com foco em gestão profissional.

---

## 1. Objetivo imediato

Consolidar a operação da coordenação em 3 frentes críticas:

1. Presença e reposição com semântica de negócio fechada
2. Gestão por exceção (hoje manual)
3. Operação orientada por SLA

Este documento define regras, fluxos, métricas e checkpoints para execução contínua.

---

## 2. Frente A — Presença e reposição com semântica fechada

### 2.1 Problema atual

Há risco de divergência entre status, notas, duração e telas, além de dúvidas operacionais sobre quando uma reposição realmente encerra a obrigação acadêmica.

### 2.2 Decisão de negócio (fonte única)

Modelo oficial proposto:

- Presença automática calcula somente evidências brutas:
  - duração em segundos
  - verificações respondidas
  - timestamps de entrada e saída
- Status final de presença deve ser derivado por regra única oficial
- Override manual deve registrar:
  - quem alterou
  - quando alterou
  - motivo obrigatório
- Reposição aprovada deve encerrar obrigação de reposição sem apagar histórico da falta original

### 2.3 Estados oficiais

Presença:
- present
- absent
- justified

Reposição:
- pending
- submitted
- approved
- rejected

### 2.4 Regras fechadas (versão inicial)

1. O status de presença manual sempre prevalece sobre o automático.
2. Mudança manual limpa nota automática antiga e grava justificativa administrativa.
3. Reposição aprovada fecha pendência acadêmica da falta justificada.
4. Histórico nunca é apagado; apenas transicionado com trilha de auditoria.
5. Qualquer inconsistência entre telas deve vir de uma mesma fonte calculada (não texto congelado em nota).

### 2.5 Entregáveis desta frente

- Matriz de decisão oficial presença x reposição
- Política de override manual
- Definição de qual campo representa obrigação encerrada de reposição
- Checklist de consistência entre telas de chamada, relatórios e reposições

### 2.6 KPI de validação

- Divergência entre telas de presença: meta 0
- Registros com override sem justificativa: meta 0
- Reposições aprovadas ainda pendentes no painel: meta 0

---

## 3. Frente B — Gestão por exceção (reduzir operação manual)

### 3.1 Problema atual

A coordenação precisa varrer telas para achar risco operacional. O processo é reativo.

### 3.2 Modelo operacional proposto

Central de Exceções com filas priorizadas:

1. Presenças em risco (prazo curto para ação)
2. Reposições vencendo ou vencidas
3. Aulas sem relatório final
4. Avaliações críticas de professor
5. Incidentes técnicos recorrentes por turma/aula

Cada item de exceção deve conter:

- severidade (crítica, alta, média, baixa)
- responsável
- prazo
- ação recomendada
- status (aberta, em tratamento, concluída)

### 3.3 Critérios de priorização

- Crítica: risco de impacto acadêmico imediato
- Alta: risco de perda de prazo institucional
- Média: impacto de qualidade sem bloqueio imediato
- Baixa: melhoria operacional

### 3.4 Entregáveis desta frente

- Taxonomia única de exceções
- Regras de abertura e fechamento por tipo de exceção
- Painel único de pendências da coordenação
- Rotina semanal de limpeza de backlog de exceções

### 3.5 KPI de validação

- Exceções sem responsável: meta 0
- Tempo médio para primeiro tratamento: reduzir em 50%
- Exceções vencidas em aberto: meta 0 para críticas e altas

---

## 4. Frente C — Operação por SLA

### 4.1 Problema atual

Sem prazos oficiais, a operação depende de disponibilidade individual e não de compromisso institucional.

### 4.2 SLAs iniciais recomendados

1. Revisão de resumo de reposição: até 48 horas
2. Tratamento de divergência de presença: até 24 horas
3. Fechamento de aula sem relatório: até 12 horas
4. Primeira resposta a incidente de aula ao vivo: até 15 minutos
5. Encaminhamento de decisão administrativa (casos não padrão): até 72 horas

### 4.3 Governança dos SLAs

- Todo SLA deve ter dono
- Toda quebra de SLA deve ter causa raiz classificada
- Toda reincidência deve gerar ação preventiva

### 4.4 Entregáveis desta frente

- Catálogo oficial de SLAs por processo
- Quadro de acompanhamento semanal de cumprimento
- Ritual de revisão quinzenal com causa raiz

### 4.5 KPI de validação

- Cumprimento de SLA por categoria: meta >= 95%
- Reincidência da mesma quebra em 30 dias: meta <= 5%

---

## 5. Plano de execução em 30 dias

Semana 1
- Fechar semântica oficial presença/reposição
- Definir matriz de decisão e regras de override
- Publicar primeira versão do catálogo de exceções

Semana 2
- Implantar fluxo de triagem por severidade
- Definir SLAs e responsáveis por processo
- Iniciar painel gerencial de acompanhamento

Semana 3
- Rodar operação assistida com revisão diária
- Ajustar critérios de priorização e prazos
- Treinar responsáveis e validar aderência

Semana 4
- Consolidar indicadores
- Fechar lacunas de governança
- Aprovar versão operacional estável (v1)

---

## 6. Riscos e mitigação

Risco 1: Semântica ambígua entre áreas
- Mitigação: decisão formal em reunião única com ata e owner

Risco 2: Excesso de exceções no início
- Mitigação: priorização estrita por severidade + SLA mínimo obrigatório

Risco 3: Quebra recorrente de SLA
- Mitigação: revisão de capacidade e redistribuição de responsáveis

---

## 7. Checkpoint de rollback

Referência segura para retorno:

- Commit base: b3cec67
- Data do checkpoint: 2026-05-25

Uso recomendado em incidente:

1. Congelar alterações novas
2. Identificar primeiro commit problemático
3. Reverter de forma controlada até o checkpoint
4. Validar fluxos críticos antes de novo deploy

---

## 8. Próximos documentos derivados

1. Matriz detalhada de decisão presença x reposição
2. Catálogo oficial de exceções da coordenação
3. Catálogo oficial de SLA com donos e janelas operacionais
4. Painel de KPI executivo da coordenação

Fim da versão inicial.
