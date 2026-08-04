-- ---------------------------------------------------------------------------
-- Outbound metrics.
--
-- Two things happen here:
--
--   1. Reply classification columns on outreach_reply_threads. A raw reply
--      count mixes "let's talk" with out-of-office and mailer-daemon, so every
--      funnel number built on it is noise. Classification is filled in by
--      lib/outreach/reply-classification.ts after the Gmail sync.
--
--   2. public.outbound_metrics(...) — one RPC returning the whole outbound
--      dashboard as JSONB. One round trip instead of a dozen; aggregation
--      stays in Postgres instead of pulling rows into Node.
--
-- Rates are deliberately NOT computed here: the function returns raw counts
-- and the caller divides. Keeps div-by-zero and rounding in one place (TS).
-- ---------------------------------------------------------------------------

-- ── 1. Reply classification ───────────────────────────────────────────

ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS reply_class TEXT;

ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS reply_class_confidence NUMERIC;

ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS reply_class_reason TEXT;

ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS reply_class_model TEXT;

ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS reply_classified_at TIMESTAMPTZ;

-- Classified against the last inbound message we had seen. When a thread gets
-- new inbound after classification the label is stale and gets recomputed.
ALTER TABLE public.outreach_reply_threads
  ADD COLUMN IF NOT EXISTS reply_classified_inbound_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outreach_reply_threads_reply_class_check'
  ) THEN
    ALTER TABLE public.outreach_reply_threads
      ADD CONSTRAINT outreach_reply_threads_reply_class_check
      CHECK (reply_class IS NULL OR reply_class IN (
        'positive',      -- wants to talk / asked for more / booked
        'neutral',       -- answered but no intent either way, "send info"
        'not_now',       -- interested later, "circle back in Q3"
        'not_interested',-- explicit no
        'referral',      -- "talk to <other person>"
        'auto_reply',    -- out-of-office, autoresponder, ticket ack
        'unsubscribe',   -- opt-out / stop contacting
        'bounce'         -- DSN / mailer-daemon
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS outreach_reply_threads_class_idx
  ON public.outreach_reply_threads (reply_class, first_inbound_at DESC);

-- Work queue for the classifier.
CREATE INDEX IF NOT EXISTS outreach_reply_threads_needs_class_idx
  ON public.outreach_reply_threads (last_inbound_at DESC)
  WHERE reply_class IS NULL;

-- When a thread gets a newer inbound message the old label may no longer hold
-- ("thanks, not now" → "actually, let's talk"). Clearing it puts the thread
-- back in the unclassified queue.
--
-- This is a trigger rather than a filter in the classifier's query because
-- PostgREST cannot compare two columns of the same row, so the worker has no
-- way to ask for "classified before the last inbound" over the REST API.
CREATE OR REPLACE FUNCTION public.outreach_reply_threads_reset_class()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.last_inbound_at IS DISTINCT FROM OLD.last_inbound_at
     AND NEW.reply_class IS NOT DISTINCT FROM OLD.reply_class
  THEN
    NEW.reply_class := NULL;
    NEW.reply_class_confidence := NULL;
    NEW.reply_class_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS outreach_reply_threads_reset_class_trg
  ON public.outreach_reply_threads;

CREATE TRIGGER outreach_reply_threads_reset_class_trg
  BEFORE UPDATE ON public.outreach_reply_threads
  FOR EACH ROW
  EXECUTE FUNCTION public.outreach_reply_threads_reset_class();

COMMENT ON COLUMN public.outreach_reply_threads.reply_class IS
  'LLM classification of the inbound reply. NULL = not classified yet.';
COMMENT ON COLUMN public.outreach_reply_threads.reply_classified_inbound_at IS
  'Value of last_inbound_at when the class was computed; staler => reclassify.';

-- ── 2. Index for the metrics scans ────────────────────────────────────

-- Every section of the RPC filters sent tasks by time. The existing indexes
-- are keyed on scheduled_for (the sending queue) or on enrollment_id, neither
-- of which helps a window scan over sent_at.
CREATE INDEX IF NOT EXISTS outreach_send_tasks_sent_at_idx
  ON public.outreach_send_tasks (sent_at)
  WHERE status = 'sent';

-- Reply-side windows (reply mix, daily series, per-sequence) filter on
-- first_inbound_at.
CREATE INDEX IF NOT EXISTS outreach_reply_threads_first_inbound_idx
  ON public.outreach_reply_threads (first_inbound_at);

-- ── 3. Metrics RPC ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.outbound_metrics(
  p_since       TIMESTAMPTZ,
  p_until       TIMESTAMPTZ DEFAULT now(),
  p_sequence_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
-- INVOKER, not DEFINER: this only reads tables whose RLS already grants SELECT
-- to authenticated, so definer rights would buy nothing and would silently
-- bypass RLS if any of those policies are ever tightened. Verified against
-- Postgres 16 — the payload is identical either way when called as
-- `authenticated`.
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_volume     JSONB;
  v_enrollment JSONB;
  v_funnel     JSONB;
  v_classes    JSONB;
  v_by_step    JSONB;
  v_by_seq     JSONB;
  v_daily      JSONB;
  v_speed      JSONB;
  v_pipeline   JSONB;
  v_hygiene    JSONB;
BEGIN
  -- ── Volume: what actually went out in the window ────────────────────
  SELECT jsonb_build_object(
    'emails_sent',      count(*) FILTER (WHERE t.channel = 'email'),
    'linkedin_sent',    count(*) FILTER (WHERE t.channel = 'linkedin'),
    'auto_sent',        count(*) FILTER (WHERE t.mode = 'auto'),
    'semi_sent',        count(*) FILTER (WHERE t.mode = 'semi'),
    'total_sent',       count(*),
    'contacts_touched', count(DISTINCT t.enrollment_id)
  )
  INTO v_volume
  FROM outreach_send_tasks t
  JOIN outreach_enrollments e ON e.id = t.enrollment_id
  WHERE t.status = 'sent'
    AND t.sent_at >= p_since
    AND t.sent_at <  p_until
    AND (p_sequence_id IS NULL OR e.sequence_id = p_sequence_id);

  -- Failed/skipped tasks never get sent_at, so they are dated by updated_at.
  SELECT v_volume || jsonb_build_object(
    'tasks_failed',  count(*) FILTER (WHERE t.status = 'failed'),
    'tasks_skipped', count(*) FILTER (WHERE t.status = 'skipped')
  )
  INTO v_volume
  FROM outreach_send_tasks t
  JOIN outreach_enrollments e ON e.id = t.enrollment_id
  WHERE t.status IN ('failed', 'skipped')
    AND t.updated_at >= p_since
    AND t.updated_at <  p_until
    AND (p_sequence_id IS NULL OR e.sequence_id = p_sequence_id);

  -- ── Enrollments created (top of funnel) ─────────────────────────────
  SELECT jsonb_build_object(
    'created',        count(*),
    'from_research',  count(*) FILTER (WHERE e.source = 'research'),
    'from_outreach',  count(*) FILTER (WHERE e.source = 'outreach'),
    'from_manual',    count(*) FILTER (WHERE e.source = 'manual'),
    'active_now', (
      SELECT count(*) FROM outreach_enrollments a
      WHERE a.status = 'active'
        AND (p_sequence_id IS NULL OR a.sequence_id = p_sequence_id)
    )
  )
  INTO v_enrollment
  FROM outreach_enrollments e
  WHERE e.created_at >= p_since
    AND e.created_at <  p_until
    AND (p_sequence_id IS NULL OR e.sequence_id = p_sequence_id);

  -- ── Funnel, cohort-based ────────────────────────────────────────────
  -- Cohort = enrollments whose FIRST send landed inside the window, measured
  -- at their status today. Dividing replies-this-week by sends-this-week would
  -- mix cohorts: a reply to last month's send is not this week's performance.
  WITH candidates AS (
    -- An enrollment can only have its FIRST send inside the window if it has
    -- any send inside the window. Narrowing to those first keeps the min()
    -- off the all-time task history, which otherwise grows without bound.
    SELECT DISTINCT t.enrollment_id
    FROM outreach_send_tasks t
    WHERE t.status = 'sent'
      AND t.sent_at >= p_since
      AND t.sent_at <  p_until
  ),
  first_send AS (
    SELECT t.enrollment_id, min(t.sent_at) AS first_sent_at
    FROM outreach_send_tasks t
    JOIN candidates c ON c.enrollment_id = t.enrollment_id
    WHERE t.status = 'sent' AND t.sent_at IS NOT NULL
    GROUP BY t.enrollment_id
  ),
  cohort AS (
    SELECT e.id, e.status
    FROM first_send fs
    JOIN outreach_enrollments e ON e.id = fs.enrollment_id
    WHERE fs.first_sent_at >= p_since
      AND fs.first_sent_at <  p_until
      AND (p_sequence_id IS NULL OR e.sequence_id = p_sequence_id)
  )
  SELECT jsonb_build_object(
    'contacted',          count(*),
    'replied',            count(*) FILTER (WHERE status = 'replied'),
    'bounced',            count(*) FILTER (WHERE status = 'bounced'),
    'failed',             count(*) FILTER (WHERE status = 'failed'),
    'completed_no_reply', count(*) FILTER (WHERE status = 'completed'),
    'in_flight',          count(*) FILTER (WHERE status IN ('active', 'paused')),
    'cancelled',          count(*) FILTER (WHERE status = 'cancelled')
  )
  INTO v_funnel
  FROM cohort;

  -- ── Reply classes (threads whose first inbound landed in window) ─────
  SELECT COALESCE(
    jsonb_object_agg(k, n) FILTER (WHERE k IS NOT NULL),
    '{}'::jsonb
  )
  INTO v_classes
  FROM (
    SELECT COALESCE(rt.reply_class, 'unclassified') AS k, count(*) AS n
    FROM outreach_reply_threads rt
    WHERE rt.first_inbound_at >= p_since
      AND rt.first_inbound_at <  p_until
      AND (p_sequence_id IS NULL OR rt.sequence_id = p_sequence_id)
    GROUP BY 1
  ) s;

  -- ── Per step: does follow-up 3 earn its send? ───────────────────────
  -- A reply is attributed to the last step that went out before it arrived.
  WITH sends AS (
    SELECT st.position, count(*) AS sent, count(DISTINCT t.enrollment_id) AS contacts
    FROM outreach_send_tasks t
    JOIN outreach_sequence_steps st ON st.id = t.step_id
    JOIN outreach_enrollments e     ON e.id  = t.enrollment_id
    WHERE t.status = 'sent'
      AND t.sent_at >= p_since
      AND t.sent_at <  p_until
      AND (p_sequence_id IS NULL OR e.sequence_id = p_sequence_id)
    GROUP BY st.position
  ),
  replies AS (
    SELECT
      (
        SELECT max(st2.position)
        FROM outreach_send_tasks t2
        JOIN outreach_sequence_steps st2 ON st2.id = t2.step_id
        WHERE t2.enrollment_id = rt.enrollment_id
          AND t2.status = 'sent'
          AND t2.sent_at <= rt.first_inbound_at
      ) AS position,
      rt.reply_class
    FROM outreach_reply_threads rt
    WHERE rt.enrollment_id IS NOT NULL
      AND rt.first_inbound_at >= p_since
      AND rt.first_inbound_at <  p_until
      AND COALESCE(rt.reply_class, '') <> 'bounce'
      AND (p_sequence_id IS NULL OR rt.sequence_id = p_sequence_id)
  ),
  reply_agg AS (
    SELECT position,
           count(*) AS replies,
           count(*) FILTER (WHERE reply_class = 'positive') AS positive
    FROM replies
    WHERE position IS NOT NULL
    GROUP BY position
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x.position), '[]'::jsonb)
  INTO v_by_step
  FROM (
    SELECT
      COALESCE(s.position, r.position)  AS position,
      COALESCE(s.sent, 0)               AS sent,
      COALESCE(s.contacts, 0)           AS contacts,
      COALESCE(r.replies, 0)            AS replies,
      COALESCE(r.positive, 0)           AS positive
    FROM sends s
    FULL OUTER JOIN reply_agg r ON r.position = s.position
  ) x;

  -- ── Per sequence ────────────────────────────────────────────────────
  WITH sends AS (
    SELECT e.sequence_id,
           count(*) AS sent,
           count(DISTINCT t.enrollment_id) AS contacts
    FROM outreach_send_tasks t
    JOIN outreach_enrollments e ON e.id = t.enrollment_id
    WHERE t.status = 'sent'
      AND t.sent_at >= p_since
      AND t.sent_at <  p_until
    GROUP BY e.sequence_id
  ),
  reps AS (
    SELECT rt.sequence_id,
           count(*) FILTER (WHERE COALESCE(rt.reply_class, '') <> 'bounce') AS replies,
           count(*) FILTER (WHERE rt.reply_class = 'positive')              AS positive,
           count(*) FILTER (WHERE rt.reply_class = 'bounce')                AS bounce_threads
    FROM outreach_reply_threads rt
    WHERE rt.sequence_id IS NOT NULL
      AND rt.first_inbound_at >= p_since
      AND rt.first_inbound_at <  p_until
    GROUP BY rt.sequence_id
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x.sent DESC NULLS LAST), '[]'::jsonb)
  INTO v_by_seq
  FROM (
    SELECT
      sq.id                        AS sequence_id,
      sq.name                      AS name,
      sq.status                    AS status,
      COALESCE(s.sent, 0)          AS sent,
      COALESCE(s.contacts, 0)      AS contacts,
      COALESCE(r.replies, 0)       AS replies,
      COALESCE(r.positive, 0)      AS positive,
      COALESCE(r.bounce_threads,0) AS bounces
    FROM outreach_sequences sq
    LEFT JOIN sends s ON s.sequence_id = sq.id
    LEFT JOIN reps  r ON r.sequence_id = sq.id
    WHERE (p_sequence_id IS NULL OR sq.id = p_sequence_id)
      AND (COALESCE(s.sent, 0) > 0 OR COALESCE(r.replies, 0) > 0)
  ) x;

  -- ── Daily series ────────────────────────────────────────────────────
  WITH days AS (
    SELECT generate_series(
      date_trunc('day', p_since),
      date_trunc('day', p_until),
      interval '1 day'
    ) AS d
  ),
  s AS (
    SELECT date_trunc('day', t.sent_at) AS d, count(*) AS sent
    FROM outreach_send_tasks t
    JOIN outreach_enrollments e ON e.id = t.enrollment_id
    WHERE t.status = 'sent'
      AND t.sent_at >= p_since AND t.sent_at < p_until
      AND (p_sequence_id IS NULL OR e.sequence_id = p_sequence_id)
    GROUP BY 1
  ),
  r AS (
    SELECT date_trunc('day', rt.first_inbound_at) AS d,
           count(*) FILTER (WHERE COALESCE(rt.reply_class, '') <> 'bounce') AS replies,
           count(*) FILTER (WHERE rt.reply_class = 'positive')              AS positive,
           count(*) FILTER (WHERE rt.reply_class = 'bounce')                AS bounces
    FROM outreach_reply_threads rt
    WHERE rt.first_inbound_at >= p_since AND rt.first_inbound_at < p_until
      AND (p_sequence_id IS NULL OR rt.sequence_id = p_sequence_id)
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'date',     to_char(days.d, 'YYYY-MM-DD'),
    'sent',     COALESCE(s.sent, 0),
    'replies',  COALESCE(r.replies, 0),
    'positive', COALESCE(r.positive, 0),
    'bounces',  COALESCE(r.bounces, 0)
  ) ORDER BY days.d), '[]'::jsonb)
  INTO v_daily
  FROM days
  LEFT JOIN s ON s.d = days.d
  LEFT JOIN r ON r.d = days.d;

  -- ── Speed: how long until they answer ───────────────────────────────
  WITH replied AS (
    -- Only enrollments that got a reply in the window need a first-send time.
    -- Note this cannot reuse the funnel's bound: a reply this week to a send
    -- from last month is a valid sample, so the send side stays unbounded for
    -- these few enrollments.
    SELECT DISTINCT rt.enrollment_id
    FROM outreach_reply_threads rt
    WHERE rt.enrollment_id IS NOT NULL
      AND rt.first_inbound_at >= p_since
      AND rt.first_inbound_at <  p_until
      AND COALESCE(rt.reply_class, '') <> 'bounce'
      AND (p_sequence_id IS NULL OR rt.sequence_id = p_sequence_id)
  ),
  first_send AS (
    SELECT t.enrollment_id, min(t.sent_at) AS first_sent_at
    FROM outreach_send_tasks t
    JOIN replied r ON r.enrollment_id = t.enrollment_id
    WHERE t.status = 'sent' AND t.sent_at IS NOT NULL
    GROUP BY t.enrollment_id
  ),
  gaps AS (
    SELECT EXTRACT(EPOCH FROM (rt.first_inbound_at - fs.first_sent_at)) / 3600.0 AS hours
    FROM outreach_reply_threads rt
    JOIN first_send fs ON fs.enrollment_id = rt.enrollment_id
    WHERE rt.first_inbound_at >= p_since
      AND rt.first_inbound_at <  p_until
      AND rt.first_inbound_at >  fs.first_sent_at
      AND COALESCE(rt.reply_class, '') <> 'bounce'
      AND (p_sequence_id IS NULL OR rt.sequence_id = p_sequence_id)
  )
  SELECT jsonb_build_object(
    'samples',      count(*),
    'median_hours', ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 1),
    'p90_hours',    ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY hours)::numeric, 1)
  )
  INTO v_speed
  FROM gaps;

  -- ── Pipeline: what outbound produced downstream ─────────────────────
  -- An account counts as outbound-attributed when it was created by a sequence
  -- (source) or a sequence promotion wrote into its enrichment. The second half
  -- matters because upsertAccountByDomain preserves the original source when
  -- the account already existed.
  WITH outbound AS (
    SELECT c.*
    FROM crm_companies c
    WHERE (c.source = 'sequence' OR c.enrichment ? 'sequence')
      -- Honour the sequence filter: the promotion writes the sequence id into
      -- enrichment, so a filtered view shows only what that sequence produced.
      AND (
        p_sequence_id IS NULL
        OR c.enrichment -> 'sequence' ->> 'sequence_id' = p_sequence_id::text
      )
  )
  SELECT jsonb_build_object(
    'accounts_total',   (SELECT count(*) FROM outbound),
    'created_in_window',(SELECT count(*) FROM outbound WHERE created_at >= p_since AND created_at < p_until),
    'by_status',        (
      SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb)
      FROM (SELECT status, count(*) AS n FROM outbound GROUP BY status) q
    ),
    'entered_in_window',(
      -- Status transitions logged on outbound accounts during the window.
      SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb)
      FROM (
        SELECT a.meta->>'to' AS k, count(*) AS n
        FROM crm_activities a
        JOIN outbound o ON o.id = a.company_id
        WHERE a.kind = 'status_change'
          AND a.created_at >= p_since
          AND a.created_at <  p_until
          AND a.meta->>'to' IS NOT NULL
        GROUP BY 1
      ) q
    ),
    'arr_won',          (SELECT COALESCE(sum(arr), 0) FROM outbound WHERE status = 'customer'),
    'arr_open',         (SELECT COALESCE(sum(arr), 0) FROM outbound
                          WHERE status IN ('qualified', 'poc', 'negotiation'))
  )
  INTO v_pipeline;

  -- ── Hygiene: the machine itself ─────────────────────────────────────
  SELECT jsonb_build_object(
    'ready_overdue', (
      SELECT COALESCE(jsonb_object_agg(channel, n), '{}'::jsonb)
      FROM (
        SELECT t.channel, count(*) AS n
        FROM outreach_send_tasks t
        WHERE t.status = 'ready' AND t.scheduled_for < now()
        GROUP BY t.channel
      ) q
    ),
    'ready_oldest_hours', (
      SELECT ROUND(EXTRACT(EPOCH FROM (now() - min(t.scheduled_for))) / 3600.0)
      FROM outreach_send_tasks t
      WHERE t.status = 'ready' AND t.scheduled_for < now()
    ),
    'scheduled_overdue', (
      SELECT count(*) FROM outreach_send_tasks t
      WHERE t.status = 'scheduled' AND t.scheduled_for < now() - interval '2 hours'
    ),
    'stalled_enrollments', (
      SELECT count(*) FROM outreach_enrollments e
      WHERE e.status = 'active'
        AND e.next_run_at IS NOT NULL
        AND e.next_run_at < now() - interval '24 hours'
    ),
    'enrollments_failed', (
      SELECT count(*) FROM outreach_enrollments e WHERE e.status = 'failed'
    ),
    'unclassified_threads', (
      SELECT count(*) FROM outreach_reply_threads rt WHERE rt.reply_class IS NULL
    ),
    'unmatched_threads', (
      SELECT count(*) FROM outreach_reply_threads rt
      WHERE rt.matched_how = 'unmatched'
        AND rt.first_inbound_at >= p_since AND rt.first_inbound_at < p_until
    ),
    'mailboxes', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id',         m.id,
        'label',      m.label,
        'from_email', m.from_email,
        'enabled',    m.enabled,
        'daily_cap',  m.daily_cap,
        -- sent_today is a running counter reset by date; stale date means zero.
        'sent_today', CASE WHEN m.sent_today_date = current_date
                           THEN m.sent_today ELSE 0 END,
        'last_sent_at', m.last_sent_at,
        'last_test_ok', m.last_test_ok
      ) ORDER BY m.is_default DESC, m.label), '[]'::jsonb)
      FROM outreach_mailboxes m
    ),
    'contact_coverage', (
      SELECT jsonb_build_object(
        'people_total',    count(*),
        'with_email',      count(*) FILTER (WHERE p.email IS NOT NULL AND p.email <> ''),
        'verified',        count(*) FILTER (WHERE lower(COALESCE(p.email_status, '')) IN ('valid', 'deliverable', 'ok')),
        'risky_or_invalid',count(*) FILTER (WHERE lower(COALESCE(p.email_status, '')) IN ('invalid', 'undeliverable', 'risky', 'catchall', 'accept_all', 'unknown'))
      )
      FROM research_people p
    )
  )
  INTO v_hygiene;

  RETURN jsonb_build_object(
    'since',       p_since,
    'until',       p_until,
    'sequence_id', p_sequence_id,
    'volume',      COALESCE(v_volume, '{}'::jsonb),
    'enrollment',  COALESCE(v_enrollment, '{}'::jsonb),
    'funnel',      COALESCE(v_funnel, '{}'::jsonb),
    'reply_classes', COALESCE(v_classes, '{}'::jsonb),
    'by_step',     COALESCE(v_by_step, '[]'::jsonb),
    'by_sequence', COALESCE(v_by_seq, '[]'::jsonb),
    'daily',       COALESCE(v_daily, '[]'::jsonb),
    'speed',       COALESCE(v_speed, '{}'::jsonb),
    'pipeline',    COALESCE(v_pipeline, '{}'::jsonb),
    'hygiene',     COALESCE(v_hygiene, '{}'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.outbound_metrics(TIMESTAMPTZ, TIMESTAMPTZ, UUID) IS
  'Outbound dashboard payload: volume, cohort funnel, reply classes, per-step '
  'and per-sequence breakdowns, daily series, CRM pipeline attribution and '
  'operational hygiene. Returns raw counts; rates are computed by the caller.';

GRANT EXECUTE ON FUNCTION public.outbound_metrics(TIMESTAMPTZ, TIMESTAMPTZ, UUID)
  TO authenticated, service_role;
