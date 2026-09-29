"use client";

/* Hallmark · component: frequency control · genre: modern-minimal · theme: app tokens
 * pre-emit critique: P4 H4 E4 S5 R5 V4 */
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { postingFrequency, type PostingFrequency } from "@/lib/influencer/posting-frequency";
import { authHeaders, cls, type Channel } from "./shared";

const DAYS = [{ id: 1, label: "Mon" }, { id: 2, label: "Tue" }, { id: 3, label: "Wed" }, { id: 4, label: "Thu" }, { id: 5, label: "Fri" }, { id: 6, label: "Sat" }, { id: 0, label: "Sun" }];
const control = "min-h-11 rounded-md border border-border px-3 text-sm whitespace-nowrap hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:bg-accent disabled:opacity-50 disabled:cursor-not-allowed";

export function PostingFrequencyControl({ channel, token, onChanged, onFrequencyChange }: { channel: Channel; token: string; onChanged: () => void; onFrequencyChange?: (frequency: PostingFrequency) => void }) {
  const [frequency, setFrequency] = useState<PostingFrequency>(() => postingFrequency(channel));
  const [amount, setAmount] = useState(String(frequency.posts));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    const next = postingFrequency(channel);
    setFrequency(next);
    setAmount(String(next.posts));
  }, [channel]);

  useEffect(() => { onFrequencyChange?.(frequency); }, [frequency, onFrequencyChange]);

  async function save(next: PostingFrequency) {
    setState("saving");
    setError("");
    try {
      const res = await fetch(`/api/influencers/channels/${channel.id}`, { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ posting_frequency: next }) });
        if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || "Could not save frequency. Try again."); }
      onChanged();
      setFrequency(next);
      setAmount(String(next.posts));
      setState("saved");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save frequency. Try again."); setState("error"); }
  }

  return <fieldset className="space-y-3 border-t border-border pt-4" aria-busy={state === "saving"}>
    <legend className="sr-only">Posting frequency</legend>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className={cls.label}>Posting frequency</span>
      <div className="flex gap-1" aria-label="Posting period">
        {(["daily", "weekly"] as const).map((period) => <button key={period} type="button" disabled={state === "saving"} aria-pressed={frequency.period === period} onClick={() => save({ ...frequency, period })} className={cn(control, frequency.period === period ? "bg-secondary text-foreground" : "text-muted-foreground")}>{period === "daily" ? "Daily" : "Weekly"}</button>)}
      </div>
    </div>
    <label className="block">
      <span className={cn(cls.label, "mb-1 block")}>Posts per {frequency.period === "weekly" ? "week" : "day"}</span>
      <Input type="number" min={0} step={1} value={amount} aria-invalid={state === "error"} aria-describedby={`frequency-help-${channel.id}`} className={cn(cls.input, "min-h-11")} onChange={(event) => { setAmount(event.target.value); setState("idle"); }} onBlur={() => {
        const posts = Number(amount);
        if (!amount.trim() || !Number.isSafeInteger(posts) || posts < 0) { setError("Use a whole number of zero or more."); setState("error"); return; }
        if (posts !== frequency.posts) save({ ...frequency, posts });
      }} />
    </label>
    {frequency.period === "weekly" && <div className="space-y-2">
      <span className={cls.label}>Publishing days <span className="normal-case tracking-normal text-muted-foreground">· optional</span></span>
      <div className="flex flex-wrap gap-1">
        {DAYS.map((day) => <button key={day.id} type="button" disabled={state === "saving"} aria-pressed={frequency.days.includes(day.id)} onClick={() => save({ ...frequency, days: frequency.days.includes(day.id) ? frequency.days.filter((id) => id !== day.id) : [...frequency.days, day.id] })} className={cn(control, "min-w-11 px-2", frequency.days.includes(day.id) ? "bg-secondary text-foreground" : "text-muted-foreground")}>{day.label}</button>)}
      </div>
      <p className="text-xs text-neutral-400">{frequency.days.length ? `Up to ${frequency.posts} posts, only on ${DAYS.filter((d) => frequency.days.includes(d.id)).map((d) => d.label).join(" / ")}.` : `Up to ${frequency.posts} posts across any days.`} Week resets Monday · UTC.</p>
    </div>}
    <p id={`frequency-help-${channel.id}`} role="status" className={cn("min-h-5 text-xs", state === "error" ? cls.errorText : "text-neutral-400")}>
      {state === "error" ? error : state === "saving" ? <><Loader2 className="mr-1 inline size-3 animate-spin" />Saving…</> : state === "saved" ? <><Check className="mr-1 inline size-3" />Saved</> : "Zero pauses new posts. Replies keep their daily limit."}
    </p>
  </fieldset>;
}
