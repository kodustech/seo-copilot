"use client";

/* Hallmark · component: inline list editor (goals, skills) · genre: modern-minimal
 * theme: project tokens (dark neutral panels, violet accent) — no catalog theme
 * states: default · hover · focus · disabled · loading · error · success
 *   (press state is inherited from the shared cls.* button classes, which do not
 *   define one; overriding it here would make these buttons the only ones in the
 *   app that move on click)
 * motion: one primitive, 150ms opacity on row controls. Nothing else animates.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, FlaskConical, Loader2, Pencil, Play, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { SectionLabel, Segmented, Status, authHeaders, cls, fmtRelative, fmtWhen, type Persona } from "./shared";

type GoalType = "posts_per_week" | "followers" | "custom";

/** computeProgress spreads the stored goal into the row, so editing needs no
 *  second fetch: everything the editor writes back is already here. */
type GoalProgress = {
  type?: GoalType;
  channel?: string;
  handle?: string;
  target?: number;
  label: string;
  detail: string;
  current: number | null;
  onTrack: boolean | null;
};

/** What gets written back. Drop the computed fields; the server recomputes. */
type GoalDraft = {
  type: GoalType;
  label: string;
  channel?: string;
  handle?: string;
  target?: number;
};

const CHANNEL_OPTIONS = ["blog", "devto", "x", "medium", "reddit", "hackernews", "hackernoon", "youtube"];

/**
 * The stored goal, with only the computed fields removed.
 *
 * Saving posts the whole list, so an untouched row has to come back unchanged.
 * Rebuilding one from what the row renders is how an edit to goal 3 quietly
 * rewrites goal 1. This half sends the row as it was stored; the other half is
 * normalizeGoals, which infers a missing type rather than defaulting it and
 * carries channel and handle through whatever the type is. Both halves are
 * needed: sending the row intact does nothing if the server rebuilds it.
 */
