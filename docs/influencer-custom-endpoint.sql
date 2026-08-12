-- Per-persona custom endpoint: point a persona at any OpenAI- or Anthropic-
-- compatible endpoint (a subscription-backed gateway, a coding-plan endpoint,
-- a proxy, OpenRouter, LiteLLM, etc.) with its own base URL + token. This is
-- how a persona uses a subscription rather than a raw pay-per-token API: you
-- paste the endpoint + token the subscription gives you.
--
-- Safe to re-run.

alter table public.personas
  add column if not exists model_base_url text;

alter table public.personas drop constraint if exists personas_model_provider_check;
alter table public.personas add constraint personas_model_provider_check
  check (
    model_provider is null or model_provider in (
      'kimi', 'google', 'openai', 'anthropic',
      'openai_compatible', 'anthropic_compatible'
    )
  );

alter table public.persona_credentials drop constraint if exists persona_credentials_provider_check;
alter table public.persona_credentials add constraint persona_credentials_provider_check
  check (
    provider in (
      'kimi', 'google', 'openai', 'anthropic',
      'openai_compatible', 'anthropic_compatible'
    )
  );
