"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Play } from "lucide-react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

import { SectionLabel, Segmented, Status, authHeaders, cls, fmtRelative, fmtWhen, type Persona } from "./shared";

type GoalProgress = {
  label: string;
  detail: string;
  current: number | null;
  onTrack: boolean | null;
};

type Cadence = "off" | "daily" | "weekly";

type TickState = {
  cadence: Cadence;
  status: "off" | "waiting" | "due";
  next_action_at: string | null;
  last_note: string | null;
  last_tick_at: string | null;
  last_session_id: string | null;
  goals?: GoalProgress[];
};

/**
 * Plan: the persona's autonomy, what it is behind on, and the channel to talk
 * to it. It paces itself: it wakes on a heartbeat, does one real shift, then
 * decides when to come back. No dated backlog to maintain.
 */
export function PlanTab({ token, persona }: { token: string; persona: Persona }) {
  const [state, setState] = useState<TickState | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/influencers/${persona.id}/tasks`, { headers: authHeaders(token) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load");
      setState(body);
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

  const cadence: Cadence = state?.cadence ?? "off";

  async function setCadenceRemote(next: Cadence) {
    const previous = state;
    setState((s) => (s ? { ...s, cadence: next } : s)); // optimistic
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/tasks`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ action: "set_cadence", cadence: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to update the cadence");
      // The POST answers with the tick state alone; the goals came with the
      // GET and would vanish from the panel until a reload.
      setState((s) => ({ ...body, goals: body.goals ?? s?.goals }));
    } catch (err) {
      setState(previous); // revert so the UI matches the server
      setError(err instanceof Error ? err.message : "Failed to update the cadence");
    }
  }

  async function actNow() {
    setActing(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/tasks`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ action: "act_now" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "The shift failed");
      setState((s) => ({ ...body, goals: body.goals ?? s?.goals }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The shift failed");
    } finally {
      setActing(false);
    }
  }

  const reading = (() => {
    if (!state || cadence === "off") return { tone: "muted" as const, text: "Autonomy is off. It acts only when you run a shift." };
    if (acting) return { tone: "warn" as const, text: "Working a shift right now." };
    if (state.status === "waiting" && state.next_action_at) {
      return {
        tone: "info" as const,
        text: `Next shift ${fmtRelative(state.next_action_at)} (${fmtWhen(state.next_action_at)}), its own choice.`,
      };
    }
    return { tone: "good" as const, text: "Ready. It picks up work on the next 15-minute cycle." };
  })();

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <section className={cn(cls.panel, "space-y-3 p-4")}>
          <SectionLabel hint="It wakes on a heartbeat, does one shift, then decides when to come back.">Autonomy</SectionLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<Cadence>
              value={cadence}
              onChange={setCadenceRemote}
              options={[
                { value: "off", label: "Off" },
                { value: "weekly", label: "Light pace" },
                { value: "daily", label: "Active pace" },
              ]}
            />
            <button type="button" onClick={actNow} disabled={acting} className={cn(cls.outline, "ml-auto")}>
              {acting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Run a shift now
            </button>
          </div>
          {loading ? (
            <Skeleton className="h-5 w-64 bg-white/[0.04]" />
          ) : (
            <Status tone={reading.tone} className="text-sm">
              {reading.text}
            </Status>
          )}
          {error ? <p className={cls.errorText}>{error}</p> : null}
          {!loading && state?.last_note ? (
            <figure className="rounded-md border border-white/[0.06] bg-neutral-950/60 p-3">
              <blockquote className="text-sm leading-relaxed text-neutral-200">{state.last_note}</blockquote>
              <figcaption className="mt-1.5 text-[11px] text-neutral-500">
                Its last note to itself{state.last_tick_at ? ` · ${fmtWhen(state.last_tick_at)}` : ""}
              </figcaption>
            </figure>
          ) : null}
        </section>

        {!loading && state?.goals && state.goals.length > 0 ? (
          <section className={cn(cls.panel, "p-4")}>
            <SectionLabel hint="It sees this each shift and steers toward what it is behind on.">Goals</SectionLabel>
            <ul className="divide-y divide-white/[0.06]">
              {state.goals.map((g, i) => (
                <li key={i} className="grid gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline sm:gap-4">
                  <Status tone={g.onTrack === true ? "good" : g.onTrack === false ? "warn" : "muted"} className="text-sm text-neutral-200">
                    {g.label}
                  </Status>
                  <span className="text-xs tabular-nums text-neutral-500 sm:text-right">
                    {g.onTrack === null ? "ongoing" : g.detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <FeedbackPanel token={token} persona={persona} />
    </div>
  );
}

type FeedbackItem = {
  id: string;
  body: string;
  status: "new" | "applied";
  created_at: string;
};

function FeedbackPanel({ token, persona }: { token: string; persona: Persona }) {
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/influencers/${persona.id}/feedback`, { headers: authHeaders(token) });
      const body = await res.json();
      if (res.ok) {
        setFeedback(body.feedback ?? []);
        setSkills(body.skills ?? []);
      }
    } catch {
      /* best-effort */
    }
  }, [token, persona.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/feedback`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ body: text }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not send");
      setText("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className={cn(cls.panel, "space-y-2 p-4")}>
        <SectionLabel hint="It reads new notes on its next shift and turns lasting lessons into rules it always applies.">Talk to it</SectionLabel>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Your tweets are too long. Keep them under 180 characters."
          rows={2}
          className={cls.textarea}
        />
        <div className="flex items-center gap-2">
          <button type="button" onClick={send} disabled={sending || !text.trim()} className={cls.primary}>
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : "Send"}
          </button>
          {error ? <p className={cls.errorText}>{error}</p> : null}
        </div>
        {feedback.length > 0 ? (
          <ul className="divide-y divide-white/[0.06] pt-1">
            {feedback.slice(0, 6).map((f) => (
              <li key={f.id} className="flex items-start gap-2 py-2 text-sm">
                <Status tone={f.status === "applied" ? "good" : "info"} className="mt-0.5 shrink-0">
                  {f.status}
                </Status>
                <span className={cn("text-neutral-300", f.status === "applied" && "text-neutral-500")}>{f.body}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {skills.length > 0 ? (
        <section className={cn(cls.panel, "p-4")}>
          <SectionLabel hint="Rules it learned and applies on every shift.">Skills</SectionLabel>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-neutral-300 marker:text-neutral-600">
            {skills.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