function stored(g: GoalProgress): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(g)) {
    if (k === "current" || k === "onTrack" || k === "detail") continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The stored goal opened in the editor. Here a type is required, because the
 *  editor has to show one; that inference applies to the edited row only. */
function toDraft(g: GoalProgress): GoalDraft {
  return {
    type: g.type ?? "custom",
    label: g.label,
    channel: g.channel,
    handle: g.handle,
    target: g.target,
  };
}

function blankDraft(): GoalDraft {
  return { type: "custom", label: "" };
}

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
  const [testing, setTesting] = useState(false);
  const [testingPlatform, setTestingPlatform] = useState<"article" | "youtube" | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testFailed, setTestFailed] = useState(false);
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

  const hasYoutube = persona.channels.some((c) => c.platform === "youtube" && c.status !== "paused");
  const hasArticle = persona.channels.some(
    (c) => (c.platform === "blog" || c.platform === "devto") && c.status === "active",
  );

  async function runTest(platform: "article" | "youtube") {
    setTesting(true);
    setTestingPlatform(platform);
    setTestResult(null);
    setTestFailed(false);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/tasks`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ action: "test_shift", ...(platform ? { platform } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "The test shift failed");
      setState((s) => ({ ...body, goals: body.goals ?? s?.goals }));
      setTestFailed(body.result?.failed === true);
      setTestResult(
        body.result?.note ||
          (platform === "youtube"
            ? "Test video added to the Review queue. Slide previews show up there once the worker renders them. It cannot be rendered or published."
            : "Test article added to the Review queue. It cannot be published or scheduled."),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "The test shift failed");
    } finally {
      setTesting(false);
      setTestingPlatform(null);
    }
  }

  const reading = (() => {
    if (testing) return { tone: "warn" as const, text: "Generating a test draft for review." };
    if (acting) return { tone: "warn" as const, text: "Working a shift right now." };
    if (!state || cadence === "off") return { tone: "muted" as const, text: "Autonomy is off. It acts only when you run a shift." };
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
            <div className="ml-auto flex items-center gap-2">
              {hasArticle ? (
                <button type="button" onClick={() => runTest("article")} disabled={acting || testing} className={cls.outline}>
                  {testingPlatform === "article" ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                  Run test
                </button>
              ) : null}
              {hasYoutube ? (
                <button type="button" onClick={() => runTest("youtube")} disabled={acting || testing} className={cls.outline}>
                  {testingPlatform === "youtube" ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                  Test video
                </button>
              ) : null}
              <button type="button" onClick={actNow} disabled={acting || testing} className={cls.outline}>
                {acting ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                Run a shift now
              </button>
            </div>
          </div>
          {loading ? (
            <Skeleton className="h-5 w-64 bg-white/[0.04]" />
          ) : (
            <Status tone={reading.tone} className="text-sm">
              {reading.text}
            </Status>
          )}
          {error ? <p className={cls.errorText}>{error}</p> : null}
          {testResult ? <Status tone={testFailed ? "warn" : "good"}>{testResult}</Status> : null}
          {!loading && state?.last_note ? (
            <figure className="rounded-md border border-white/[0.06] bg-neutral-950/60 p-3">
              <blockquote className="text-sm leading-relaxed text-neutral-200">{state.last_note}</blockquote>
              <figcaption className="mt-1.5 text-[11px] text-neutral-500">
                Its last note to itself{state.last_tick_at ? ` · ${fmtWhen(state.last_tick_at)}` : ""}
              </figcaption>
            </figure>
          ) : null}
        </section>

        {/* Only when the load succeeded. With state null the list would render
            empty while real goals exist, and saving would post that empty list
            back over them. The error above is the recovery path. */}
        {!loading && state ? (
          <GoalsPanel
            token={token}
            persona={persona}
            goals={state.goals ?? []}
            // The route answers with the whole tick state, so a save also
            // refreshes cadence and next-shift time rather than just the list.
            onSaved={(next) => setState((st) => ({ ...(st as TickState), ...next }))}
          />
        ) : null}
      </div>

      <FeedbackPanel token={token} persona={persona} />
    </div>
  );
}

/**
 * Goals, editable in place.
 *
 * The panel stays a list. Editing happens on the row itself, adding is one
 * quiet row at the end, and nothing opens a dialog: a goal is four short fields
 * and a modal for four fields is heavier than the thing it edits. The row
 * controls reserve their space instead of appearing on hover, so the list does
 * not reflow under the cursor, and they surface on keyboard focus as well as
 * hover, which is the half every hover-reveal forgets.
 */
function GoalsPanel({
  token,
  persona,
  goals,
  onSaved,
}: {
  token: string;
  persona: Persona;
  goals: GoalProgress[];
  onSaved: (state: Partial<TickState>) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function persist(next: Record<string, unknown>[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/tasks`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ action: "set_goals", goals: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not save");
      // Silent success: the row simply returns to its read state with the new
      // value in it. A toast for a save you can already see is noise.
      onSaved(body as Partial<TickState>);
      setEditing(null);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  function commit() {
    if (!draft?.label.trim()) return;
    // Untouched rows go back as stored. Only the edited index carries the draft.
    const next: Record<string, unknown>[] = goals.map(stored);
    if (editing === -1) next.push(draft);
    else if (editing != null) next[editing] = draft;
    void persist(next);
  }

  function remove(index: number) {
    void persist(goals.map(stored).filter((_, i) => i !== index));
  }

  const adding = editing === -1;

  return (
    <section className={cn(cls.panel, "p-4")}>
      <SectionLabel hint="It sees this each shift and steers toward what it is behind on.">Goals</SectionLabel>

      {goals.length === 0 && !adding ? (
        <p className="py-2 text-sm text-neutral-500">
          No goals yet. Without one it writes to its own taste and nothing tells it what it is behind on.
        </p>
      ) : null}

      <ul className="divide-y divide-white/[0.06]">
        {goals.map((g, i) =>
          editing === i && draft ? (
            <li key={i} className="py-3">
              <GoalEditor
                draft={draft}
                onChange={setDraft}
                onCommit={commit}
                onCancel={() => {
                  setEditing(null);
                  setDraft(null);
                  setError(null);
                }}
                saving={saving}
              />
            </li>
          ) : (
            <li
              key={i}
              className="group grid items-baseline gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-3"
            >
              <Status
                tone={g.onTrack === true ? "good" : g.onTrack === false ? "warn" : "muted"}
                className="text-sm text-neutral-200"
              >
                {g.label}
              </Status>
              <span className="text-xs tabular-nums text-neutral-500 sm:text-right">
                {g.onTrack === null ? "ongoing" : g.detail}
              </span>
              <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  aria-label={`Edit goal: ${g.label}`}
                  disabled={saving}
                  onClick={() => {
                    setEditing(i);
                    setDraft(toDraft(g));
                    setError(null);
                  }}
                  className={cn(cls.ghost, "size-7 px-0 justify-center")}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove goal: ${g.label}`}
                  disabled={saving}
                  onClick={() => remove(i)}
                  className={cn(cls.ghost, "size-7 px-0 justify-center hover:text-red-300")}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            </li>
          ),
        )}

        {adding && draft ? (
          <li className="py-3">
            <GoalEditor
              draft={draft}
              onChange={setDraft}
              onCommit={commit}
              onCancel={() => {
                setEditing(null);
                setDraft(null);
                setError(null);
              }}
              saving={saving}
            />
          </li>
        ) : null}
      </ul>

      {!adding ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setEditing(-1);
            setDraft(blankDraft());
            setError(null);
          }}
          className={cn(cls.ghost, "mt-1 w-full justify-start")}
        >
          <Plus className="size-3.5" />
          Add a goal
        </button>
      ) : null}

      {error ? <p className={cn(cls.errorText, "mt-2")}>{error}</p> : null}
    </section>
  );
}

/** One goal, open for editing. Only the fields the chosen type actually uses
 *  are shown: a followers goal has no channel, and a custom one has neither. */
function GoalEditor({
  draft,
  onChange,
  onCommit,
  onCancel,
  saving,
}: {
  draft: GoalDraft;
  onChange: (d: GoalDraft) => void;
  onCommit: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const needsChannel = draft.type === "posts_per_week";
  const needsHandle = draft.type === "followers";
  const measurable = needsChannel || needsHandle;
  const incomplete =
    !draft.label.trim() ||
    (needsChannel && (!draft.channel || !draft.target)) ||
    (needsHandle && (!draft.handle?.trim() || !draft.target));

  return (
    <div className="space-y-2">
      <Input
        autoFocus
        value={draft.label}
        onChange={(e) => onChange({ ...draft, label: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !incomplete) onCommit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="What it should be working toward"
        className={cn(cls.input, "w-full")}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<GoalType>
          value={draft.type}
          onChange={(type) =>
            onChange({
              type,
              label: draft.label,
              target: type === "custom" ? undefined : (draft.target ?? 2),
            })
          }
          options={[
            { value: "posts_per_week", label: "Posts/week" },
            { value: "followers", label: "Followers" },
            { value: "custom", label: "Open-ended" },
          ]}
        />

        {needsChannel ? (
          <select
            value={draft.channel ?? ""}
            onChange={(e) => onChange({ ...draft, channel: e.target.value })}
            aria-label="Channel"
            className={cn(cls.select, "rounded-md border px-2")}
          >
            <option value="">channel…</option>
            {CHANNEL_OPTIONS.map((c) => (
              <option key={c} value={c} className="bg-neutral-900">
                {c}
              </option>
            ))}
          </select>
        ) : null}

        {needsHandle ? (
          <Input
            value={draft.handle ?? ""}
            onChange={(e) => onChange({ ...draft, handle: e.target.value })}
            placeholder="x handle"
            aria-label="X handle"
            className={cn(cls.input, "w-28")}
          />
        ) : null}

        {measurable ? (
          <Input
            type="number"
            min={1}
            value={draft.target ?? ""}
            onChange={(e) => onChange({ ...draft, target: Number(e.target.value) || undefined })}
            placeholder="target"
            aria-label="Target"
            className={cn(cls.input, "w-20")}
          />
        ) : null}

        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={onCancel} disabled={saving} className={cls.ghost}>
            Cancel
          </button>
          <button type="button" onClick={onCommit} disabled={saving || incomplete} className={cls.primary}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Save
          </button>
        </span>
      </div>

      {!measurable ? (
        <p className="text-[11px] text-neutral-600">
          Open-ended goals have no number to hit. It reads them as direction and they always show as ongoing.
        </p>
      ) : null}
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
  const [skills, setSkills] = useState<Skill[]>([]);
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
    <>
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

      <div className="lg:col-span-2">
        <SkillsPanel token={token} persona={persona} skills={skills} onChange={setSkills} />
      </div>
    </>
  );
}

type Skill = { id: string; content: string; source: "operator" | "agent" | "legacy" };
type SkillFilter = "all" | Skill["source"];
const MAX_SKILL_LENGTH = 1000;

/* Hallmark · component: skills panel · genre: modern-minimal · theme: existing dark tokens */
/**
 * Skills: the rules the persona applies on every shift.
 *
 * Normally it writes these itself, distilled from feedback, and that stays the
 * better path because a rule it derived is a rule it understands. Writing one
 * by hand is for the two cases the learned path cannot cover: a persona with no
 * shifts yet, and a rule that is not up for negotiation. The hint says so, so
 * nobody reaches for the box when the feedback box above would do.
 */
function SkillsPanel({
  token,
  persona,
  skills,
  onChange,
}: {
  token: string;
  persona: Persona;
  skills: Skill[];
  onChange: (skills: Skill[]) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: string; content: string; source: Skill["source"] } | null>(null);
  const pageSize = 30;
  const visibleSkills = filter === "all" ? skills : skills.filter((skill) => skill.source === filter);
  const pageCount = Math.max(1, Math.ceil(visibleSkills.length / pageSize));
  const pageSkills = visibleSkills.slice(page * pageSize, (page + 1) * pageSize);
  const rangeStart = visibleSkills.length ? page * pageSize + 1 : 0;
  const rangeEnd = Math.min((page + 1) * pageSize, visibleSkills.length);

  async function add() {
    const skill = text.trim();
    if (skill.length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/feedback`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ action: "add_skill", skill }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not save");
      onChange(body.skills ?? []);
      setText("");
      setAdding(false);
      setFilter("all");
      setPage(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function drop(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/influencers/${persona.id}/feedback?skill_id=${encodeURIComponent(id)}`,
        { method: "DELETE", headers: authHeaders(token) },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not remove");
      const next: Skill[] = body.skills ?? [];
      onChange(next);
      const nextVisible = filter === "all" ? next : next.filter((skill) => skill.source === filter);
      setPage((current) => Math.min(current, Math.max(0, Math.ceil(nextVisible.length / pageSize) - 1)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing || editing.content.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/influencers/${persona.id}/feedback`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          skill_id: editing.id,
          skill: editing.content,
          source: editing.source,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not update");
      const next: Skill[] = body.skills ?? [];
      onChange(next);
      const nextVisible = filter === "all" ? next : next.filter((skill) => skill.source === filter);
      setPage((current) => Math.min(current, Math.max(0, Math.ceil(nextVisible.length / pageSize) - 1)));
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={cn(cls.panel, "p-4")}>
      <SectionLabel hint="Rules it applies on every shift. It writes most of these itself, from your feedback.">
        <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="flex items-center gap-2">
            <span>Skills</span>
            <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">{skills.length}</span>
          </span>
          <span className="text-[11px] font-normal normal-case tracking-normal text-neutral-600">
            {visibleSkills.length ? `${rangeStart}–${rangeEnd} of ${visibleSkills.length}` : "No rules"}
          </span>
        </span>
      </SectionLabel>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
        <div aria-label="Filter skills" className="flex flex-wrap items-center gap-1 rounded-md bg-white/[0.025] p-1">
          {(["all", "operator", "agent", "legacy"] as SkillFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setPage(0);
              }}
              className={cn(
                "min-h-8 rounded px-2.5 py-1 text-[11px] capitalize transition-colors",
                filter === value ? "bg-white/[0.1] text-neutral-100 shadow-sm" : "text-neutral-500 hover:text-neutral-300",
              )}
            >
              {value}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setAdding((open) => !open)} className={cn(cls.outline, "shrink-0")}>
          <Plus className="size-3.5" />
          Add rule
        </button>
      </div>

      {adding ? (
        <div className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-neutral-300">Operator rule</span>
            <span className="text-[11px] text-neutral-600">Cmd/Ctrl + Enter to save</span>
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              autoFocus
              value={text}
              maxLength={MAX_SKILL_LENGTH}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add();
              }}
              placeholder="Write a rule this influencer should always follow..."
              aria-label="Operator rule"
              rows={2}
              className={cn(cls.textarea, "min-h-0 flex-1 py-2 text-xs")}
            />
            <button type="button" onClick={add} disabled={busy || text.trim().length < 3} className={cn(cls.outline, "shrink-0")}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Save
            </button>
          </div>
        </div>
      ) : null}

      {skills.length === 0 ? (
        <p className="pb-2 text-sm text-neutral-500">
          None yet. It writes its own once it has shifts to learn from; add one here if it needs a rule before then.
        </p>
      ) : (
        <ol start={rangeStart} className="mt-3 list-decimal space-y-0 pl-5 text-sm leading-relaxed text-neutral-300 marker:text-neutral-600">
          {pageSkills.map((s) => (
            <li key={s.id} className="group border-b border-white/[0.045] py-2.5 first:pt-0 last:border-b-0">
              {editing?.id === s.id ? (
                <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-neutral-300">Edit rule</span>
                    <Select
                      value={editing.source}
                      onValueChange={(source: Skill["source"]) => setEditing((current) => current ? { ...current, source } : current)}
                    >
                      <SelectTrigger className={cn(cls.select, "h-8 w-28 text-[11px]", editing.source === "operator" ? "text-violet-300" : editing.source === "agent" ? "text-sky-300" : "text-neutral-400")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={cls.menu}>
                        <SelectItem value="operator">Operator</SelectItem>
                        <SelectItem value="agent">Agent</SelectItem>
                        <SelectItem value="legacy">Legacy</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Textarea
                    autoFocus
                    value={editing.content}
                    maxLength={MAX_SKILL_LENGTH}
                    onChange={(e) => setEditing((current) => current ? { ...current, content: e.target.value } : current)}
                    rows={3}
                    className={cn(cls.textarea, "mt-2 min-h-0 py-2 text-xs")}
                    aria-label="Edit skill rule"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => setEditing(null)} disabled={busy} className={cls.ghost}>Cancel</button>
                    <button type="button" onClick={() => void saveEdit()} disabled={busy || editing.content.trim().length < 3} className={cls.primary}>
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <span className="flex items-start gap-3">
                  <span className="min-w-0 max-w-5xl flex-1">{s.content}</span>
                  <span className={cn(
                    "shrink-0 rounded border px-1.5 py-0.5 text-[10px] capitalize",
                    s.source === "operator"
                      ? "border-violet-400/20 text-violet-300"
                      : s.source === "agent"
                        ? "border-sky-400/20 text-sky-300"
                        : "border-white/[0.08] text-neutral-500",
                  )}>
                    {s.source}
                  </span>
                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                    <button type="button" aria-label="Edit this rule" disabled={busy} onClick={() => setEditing({ id: s.id, content: s.content, source: s.source })} className={cn(cls.ghost, "size-7 justify-center px-0")}>
                      <Pencil className="size-3.5" />
                    </button>
                    <button type="button" aria-label="Remove this rule" disabled={busy} onClick={() => drop(s.id)} className={cn(cls.ghost, "size-7 justify-center px-0 hover:text-red-300")}>
                      <X className="size-3.5" />
                    </button>
                  </div>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {pageCount > 1 ? (
        <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-500">
          <span>Page {page + 1} of {pageCount}</span>
          <div className="flex gap-1">
            <button type="button" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0} className={cls.ghost}>
              Previous
            </button>
            <button type="button" onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={page >= pageCount - 1} className={cls.ghost}>
              Next
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className={cn(cls.errorText, "mt-2")}>{error}</p> : null}
    </section>
  );
}
