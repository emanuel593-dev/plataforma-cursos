# Plataforma de Cursos (LMS) & WebRTC Video Conferencing

Uma plataforma completa de ensino a distância (LMS) focada na gestão acadêmica e videoconferências em tempo real. Desenvolvida para escalar o ensino online com um sistema de tracking de presença automatizado e níveis estritos de segurança.

## 🚀 Principais Tecnologias (Tech Stack)
- **Frontend:** React, Vite, TailwindCSS, TypeScript
- **Backend & Banco de Dados:** Supabase (PostgreSQL, Auth, Realtime)
- **Segurança:** Autenticação robusta e **RLS (Row Level Security)** nativo do Postgres
- **Vídeo & Real-Time:** WebRTC, Socket.io para sinalização (Mesh Network)
- **Infraestrutura de Tempo Real:** Express/Node.js para sinalização WebRTC customizada

## 🎯 Destaques de Engenharia e Arquitetura

- **Videoconferência Nativa (WebRTC):** Em vez de depender de soluções SaaS caras de terceiros (como Zoom ou Agora), desenvolvi um sistema de chamadas WebRTC em rede *Mesh* com servidor de sinalização próprio. Isso reduz custos drasticamente e permite controle total sobre a sala de aula.
- **Gestão de Acesso Estrita (RBAC & RLS):** Hierarquia sólida diretamente no banco de dados. Coordenação, Professores, Monitores e Alunos têm visões e privilégios completamente diferentes, garantidos por *Policies* (RLS) diretamente no PostgreSQL, impossibilitando escalonamento de privilégios no frontend.
- **Auto-Attendance (Presença Automatizada):** Gatilhos (*Database Triggers*) e funções RPC (Remote Procedure Call) no Supabase calculam o tempo real de permanência do aluno na sala virtual e atribuem falta ou presença automaticamente.
- **Auditorias e Tech Debt:** Este projeto acompanha uma extensa gama de documentações de desenvolvimento (`PRD.md`, `AUDITORIA*.md`) que refletem um ciclo de vida profissional de software, focando em melhorias contínuas, identificação de débitos técnicos e otimização de performance no React.
