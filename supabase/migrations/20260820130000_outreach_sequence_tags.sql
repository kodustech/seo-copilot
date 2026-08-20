-- Free-form tags on outreach sequences, so campaigns can be grouped and
-- filtered by initiative (founding-partners, LLM, outbound-BR, QA, …) without
-- relying on the name. Filtering happens client-side, so no index is needed.
alter table outreach_sequences
  add column if not exists tags text[] not null default '{}';
