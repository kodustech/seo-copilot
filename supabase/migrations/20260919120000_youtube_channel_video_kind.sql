-- YouTube as a persona channel, plus the 'video' activity kind.
--
-- A youtube channel presents one avatar + one voice (stored on the channel's
-- channel_config), renders script blocks through HeyGen, and uploads the
-- finished mp4 through the YouTube Data API — always unlisted, because the
-- platform's AI-content checkbox has no API and a person confirms it in
-- Studio before anything goes public.
--
-- Safe to re-run.

alter table public.persona_channels drop constraint if exists persona_channels_platform_check;
alter table public.persona_channels add constraint persona_channels_platform_check
  check (
    platform in ('x', 'devto', 'blog', 'medium', 'reddit', 'hackernews', 'hackernoon', 'youtube')
  );

alter table public.persona_activities drop constraint if exists persona_activities_kind_check;
alter table public.persona_activities add constraint persona_activities_kind_check
  check (
    kind in ('post', 'reply', 'quote', 'article', 'crosspost', 'video')
  );
