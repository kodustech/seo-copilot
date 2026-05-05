-- Extend outreach_prospects.target_type to cover Project 14 (non-LLM
-- partnerships, owned by Junior) and Project 15 (link reclamation, owned by
-- Ed). Same CRM table, just two new categories so each project can filter
-- its own pipeline.

alter table outreach_prospects
  drop constraint if exists outreach_prospects_target_type_check;

alter table outreach_prospects
  add constraint outreach_prospects_target_type_check
  check (target_type in (
    'listicle',
    'guest_post',
    'podcast',
    'awesome_list',
    'article',
    'newsletter',
    'partnership',
    'link_reclamation',
    'other'
  ));
