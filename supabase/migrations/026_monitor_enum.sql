-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 026_monitor_enum                                                         ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Add the 'monitor' value to the user_role enum.                           ║
-- ║                                                                          ║
-- ║ This MUST live in a dedicated migration: ALTER TYPE … ADD VALUE cannot  ║
-- ║ be referenced in the same transaction that adds it (PG 12+ relaxed the  ║
-- ║ rule, but Supabase migrations wrap each file in BEGIN/COMMIT and any   ║
-- ║ later helper or policy that mentions `'monitor'::user_role` would       ║
-- ║ blow up). Keeping the enum bump alone guarantees forward-compatibility.║
-- ╚══════════════════════════════════════════════════════════════════════════╝

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'monitor'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'monitor';
  END IF;
END $$;
