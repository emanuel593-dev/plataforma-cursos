# Sistema de Presença Automática — Referência Técnica

**Versão**: 1.0  
**Data**: 2026-04-14  
**Arquivo principal**: `src/components/views/ClassroomView.tsx`  
**Serviço de dados**: `src/services/attendance.service.ts`  
**Visualização**: `src/components/views/AttendanceView.tsx`

---

## 1. Visão Geral

O sistema de presença automática elimina a necessidade de chamada manual pelo professor. A presença é registrada automaticamente quando o aluno entra na sala de aula virtual, e validada continuamente por **três mecanismos independentes** que garantem que o aluno realmente assistiu a aula.

```
┌───────────────────────────────────────────────────────────────┐
│                    ALUNO ENTRA NA SALA                        │
│                                                               │
│  1. Marca presença → status: "present", joined_at registrado  │
│  2. Inicia scheduler de verificações aleatórias               │
│                                                               │
│  ┌─ Durante a aula ─────────────────────────────────────────┐ │
│  │  Check 1 (8-15 min) → pop-up 30s → respondeu? ✓/✗       │ │
│  │  Check 2 (8-15 min) → pop-up 30s → respondeu? ✓/✗       │ │
│  │  Check 3 (8-15 min) → pop-up 30s → respondeu? ✓/✗       │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  Aluno sai / Sala encerrada → avaliação final:                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ Permaneceu ≥ 75% da aula?           → SIM / NÃO       │   │
│  │ Respondeu ≥ 1 verificação?          → SIM / NÃO       │   │
│  │                                                        │   │
│  │ Se ambos SIM → status final: PRESENT                   │   │
│  │ Se duração < 75%  → status final: ABSENT + nota auto   │   │
│  │ Se 0/N checks     → status final: ABSENT + nota auto   │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

---

## 2. Parâmetros Fixos

| Constante | Valor | Descrição |
|-----------|-------|-----------|
| `MIN_DURATION_RATIO` | **0.75** (75%) | Percentual mínimo da duração da aula que o aluno precisa estar presente |
| `MAX_CHECKS` | **3** | Número máximo de verificações por sessão de aula |
| `CHECK_INTERVAL_MIN_MS` | **8 minutos** | Intervalo mínimo entre verificações |
| `CHECK_INTERVAL_MAX_MS` | **15 minutos** | Intervalo máximo entre verificações |
| `CHECK_RESPONSE_TIMEOUT_MS` | **30 segundos** | Tempo para o aluno responder cada verificação |

### Justificativa dos valores

- **Duração média de aula**: 45 minutos
- **75% de 45 min** = ~34 min de permanência mínima
- **3 checks em 45 min**: Com intervalos de 8–15 min, os 3 checks se distribuem naturalmente pela aula
  - Cenário mais cedo: check aos 8, 16, 24 min
  - Cenário mais tardio: check aos 15, 30, 45 min
  - O randomismo impede que alunos "prevejam" os horários
- **Todos recebem exatamente 3 checks**: O cap fixo garante equidade — nenhum aluno recebe mais verificações que outro
- **30s de resposta**: Tempo suficiente para ler e clicar, mas curto o bastante para impedir que alguém ausente volte a tempo

---

## 3. Camadas de Proteção

### 3.1 Camada 1 — Duração Mínima (75%)

**Problema resolvido**: Aluno entra na sala, marca presença automática, e sai imediatamente.

**Como funciona**:
- Ao entrar, `joinedAtRef2` registra o timestamp (`Date.now()`)
- A duração esperada da aula é carregada de `scheduled_lessons.duration_minutes`
- Ao sair, calcula-se: `ratio = duration_seconds / (classDuration * 60)`
- Se `ratio < 0.75` → status final é alterado para `absent`
- Nota automática é adicionada: *"Presença automática removida: permaneceu X% da aula (mín. 75%)."*

**Exemplo**:  
Aula de 45 min. Aluno ficou 20 min (44%). → **Falta automática**.

### 3.2 Camada 2 — Verificações Aleatórias (Presence Checks)

**Problema resolvido**: Aluno entra, deixa a aba aberta, mas está fazendo outra coisa.

**Como funciona**:
1. Após `handleJoin()`, o scheduler é iniciado (apenas para `role === 'aluno'`)
2. Um timer aleatório entre 8–15 min é agendado
3. Quando dispara, exibe modal fullscreen sobre a sala de aula:
   - Título: "Verificação de presença"
   - Countdown visual de 30 segundos
   - Botão "Estou presente"
4. **Se respondeu**: `verified_checks += 1`, agenda próximo check (se < 3)
5. **Se não respondeu em 30s**: modal fecha automaticamente, agenda próximo check (se < 3)
6. Após 3 checks, o scheduler para — não há mais verificações

**Equidade**: Todo aluno recebe exatamente 3 checks. O randomismo afeta apenas o *momento* dentro da aula, não a quantidade.

### 3.3 Camada 3 — Avaliação Final no Saída

**Problema resolvido**: Determinar status definitivo combinando duração + verificações.

**Regras de decisão (em ordem de prioridade)**:

```
SE duração < 75% da aula:
  → status = "absent"
  → nota = "permaneceu X% da aula (mín. 75%)"

SENÃO SE total_checks > 0 E verified_checks === 0:
  → status = "absent"  
  → nota = "não respondeu nenhuma verificação (0/N)"

SENÃO:
  → status = "present"
