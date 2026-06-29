# Plano de Evolucao - Opcao B (Notificacoes, Avisos e Engajamento)

## Objetivo

Executar a fase 1 da Opcao B para melhorar uso diario de alunos e professores com foco em comunicacao ativa, percepcao de valor e reducao de esquecimentos.

## Escopo da Fase 1

1. Avisos no dashboard
- Exibir avisos recentes para todos os perfis.
- Permitir criacao de avisos por coordenacao e professor.
- Professor cria aviso associado a uma turma.
- Coordenacao pode criar aviso geral e por turma.
- Priorizar avisos fixados no topo.

2. Notificacoes in-app
- Adicionar central de notificacoes no topo da aplicacao.
- Mostrar itens de duas fontes:
  - Novos avisos.
  - Proximas aulas.
- Exibir contador de nao lidas.
- Permitir marcar feed como visualizado.

3. Engajamento rapido
- Exibir os avisos dentro da rotina principal (dashboard), reduzindo dependencia de e-mail.
- Garantir experiencia mobile e desktop para leitura rapida das informacoes mais importantes.

## Referencias de mercado aplicadas

- Google Classroom: avisos simples e visiveis no fluxo principal.
- Canvas: notificacoes por eventos relevantes para acao imediata.
- Moodle: comunicacao por turma e papel com regras de permissao.

## Entregaveis tecnicos

1. Banco de dados
- Nova migration para tabela announcements com politicas RLS.

2. Frontend
- Dashboard com bloco de Avisos e modal de criacao de aviso.
- Layout com icone de notificacoes, contador e painel de feed.

3. Servicos
- announcements.service.ts para CRUD/listagem de avisos.
- notifications.service.ts para consolidar feed de notificacoes in-app.

## Regras de permissao (fase 1)

1. Leitura de avisos
- Coordenacao: todos os avisos.
- Professor: avisos gerais + avisos das turmas em que leciona.
- Aluno: avisos gerais + avisos das turmas em que esta matriculado.

2. Criacao de avisos
- Coordenacao: geral ou por turma.
- Professor: apenas por turma em que leciona.

3. Edicao/Exclusao de avisos
- Coordenacao: qualquer aviso.
- Professor: apenas avisos que criou.

## Critrios de aceite

1. Coordenacao cria aviso geral e ele aparece para todos os perfis no dashboard.
2. Professor cria aviso de uma turma propria e alunos matriculados visualizam.
3. Contador de notificacoes aumenta quando houver novo aviso ou nova aula relevante.
4. Usuario consegue abrir feed e marcar notificacoes como visualizadas.
5. Fluxo funciona em desktop e mobile sem quebrar layout existente.

## Fora do escopo desta fase

- Mensageria privada 1:1.
- Forum com respostas encadeadas.
- Push notifications externas (WhatsApp, e-mail transacional, web push).

## Proximos passos apos Fase 1

1. Fase 2 de Opcao B
- Discussao por turma/aula.
- Reacoes e confirmacao de leitura por aviso.
- Segmentacao de publico por papel e turma em massa.

2. Fase 3 de Opcao B
- Engajamento por trilhas e alertas inteligentes de risco de evasao.
