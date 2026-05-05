-- Extend social_mentions to cover Web (listicles, dev.to/medium/blog
-- experience posts) and GitHub (awesome-list discovery). Run AFTER the
-- 2026-05-04-extend-social-mentions.sql migration.

alter table social_mentions
  drop constraint if exists social_mentions_platform_check;

alter table social_mentions
  add constraint social_mentions_platform_check
  check (platform in (
    'reddit',
    'twitter',
    'linkedin',
    'hackernews',
    'web',
    'github'
  ));