```

**Nota**: Se o aluno ficou 75%+ e respondeu pelo menos 1 de 3 checks, é considerado presente. Não é necessário responder todos — o objetivo é garantir que o aluno *está ali*, não penalizar por distração momentânea.

---

## 4. Quem Recebe Verificações

| Role | Recebe checks? | Motivo |
|------|:--------------:|--------|
| `aluno` | ✅ | Público-alvo do controle de presença |
| `professor` | ❌ | É o ministrante — presença é implícita |
| `coordenacao` | ❌ | Administrador — não precisa de verificação |

---

## 5. Dados Armazenados (Tabela `attendance`)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | uuid | Identificador único |
| `scheduled_lesson_id` | uuid | FK → aula agendada |
| `student_id` | uuid | FK → perfil do aluno |
| `status` | enum | `present`, `absent`, `justified` |
| `joined_at` | timestamptz | Momento exato de entrada na sala |
| `left_at` | timestamptz | Momento exato de saída |
| `duration_seconds` | int | Duração total de permanência |
| `marked_by` | uuid | Quem marcou (aluno = auto, coord/prof = manual) |
| `notes` | text | Notas automáticas de invalidação ou manuais |
| `verified_checks` | int | Quantas verificações o aluno **respondeu** |
| `total_checks` | int | Quantas verificações foram **enviadas** |

### Indicadores derivados

- **Taxa de verificação**: `verified_checks / total_checks` (0% a 100%)
- **É registro automático**: `joined_at IS NOT NULL`
- **Foi invalidado**: `status = 'absent' AND notes LIKE 'Presença automática removida%'`
- **Duração percentual**: `duration_seconds / (scheduled_lessons.duration_minutes * 60)`

---

## 6. Visualização no Menu Presenças

O `AttendanceView` exibe as presenças em formato de planilha (turma × aluno × aula). Registros automáticos ganham indicadores visuais:

### 6.1 Bolinha indicadora
Células com registro automático (`joined_at != null`) exibem uma **bolinha azul** (2px) no canto superior direito do botão.

### 6.2 Tooltip rico
Ao passar o mouse sobre qualquer célula com registro, o tooltip mostra:

```
Presente
Duração: 38 min
Verificações: 3/3
⚡ Registro automático
Clique para alterar
```

Ou para um registro invalidado:

```
Falta
Duração: 12 min
Verificações: 0/2
⚡ Registro automático
Presença automática removida: permaneceu 27% da aula (mín. 75%).
Clique para alterar
```

### 6.3 Override manual
A coordenação e o professor podem **sobrescrever** qualquer status clicando na célula (ciclo: P → F → FJ → P). O override manual prevalece sobre o automático.

---

## 7. Fluxo Completo (Sequência)

```
1. Aluno clica "Entrar" no pre-join screen
2. handleJoin():
   a. joinedAtRef2 = Date.now()
   b. checksRef = { verified: 0, total: 0 }
   c. Conecta WebRTC
   d. recordAttendanceJoin():
      - upsertAttendance(status: 'present', joined_at: now)
   e. scheduleNextCheck() [se role === 'aluno']
   
3. Timer aleatório (8-15 min) dispara:
   a. checksRef.total += 1
   b. Modal de verificação aparece (countdown 30s)
   c. SE aluno clica "Estou presente":
      - checksRef.verified += 1
      - Fecha modal
      - scheduleNextCheck() [se total < 3]
   d. SE 30s expira sem resposta:
      - Fecha modal
      - scheduleNextCheck() [se total < 3]

4. Repetir step 3 até total === 3

5. Aluno sai OU sala é encerrada:
   a. stopChecks() — limpa timers
   b. recordAttendanceLeave():
      - Calcula duration_seconds
      - Calcula ratio (duration / classDuration)
      - SE ratio < 0.75 → status = 'absent' + nota
      - SENÃO SE verified === 0 e total > 0 → status = 'absent' + nota
      - SENÃO → status = 'present'
      - upsertAttendance(status, left_at, duration, checks, nota)
```

---

## 8. Cenários de Teste

| Cenário | Duração | Checks | Resultado |
|---------|---------|--------|-----------|
| Assistiu aula inteira, respondeu todos | 45/45 min (100%) | 3/3 | ✅ Presente |
| Assistiu aula inteira, perdeu 1 check | 45/45 min (100%) | 2/3 | ✅ Presente |
| Assistiu aula inteira, ignorou todos | 45/45 min (100%) | 0/3 | ❌ Falta (0 checks) |
| Saiu na metade, respondeu checks | 22/45 min (49%) | 2/2 | ❌ Falta (< 75%) |
| Saiu após 34min, respondeu 1 check | 34/45 min (76%) | 1/2 | ✅ Presente |
| Entrou e saiu em 5 min | 5/45 min (11%) | 0/0 | ❌ Falta (< 75%) |
| Ficou 40 min, nenhum check apareceu* | 40/45 min (89%) | 0/0 | ✅ Presente |

\* Se `total_checks === 0`, a regra de "0 verificações" não se aplica (divisão por zero protegida).

---

## 9. Considerações Futuras

- **Múltiplas entradas/saídas**: Se o aluno cair e reconectar, o `upsertAttendance` atualiza o registro existente (não cria duplicado). A duração final será da última sessão — considerar acumular durações em versão futura.
- **Detecção de aba inativa**: Possível melhoria usando `document.visibilityState` para detectar se o aluno minimizou a aba.
- **Verificação por câmera**: Checagem mais avançada verificando se a câmera tem rosto visível (requer ML — escopo futuro).
- **Exportar relatório de presenças**: CSV/PDF com dados de duração e verificações para auditoria.
