-- Migration 021: Fix swap history kind + atomic swap acceptance RPC
--
-- Problem: the trigger `record_lesson_assignment_change` (migration 011) always
-- writes kind='substitution' when professor_id changes, even when that change
-- is the result of a peer swap acceptance. So swaps appeared as substitutions
-- in the Histórico tab.
--
-- Fix:
--   1. Modify the trigger function to check a session-level flag
--      `iv.skip_auto_history`. When set to 'true', the trigger skips its
--      INSERT so the calling context can insert the correct kind itself.
--   2. Add a new RPC `accept_lesson_swap(p_swap_id)` that:
--        - Sets the flag for the transaction
--        - Updates professor_id for the primary lesson (and offered lesson)
--        - Inserts kind='swap' history rows explicitly
--        - Updates swap status to 'accepted'
--      This is atomic (single transaction) and produces the correct kind.

-- ── 1) Update trigger to respect skip flag ─────────────────────────────────

CREATE OR REPLACE FUNCTION record_lesson_assignment_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Callers that want to write their own history row (e.g. accept_lesson_swap)
  -- can set iv.skip_auto_history = 'true' at the start of their transaction.
  IF current_setting('iv.skip_auto_history', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.professor_id IS NOT NULL) THEN
    INSERT INTO lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
    VALUES (NEW.id, NULL, NEW.professor_id, auth.uid(), 'assignment');

  ELSIF (TG_OP = 'UPDATE'
         AND COALESCE(OLD.professor_id::text,'') <> COALESCE(NEW.professor_id::text,'')) THEN
    INSERT INTO lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
    VALUES (NEW.id, OLD.professor_id, NEW.professor_id, auth.uid(), 'substitution');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 2) Atomic swap acceptance RPC ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION accept_lesson_swap(p_swap_id uuid)
RETURNS void AS $$
DECLARE
  v_swap    lesson_swap_requests%ROWTYPE;
  v_primary scheduled_lessons%ROWTYPE;
  v_offered scheduled_lessons%ROWTYPE;
BEGIN
  -- Lock and fetch the swap request
  SELECT * INTO v_swap
  FROM lesson_swap_requests
  WHERE id = p_swap_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido de troca não encontrado.';
  END IF;

  IF v_swap.status <> 'pending' THEN
    RAISE EXCEPTION 'Esta solicitação já foi respondida.';
  END IF;

  -- Suppress the automatic trigger so we can write kind='swap' ourselves
  PERFORM set_config('iv.skip_auto_history', 'true', true); -- true = local to txn

  -- Fetch current professor_ids for history rows
  SELECT * INTO v_primary FROM scheduled_lessons WHERE id = v_swap.scheduled_lesson_id;

  -- Reassign primary lesson to the swap target (acceptor)
  UPDATE scheduled_lessons
  SET professor_id = v_swap.target_id
  WHERE id = v_swap.scheduled_lesson_id;

  -- Record kind='swap' for primary lesson
  INSERT INTO lesson_assignment_history
    (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
  VALUES
    (v_swap.scheduled_lesson_id,
     v_primary.professor_id,
     v_swap.target_id,
     auth.uid(),
     'swap');

  -- Handle mutual swap (offered lesson)
  IF v_swap.offered_lesson_id IS NOT NULL THEN
    SELECT * INTO v_offered FROM scheduled_lessons WHERE id = v_swap.offered_lesson_id;

    UPDATE scheduled_lessons
    SET professor_id = v_swap.requester_id
    WHERE id = v_swap.offered_lesson_id;

    INSERT INTO lesson_assignment_history
      (scheduled_lesson_id, previous_professor_id, new_professor_id, changed_by, kind)
    VALUES
      (v_swap.offered_lesson_id,
       v_offered.professor_id,
       v_swap.requester_id,
       auth.uid(),
       'swap');
  END IF;

  -- Mark swap as accepted
  UPDATE lesson_swap_requests
  SET status = 'accepted', responded_at = now()
  WHERE id = p_swap_id;

  -- Re-enable auto history for anything after this in the same txn (safety)
  PERFORM set_config('iv.skip_auto_history', 'false', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated users (RLS on lesson_swap_requests still applies)
GRANT EXECUTE ON FUNCTION accept_lesson_swap(uuid) TO authenticated;

-- Update the LessonAssignmentKind comment to reflect the new kinds tracked
COMMENT ON TABLE lesson_assignment_history IS
  'Audit log for scheduled_lesson changes. kind values: assignment, substitution, swap, cancellation, reinstatement, reschedule';
