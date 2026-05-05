-- Extend social_mentions to support Hacker News + backlink-specific intents.
-- Run this once against the prod Supabase before deploying the lib changes
-- that emit "hackernews" / "backlink_opportunity" / "competitor_listicle".

alter table social_mentions
  drop constraint if exists social_mentions_platform_check;

alter table social_mentions
  add constraint social_mentions_platform_check
  check (platform in ('reddit', 'twitter', 'linkedin', 'hackernews'));

alter table social_mentions
  drop constraint if exists social_mentions_intent_check;

alter table social_mentions
  add constraint social_mentions_intent_check
  check (intent in (
    'asking_help',
    'complaining',
    'comparing_tools',
    'discussing',
    'sharing_experience',
    'backlink_opportunity',
    'competitor_listicle'
  ));
