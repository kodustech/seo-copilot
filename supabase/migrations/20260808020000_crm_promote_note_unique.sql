-- ---------------------------------------------------------------------------
-- One promote note per (account, enrollment, reason), enforced by the database.
--
-- A single reply reaches promoteEnrollmentToCrm more than once: the inbox sync
-- promotes the moment the message lands (the class is still unknown, so the
-- revive is withheld), and the reply classifier promotes again once it knows a
-- human wrote it — that second pass is what carries the revive. A later inbound
-- on the same thread runs the whole cycle again. Every other write on that path
-- already tolerates the repeat; the activity insert did not, so one answer
-- stacked a "Replied to sequence" note on the timeline for every pass over it.
--
-- The application checked for an existing note first, which closes the case the
-- bug was actually reported for — the two passes are minutes or days apart. It
-- does not close the concurrent one: sync and classification are awaited in
-- sequence inside a single cron run, but the in-process scheduler fires its own
-- sync every 10 minutes with no overlap guard and no coordination with the HTTP
-- cron route that classifies. Two passes reading "no note yet" before either
-- inserts is a narrow window, not an impossible one, and a SELECT cannot close
-- it. A unique index can, so the insert becomes the dedupe point and the
-- application just treats the violation as "already logged".
--
-- Only promote notes are constrained. Every other `note` — account excluded,
-- account restored, promoted from research — carries no enrollment_id in meta,
-- lands NULL in the index expression, and NULLs do not conflict.
-- ---------------------------------------------------------------------------

-- The index cannot be created while the duplicates it forbids are still there.
-- Keep the first note of each group — the one written when the reply actually
-- landed, whose timestamp is the answer to "when did they reply" — and drop the
-- copies the later passes added. Nothing is lost: the rows being deleted are
-- byte-identical in meaning to the one kept, differing only in created_at, and
-- the promotion they describe (status, priority, tags, contact) lives on the
-- account itself, not in the note.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, meta->>'enrollment_id', meta->>'reason'
      ORDER BY created_at, id
    ) AS rn
  FROM crm_activities
  WHERE kind = 'note'
    AND (meta->>'enrollment_id') IS NOT NULL
)
DELETE FROM crm_activities a
USING ranked r
WHERE a.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS crm_activities_promote_note_uq
  ON crm_activities (company_id, (meta->>'enrollment_id'), (meta->>'reason'))
  WHERE kind = 'note'
    AND (meta->>'enrollment_id') IS NOT NULL;
