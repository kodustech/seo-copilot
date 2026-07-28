-- Bulk promote due email tasks to the human queue when auto-send is off.
-- Merges auto_send_disabled into meta without wiping existing jsonb keys.

CREATE OR REPLACE FUNCTION public.promote_due_email_to_human_queue(
  p_enrollment_ids UUID[],
  p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
BEGIN
  IF p_enrollment_ids IS NULL OR array_length(p_enrollment_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.outreach_send_tasks
  SET
    status = 'ready',
    mode = 'semi',
    provider = 'manual',
    updated_at = p_now,
    meta = COALESCE(meta, '{}'::jsonb) || '{"auto_send_disabled": true}'::jsonb
  WHERE status = 'scheduled'
    AND channel = 'email'
    AND scheduled_for <= p_now
    AND enrollment_id = ANY (p_enrollment_ids);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION public.promote_due_email_to_human_queue(UUID[], TIMESTAMPTZ) IS
  'Promote due scheduled email tasks to ready/semi with auto_send_disabled meta merge.';

GRANT EXECUTE ON FUNCTION public.promote_due_email_to_human_queue(UUID[], TIMESTAMPTZ)
  TO authenticated, service_role;
