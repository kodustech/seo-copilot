"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import { SectionLabel, Status, authHeaders, cls, type Persona } from "./shared";

type ModelProviderOption = "" | "kimi" | "google" | "openai" | "anthropic" | "openai_compatible" | "anthropic_compatible";

const PROVIDER_LABELS: Record<Exclude<ModelProviderOption, "">, string> = {
  kimi: "Kimi (Moonshot)",
  google: "Google (Gemini)",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openai_compatible: "OpenAI-compatible endpoint",
  anthropic_compatible: "Anthropic-compatible endpoint",
};

type CredentialMeta = {
  provider: string;
  key_last4: string;
  label: string | null;
  status: string;
  created_at: string;
};

/** The persona's own model and key: billing isolated from the rest of the fleet. */
export function ModelTab({ token, persona }: { token: string; persona: Persona }) {
  const [provider, setProvider] = useState<ModelProviderOption>("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isCustom = provider === "openai_compatible" || provider === "anthropic_compatible";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/model`, { headers: authHeaders(token) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load model config");
      setProvider((body.model_provider ?? "") as ModelProviderOption);
      setModel(body.model_name ?? "");
      setBaseUrl(body.model_base_url ?? "");
      setCredentials(body.credentials ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, persona.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/model`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          provider: provider || null,
          model: model.trim() || null,
          base_url: isCustom ? baseUrl.trim() || null : null,
          ...(apiKey.trim() ? { key: apiKey.trim() } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to save");
      setCredentials(body.credentials ?? []);
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function removeKey(prov: string) {
    const res = await fetch(`/api/influencers/${persona.id}/model?provider=${prov}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    if (res.ok) {
      const body = await res.json();
      setCredentials(body.credentials ?? []);
    }
  }

  if (loading) return <Skeleton className="h-40 bg-white/[0.04]" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className={cn(cls.panel, "space-y-4 p-4")}>
        <p className="text-sm text-neutral-400">
          Leave the provider on the global default to share the workspace key. Pick a provider and paste a key to bill this persona on its own. An OpenAI- or Anthropic-compatible endpoint takes a gateway base URL and its token.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">
            <Select value={provider || "__global"} onValueChange={(v) => setProvider(v === "__global" ? "" : (v as ModelProviderOption))}>
              <SelectTrigger className={cls.select}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={cls.menu}>
                <SelectItem value="__global">Global default</SelectItem>
                {(Object.keys(PROVIDER_LABELS) as Array<Exclude<ModelProviderOption, "">>).map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={isCustom ? "Model (required)" : "Model (optional)"}>
            <Input value={model} placeholder="e.g. gpt-5, claude-sonnet-5, kimi-k2" onChange={(e) => setModel(e.target.value)} className={cls.input} />
          </Field>
        </div>

        {isCustom ? (
          <Field label="Endpoint base URL (required)">
            <Input value={baseUrl} placeholder="https://your-gateway/v1" onChange={(e) => setBaseUrl(e.target.value)} className={cls.input} />
          </Field>
        ) : null}

        <Field label="API key or token" hint="Write-only. Stored encrypted, never shown again.">
          <Input
            type="password"
            value={apiKey}
            placeholder={credentials.length ? "Leave blank to keep the current key" : "Paste the key or token"}
            onChange={(e) => setApiKey(e.target.value)}
            className={cls.input}
          />
        </Field>

        {error ? <p className={cls.errorText}>{error}</p> : null}
        {saved && !error ? <p className="text-xs text-emerald-300">Saved.</p> : null}

        <button type="button" onClick={save} disabled={saving} className={cls.primary}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save model
        </button>
      </div>

      <div className={cn(cls.panel, "p-4")}>
        <SectionLabel>Stored keys</SectionLabel>
        {credentials.length === 0 ? (
          <p className="text-xs text-neutral-500">None yet. This persona runs on the workspace key.</p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {credentials.map((c) => (
              <li key={c.provider} className="flex items-center gap-2 py-2 text-xs">
                <span className="text-neutral-200">{PROVIDER_LABELS[c.provider as Exclude<ModelProviderOption, "">] ?? c.provider}</span>
                <span className="font-mono text-neutral-500">····{c.key_last4}</span>
                <Status tone={c.status === "active" ? "good" : "muted"} className="ml-auto">
                  {c.status}
                </Status>
                <button type="button" onClick={() => removeKey(c.provider)} className="text-neutral-500 hover:text-red-300">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={cn(cls.label, "mb-1 block")}>{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-neutral-600">{hint}</span> : null}
    </label>
  );
}
