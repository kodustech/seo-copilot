-- Channel connect: a persona can store a channel API key (currently dev.to)
-- in the same encrypted persona_credentials vault it uses for model keys, so
-- "Connect dev.to" stores the key in-app instead of an env var. Post-Bridge
-- channels (X etc.) need no new storage — they reference an account id that
-- already lives in persona_channels.channel_config.
--
-- Safe to re-run.

alter table public.persona_credentials drop constraint if exists persona_credentials_provider_check;
alter table public.persona_credentials add constraint persona_credentials_provider_check
  check (
    provider in (
      'kimi', 'google', 'openai', 'anthropic',
      'openai_compatible', 'anthropic_compatible',
      'devto'
    )
  );
