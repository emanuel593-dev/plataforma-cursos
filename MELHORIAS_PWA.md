# Auditoria e Melhorias UI/UX PWA (Mobile)
**Data da Auditoria:** 18 de Abril de 2026
**Foco:** Refino de UI/UX, Componentes Nativos e Progressive Web App (Mobile)

## 1. Navegação Dupla e Redundante (Anti-Pattern Mobile)
* **O Problema:** O sistema exibe simultaneamente a barra inferior (Bottom Tab Bar) e o menu lateral expansível (Hamburger Menu superior) no mobile. Isso gera ruído na hierarquia de navegação e distancia a experiência de um aplicativo nativo.
* **A Solução:** Abolir o Hamburger Menu na visualização Mobile (`< 640px`). A navegação principal deve ficar exclusivamente no Bottom Tab Bar. Navegações complementares (Dashboard Administrativo, Logout, etc) devem ser unificadas em uma aba extra "Mais" ou "Menu" no rodapé.

## 2. Sistema de Áreas Seguras e Respiro (Safe Areas)
* **O Problema:** O uso de paddings engessados/hardcoded (ex: `pb-20`) para distanciar a barra inferior deixa o layout inflexível em diferentes hardwares (como a gesture bar do iOS/Android), resultando em margens erradas e sobreposições base. Telas espremidas (<360px) sofrem agrupando 5 ícones com texto de rodapé.
* **A Solução:** 
  * Utilizar Insets Dinâmicos do PWA via CSS `calc(3.5rem + env(safe-area-inset-bottom))` para o conteúdo sempre respeitar fisicamente a curvatura e a Home Indicator.
  * Ocultar ou reduzir textos da barra inferior em micro-telas, mantendo apenas os ícones simétricos.
  * Top header com `backdrop-blur` conectado limpidamente ao "Status Bar" fundindo PWA com o OS.

## 3. Acessibilidade Tátil e Margem de Erro (Touch Targets)
* **O Problema:** A plataforma possui a classe `.touch-target`, no entanto essa diretriz é ignorada em botões fundamentais. Ações diretas e de alto risco (como editar, deletar ou fechar elementos) nas `ClassesView` e grids de aulas operam num tamanho minúsculo de hit ~26x26px, causando cliques falhos ("miss-clicks").
* **A Solução:** Expandir obrigatoriamente todos os *Icon Buttons* de Listas para a Hitbox invisível de, no mínimo, `44x44px` a `48x48px` (Tamanho mínimo exigido por HIG/Apple e Material Design/Google), aumentando o padding interno.

## 4. Escalonamento Tipográfico e Hierarquia de Cards
* **O Problema:** Tipografia super-dimensionada (`text-xl`) em aparelhos curtos (ex: SE, Folds) força quebras agressivas em Helper Texts e Metadados. Os painéis em base de vidro ("Glass Panels") engolem muito preenchimento lateral, restando menos de 70% de largura horizontal pro conteúdo real.
* **A Solução:** 
  * Estruturar truncamento (`truncate`, `line-clamp-2`) para textos extensos como descrições no mobile. 
  * Comprimir os paddings laterais e verticais do miolo para views como as DataTables (`p-6` para `p-4`/`p-3` em telas curtas) aumentando o aproveitamento do viewport.

## 5. Experiência de Modais e Engavetamento (Bottom Sheets)
* **O Problema:** Os modais Mobile que renderizam formulários imensos sobem do rodapé mas tomam conta absoluta do Viewport sem contenção de espaço. Formulários mais altos podem estourar a Action Bar de cima se a navegação não couber, causando bugs de deslizamento.
* **A Solução:** Evoluir o componente padrão de Modal para "Native Bottom Sheets" em visão Mobile: Terão uma métrica de segurança de altura estrita (`max-h-[90vh]`), scroll interno isolado e uma pílula/drag-handle visual no topo da "gaveta" pra trazer aquele realismo tático nativo.