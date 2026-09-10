"use client";

import { useState } from "react";
import { Bot, Loader2, Sparkles, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { Field } from "./model";
import { authHeaders, cls } from "./shared";

type Proposal = {
  handle: string;
  display_name: string;
  bio: string;
  backstory: string;
  disclosure: string;
  beat: string;
  tone: string;
  writing_guidelines: string;
  preferred_words: string[];
  forbidden_words: string[];
  allowed_topics: string[];
  forbidden_topics: string[];
  avatar_prompt: string;
  avatar_url: string | null;
};

/** Two steps: describe the niche, then edit the character the wizard drew. */
export function WizardDialog({
  token,
  open,
  onOpenChange,
  onCreated,
}: {
  token: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [direction, setDirection] = useState("");
  const [objective, setObjective] = useState("");
  const [language, setLanguage] = useState("en-US");
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/influencers/wizard", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ direction, objective, language }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Generation failed");
      setProposal(body.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function create() {
    if (!proposal) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          ...proposal,
          content_config: { language },
          channels: [
            { platform: "x" },
            { platform: "devto" },
            { platform: "medium" },
            { platform: "reddit" },
            { platform: "hackernews" },
            { platform: "hackernoon" },
          ],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Creation failed");
      setProposal(null);
      setDirection("");
      setObjective("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Creation failed");
    } finally {
      setCreating(false);
    }
  }

  function updateProposal<K extends keyof Proposal>(key: K, value: Proposal[K]) {
    setProposal((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto border-white/10 bg-neutral-950 text-neutral-100">
        <DialogHeader>
          <DialogTitle className="text-neutral-100">{proposal ? "Edit the character" : "Create influencer"}</DialogTitle>
          <DialogDescription className="text-neutral-400">
            {proposal
              ? "Everything here is editable before the persona exists. It is born paused; turn autonomy on when you are happy with it."
              : "Describe the niche; the wizard designs an openly-AI character for it."}
          </DialogDescription>
        </DialogHeader>

        {!proposal ? (
          <div className="space-y-3">
            <Field label="Niche or direction">
              <Textarea
                value={direction}
                onChange={(event) => setDirection(event.target.value)}
                placeholder='e.g. "a grumpy staff engineer obsessed with code review quality and skeptical of AI hype"'
                rows={3}
                className={cls.textarea}
              />
            </Field>
            <Field label="Marketing objective (optional)">
              <Input
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="e.g. awareness for AI code review, links to aicodereview.io"
                className={cls.input}
              />
            </Field>
            <Field label="Content language">
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger className={cn(cls.select, "w-48")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={cls.menu}>
                  <SelectItem value="en-US">English</SelectItem>
                  <SelectItem value="pt-BR">Português</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {error ? <p className={cls.errorText}>{error}</p> : null}
            <DialogFooter>
              <button type="button" disabled={generating || !direction.trim()} onClick={generate} className={cls.primary}>
                {generating ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" /> Designing…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3.5" /> Design persona
                  </>
                )}
              </button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              {proposal.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={proposal.avatar_url} alt="avatar" className="size-16 rounded-full object-cover ring-1 ring-white/10" />
              ) : (
                <div className="flex size-16 items-center justify-center rounded-full bg-white/[0.06] ring-1 ring-white/10">
                  <Bot className="size-8 text-neutral-500" />
                </div>
              )}
              <div className="grid flex-1 gap-2 sm:grid-cols-2">
                <Field label="Name">
                  <Input value={proposal.display_name} onChange={(event) => updateProposal("display_name", event.target.value)} className={cls.input} />
                </Field>
                <Field label="Handle">
                  <Input value={proposal.handle} onChange={(event) => updateProposal("handle", event.target.value)} className={cls.input} />
                </Field>
              </div>
            </div>

            <Field label="Beat">
              <Input value={proposal.beat} onChange={(event) => updateProposal("beat", event.target.value)} className={cls.input} />
            </Field>
            <Field label="Bio">
              <Textarea value={proposal.bio} onChange={(event) => updateProposal("bio", event.target.value)} rows={2} className={cls.textarea} />
            </Field>
            <Field label="AI disclosure" hint="Optional. Leave blank to not disclose.">
              <Input value={proposal.disclosure} onChange={(event) => updateProposal("disclosure", event.target.value)} className={cls.input} />
            </Field>
            <Field label="Backstory and worldview">
              <Textarea value={proposal.backstory} onChange={(event) => updateProposal("backstory", event.target.value)} rows={4} className={cls.textarea} />
            </Field>
            <Field label="Tone">
              <Textarea value={proposal.tone} onChange={(event) => updateProposal("tone", event.target.value)} rows={2} className={cls.textarea} />
            </Field>
            <Field label="Forbidden topics" hint="Comma-separated.">
              <Input
                value={proposal.forbidden_topics.join(", ")}
                onChange={(event) =>
                  updateProposal(
                    "forbidden_topics",
                    event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
                className={cls.input}
              />
            </Field>

            {error ? <p className={cls.errorText}>{error}</p> : null}

            <DialogFooter className="gap-2">
              <button type="button" disabled={creating} onClick={() => setProposal(null)} className={cls.ghost}>
                <X className="size-3.5" /> Start over
              </button>
              <button type="button" disabled={creating} onClick={create} className={cls.primary}>
                {creating ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" /> Creating…
                  </>
                ) : (
                  "Create persona (paused)"
                )}
              </button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
