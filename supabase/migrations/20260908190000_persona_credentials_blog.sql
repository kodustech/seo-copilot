-- A blog channel can keep its content-API key in the same encrypted vault the
-- other channel keys use, so adding a site to the farm is a form in the app
-- instead of an environment variable and a deploy.
--
-- Safe to re-run.

alter table public.persona_credentials drop constraint if exists persona_credentials_provider_check;
alter table public.persona_credentials add constraint persona_credentials_provider_check
  check (
    provider in (
      'kimi', 'google', 'openai', 'anthropic',
      'openai_compatible', 'anthropic_compatible',
      'devto', 'blog'
    )
  );
