-- ============================================================================
-- IV Platform — Seed: Módulos e Aulas do LMS Education Platform
-- ============================================================================

-- Use fixed UUIDs so foreign keys in lessons can reference modules deterministically.

-- ── 1° Módulo (Azul) ────────────────────────────────────────────────────────

INSERT INTO modules (id, name, description, color, order_index) VALUES
  ('a1000000-0000-0000-0000-000000000001', '1° Módulo', 'Fundamentos da fé cristã, oração, guerra espiritual e vida na casa de Deus.', '#3b82f6', 1);

INSERT INTO lessons (module_id, title, order_index) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'Enfrentando o dia a dia I – Vida Social e Música', 1),
  ('a1000000-0000-0000-0000-000000000001', 'Enfrentando o dia a dia II – Vencendo as tentações', 2),
  ('a1000000-0000-0000-0000-000000000001', 'A arma do cristão I – Bíblia', 3),
  ('a1000000-0000-0000-0000-000000000001', 'A arma do cristão II – Oração e Jejum', 4),
  ('a1000000-0000-0000-0000-000000000001', 'As características de Deus', 5),
  ('a1000000-0000-0000-0000-000000000001', 'DEUS X PECADO – A obra redentora da cruz e o poder do nome de Jesus', 6),
  ('a1000000-0000-0000-0000-000000000001', 'O desenvolvimento da fé com a condução do Espírito Santo', 7),
  ('a1000000-0000-0000-0000-000000000001', 'Fé (Dízimo e ofertas)', 8),
  ('a1000000-0000-0000-0000-000000000001', 'Obediência', 9),
  ('a1000000-0000-0000-0000-000000000001', 'Benção e maldição', 10),
  ('a1000000-0000-0000-0000-000000000001', 'Guerra Espiritual – A armadura de Deus', 11),
  ('a1000000-0000-0000-0000-000000000001', 'A importância da casa de Deus', 12);

-- ── 2° Módulo (Verde) ───────────────────────────────────────────────────────

INSERT INTO modules (id, name, description, color, order_index) VALUES
  ('a2000000-0000-0000-0000-000000000002', '2° Módulo', 'Caráter cristão, cura da alma, sentimentos e o verdadeiro amor.', '#22c55e', 2);

INSERT INTO lessons (module_id, title, order_index) VALUES
  ('a2000000-0000-0000-0000-000000000002', 'Projeto de Deus x Decisão do homem', 1),
  ('a2000000-0000-0000-0000-000000000002', 'Caráter deformado: Mente distorcida', 2),
  ('a2000000-0000-0000-0000-000000000002', 'Caráter deformado: Emoções descontroladas', 3),
  ('a2000000-0000-0000-0000-000000000002', 'Caráter deformado: Vã maneira de viver', 4),
  ('a2000000-0000-0000-0000-000000000002', 'Caráter em construção: Valores organizados', 5),
  ('a2000000-0000-0000-0000-000000000002', 'O perfil do caráter cristão', 6),
  ('a2000000-0000-0000-0000-000000000002', 'Ser humano: Conceitos e a importância da cura da alma', 7),
  ('a2000000-0000-0000-0000-000000000002', 'Jesus o grande conselheiro', 8),
  ('a2000000-0000-0000-0000-000000000002', 'Instrumento da cura da alma', 9),
  ('a2000000-0000-0000-0000-000000000002', 'Como melhorar seus sentimentos', 10),
  ('a2000000-0000-0000-0000-000000000002', 'O verdadeiro amor', 11),
  ('a2000000-0000-0000-0000-000000000002', 'Avaliação / Encerramento', 12);

-- ── 3° Módulo (Vermelho) ────────────────────────────────────────────────────

INSERT INTO modules (id, name, description, color, order_index) VALUES
  ('a3000000-0000-0000-0000-000000000003', '3° Módulo', 'Liderança, chamado ministerial, discipulado e escatologia.', '#ef4444', 3);

INSERT INTO lessons (module_id, title, order_index) VALUES
  ('a3000000-0000-0000-0000-000000000003', 'Desenvolvendo o seu talento', 1),
  ('a3000000-0000-0000-0000-000000000003', 'Paixão pelo perdido', 2),
  ('a3000000-0000-0000-0000-000000000003', 'O chamado', 3),
  ('a3000000-0000-0000-0000-000000000003', 'TAC', 4),
  ('a3000000-0000-0000-0000-000000000003', 'A batalha pessoal do líder de células', 5),
  ('a3000000-0000-0000-0000-000000000003', 'A batalha de levar outros a Cristo', 6),
  ('a3000000-0000-0000-0000-000000000003', 'Escada do sucesso – Parte I', 7),
  ('a3000000-0000-0000-0000-000000000003', 'Escada do sucesso – Parte II', 8),
  ('a3000000-0000-0000-0000-000000000003', 'Construindo a aliança de discípulo', 9),
  ('a3000000-0000-0000-0000-000000000003', 'A mordomia do dinheiro no corpo de Cristo', 10),
  ('a3000000-0000-0000-0000-000000000003', 'Noções gerais e a força do louvor', 11),
  ('a3000000-0000-0000-0000-000000000003', 'A volta de Jesus', 12);
