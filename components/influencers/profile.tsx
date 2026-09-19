"use client";

import { useEffect, useState } from "react";
import { Loader2, Pencil, X } from "lucide-react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { Field } from "./model";
import { authHeaders, cls, type Persona } from "./shared";

type ProfileDraft = {
  bio: string;
  disclosure: string;
  backstory: string;
  tone: string;
  writing_guidelines: string;
  forbidden_topics: string;
};

function toDraft(persona: Persona): ProfileDraft {
  return {
    bio: persona.bio,
    disclosure: persona.disclosure ?? "",
    backstory: persona.backstory,
    tone: persona.tone ?? "",
    writing_guidelines: persona.writing_guidelines ?? "",
    forbidden_topics: persona.forbidden_topics.join("\n"),
  };
}

function splitLines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ProfileTab({ token, persona, onSaved }: { token: string; persona: Persona; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(persona));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(toDraft(persona));
  }, [editing, persona]);

  function update<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function cancel() {
    setDraft(toDraft(persona));
    setError(null);
    setEditing(false);
  }

  async function save() {
    if (!draft.bio.trim() || !draft.backstory.trim()) {
      setError("Bio and Backstory and worldview cannot be empty.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          bio: draft.bio,
          disclosure: draft.disclosure,
          backstory: draft.backstory,
          tone: draft.tone,
          writing_guidelines: draft.writing_guidelines,
          forbidden_topics: splitLines(draft.forbidden_topics),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Failed to save profile");
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className={cn(cls.panel, "space-y-4 p-4")}>
        <div className="flex items-center justify-between">
          <p className={cls.label}>Edit profile</p>
          <button type="button" onClick={cancel} disabled={saving} className={cls.iconBtn} aria-label="Cancel editing" title="Cancel">
            <X className="size-3.5" />
          </button>
        </div>

        <Field label="Bio">
          <Textarea value={draft.bio} onChange={(event) => update("bio", event.target.value)} rows={3} className={cls.textarea} />
        </Field>
        <Field label="AI disclosure" hint="Optional. Leave blank to remove it.">
          <Textarea value={draft.disclosure} onChange={(event) => update("disclosure", event.target.value)} rows={2} className={cls.textarea} />
        </Field>
        <Field label="Backstory and worldview">
          <Textarea value={draft.backstory} onChange={(event) => update("backstory", event.target.value)} rows={8} className={cls.textarea} />
        </Field>
        <Field label="Tone">
          <Textarea value={draft.tone} onChange={(event) => update("tone", event.target.value)} rows={4} className={cls.textarea} />
        </Field>
        <Field label="Writing guidelines">
          <Textarea value={draft.writing_guidelines} onChange={(event) => update("writing_guidelines", event.target.value)} rows={8} className={cls.textarea} />
        </Field>
        <Field label="Never talks about" hint="Use one topic per line. Commas also work.">
          <Textarea value={draft.forbidden_topics} onChange={(event) => update("forbidden_topics", event.target.value)} rows={3} className={cls.textarea} />
        </Field>

        {error ? <p className={cls.error}>{error}</p> : null}
        <div className="flex items-center gap-2">
          <button type="button" onClick={save} disabled={saving} className={cls.primary}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save profile
          </button>
          <button type="button" onClick={cancel} disabled={saving} className={cls.outline}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Bio", value: persona.bio },
    {
      label: "AI disclosure",
      value: persona.disclosure ? persona.disclosure : <span className="text-neutral-500">Not disclosing. Medium shows undisclosed AI writing to followers only; the persona can still add a line per page.</span>,
    },
    { label: "Backstory and worldview", value: persona.backstory },
    { label: "Tone", value: persona.tone ?? <span className="text-neutral-500">Not set</span> },
    { label: "Writing guidelines", value: persona.writing_guidelines ?? <span className="text-neutral-500">Not set</span> },
    {
      label: "Never talks about",
      value: persona.forbidden_topics.length ? (
        <div className="flex flex-wrap gap-1.5">
          {persona.forbidden_topics.map((topic) => (
            <span key={topic} className={cls.chip}>
              {topic}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-neutral-500">Nothing forbidden</span>
      ),
    },
  ];

  return (
    <div className={cn(cls.panel, "divide-y divide-white/[0.06]")}>
      <div className="flex items-center justify-between px-4 py-3">
        <p className={cls.label}>Profile</p>
        <button type="button" onClick={() => setEditing(true)} className={cls.outline}>
          <Pencil className="size-3.5" /> Edit
        </button>
      </div>
      {rows.map((row) => (
        <div key={row.label} className="grid gap-1 px-4 py-3 md:grid-cols-[180px_minmax(0,1fr)] md:gap-6">
          <p className={cn(cls.label, "md:pt-0.5")}>{row.label}</p>
          <div className="text-sm leading-relaxed text-neutral-200">{row.value}</div>
        </div>
      ))}
    </div>
  );
}
