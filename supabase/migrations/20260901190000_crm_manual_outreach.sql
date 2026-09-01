-- Manual email, LinkedIn and other touches need the same structured record as
-- sequence sends. A comment is not enough: it does not update the counters the
-- accounts board reads, so contacted accounts continue to say "never".

ALTER TABLE crm_companies
  ADD COLUMN IF NOT EXISTS last_outreach_channel TEXT;

-- Keep the existing two-argument function for older workers. New callers use
-- this overload so the latest channel can be shown without walking activities.
CREATE OR REPLACE FUNCTION bump_outreach_counters(
  p_company_id UUID,
  p_sent_at TIMESTAMPTZ,
  p_channel TEXT
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE crm_companies
     SET outreach_sent_count = COALESCE(outreach_sent_count, 0) + 1,
         last_outreach_channel = CASE
           WHEN last_outreach_at IS NULL OR p_sent_at >= last_outreach_at
             THEN p_channel
           ELSE last_outreach_channel
         END,
         last_outreach_at = GREATEST(COALESCE(last_outreach_at, p_sent_at), p_sent_at)
   WHERE id = p_company_id;
$$;

-- One transaction for a manual touch: the timeline and the card counters can
-- never disagree because one write succeeded and the other did not.
CREATE OR REPLACE FUNCTION record_crm_outreach(
  p_company_id UUID,
  p_channel TEXT,
  p_sent_at TIMESTAMPTZ DEFAULT now(),
  p_actor_email TEXT DEFAULT NULL,
  p_contact_id UUID DEFAULT NULL,
  p_contact_name TEXT DEFAULT NULL,
  p_note TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_contact_name TEXT;
  v_channel_label TEXT;
BEGIN
  IF p_channel NOT IN ('email', 'linkedin', 'whatsapp', 'slack', 'phone', 'other') THEN
    RAISE EXCEPTION 'Invalid outreach channel: %', p_channel;
  END IF;

  IF p_contact_id IS NOT NULL THEN
    SELECT name
      INTO v_contact_name
      FROM crm_contacts
     WHERE id = p_contact_id
       AND company_id = p_company_id
       AND archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Contact does not belong to this company';
    END IF;
  ELSE
    v_contact_name := NULLIF(btrim(p_contact_name), '');
  END IF;

  UPDATE crm_companies
     SET outreach_sent_count = COALESCE(outreach_sent_count, 0) + 1,
         last_outreach_channel = CASE
           WHEN last_outreach_at IS NULL OR p_sent_at >= last_outreach_at
             THEN p_channel
           ELSE last_outreach_channel
         END,
         last_outreach_at = GREATEST(COALESCE(last_outreach_at, p_sent_at), p_sent_at),
         last_activity_at = GREATEST(COALESCE(last_activity_at, p_sent_at), p_sent_at)
   WHERE id = p_company_id
     AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company not found';
  END IF;

  v_channel_label := CASE p_channel
    WHEN 'email' THEN 'Email'
    WHEN 'linkedin' THEN 'LinkedIn'
    WHEN 'whatsapp' THEN 'WhatsApp'
    WHEN 'slack' THEN 'Slack'
    WHEN 'phone' THEN 'Phone'
    ELSE 'Outreach'
  END;

  INSERT INTO crm_activities (
    company_id,
    kind,
    summary,
    meta,
    actor_email,
    created_at
  ) VALUES (
    p_company_id,
    'outreach_sent',
    v_channel_label || ' sent' ||
      CASE WHEN v_contact_name IS NOT NULL THEN ' to ' || v_contact_name ELSE '' END,
    jsonb_strip_nulls(jsonb_build_object(
      'channel', p_channel,
      'contact_id', p_contact_id,
      'contact_name', v_contact_name,
      'note', NULLIF(btrim(p_note), ''),
      'manual', true
    )),
    NULLIF(btrim(p_actor_email), ''),
    p_sent_at
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION record_crm_outreach(UUID, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION record_crm_outreach(UUID, TEXT, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT) TO authenticated, service_role;
