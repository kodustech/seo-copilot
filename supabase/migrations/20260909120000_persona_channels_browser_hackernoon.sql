-- Two more ways a persona's writing reaches a platform.
--
-- publish_via 'browser': the tool drives the persona's logged-in session in a
-- real (remote) browser. Medium closed its API to new integrations in 2023, so
-- the only automated path left is its own "Import a story" page.
--
-- platform 'hackernoon': a manual channel. Hacker Noon has no publishing API
-- and every story goes through a human editor, so the persona drafts and a
-- person submits. Distinct from 'hackernews', which is a different site.
--
-- Safe to re-run.

alter table public.persona_channels drop constraint if exists persona_channels_platform_check;
alter table public.persona_channels add constraint persona_channels_platform_check
  check (
    platform in ('x', 'devto', 'blog', 'medium', 'reddit', 'hackernews', 'hackernoon')
  );

alter table public.persona_channels drop constraint if exists persona_channels_publish_via_check;
alter table public.persona_channels add constraint persona_channels_publish_via_check
  check (
    publish_via in ('post_bridge', 'api', 'n8n', 'manual', 'browser')
  );
