import type { SupabaseClient } from "@supabase/supabase-js";

import { renderTemplate } from "@/lib/outreach/renderer";
import type {
  EmailThreadMode,
  EnrollmentSource,
  LinkedinAction,
  OutreachEnrollment,
  OutreachSendTask,
  OutreachSequence,
  OutreachSequenceStep,
  SequenceStatus,
  StepChannel,
  StepMode,
  TaskStatus,
} from "@/lib/outreach/sequence-types";
import {
  getSendingWindow,
  isSendingDay,
  nextSendingSlot,
  nextSendingSlotAfter,
} from "@/lib/outreach/sending-window";
import { listPeople, listRows } from "@/lib/research/tables";
import { resolveTable } from "@/lib/research/columns";
import { getProspect, updateProspect } from "@/lib/outreach";

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapSequence(r: Record<string, unknown>): OutreachSequence {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    status: r.status as SequenceStatus,
    defaultFromEmail: (r.default_from_email as string | null) ?? null,
    mailboxId: (r.mailbox_id as string | null) ?? null,
    createdByEmail: (r.created_by_email as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapStep(r: Record<string, unknown>): OutreachSequenceStep {
  const channel = r.channel as StepChannel;
  const rawThread = r.email_thread_mode as string | null | undefined;
  let emailThreadMode: EmailThreadMode | null = null;
  if (channel === "email") {
    emailThreadMode = rawThread === "new" ? "new" : "reply";
  }
  return {
    id: r.id as string,
    sequenceId: r.sequence_id as string,
    position: Number(r.position),
    channel,
    mode: r.mode as StepMode,
    delayHours: Number(r.delay_hours ?? 0),
    linkedinAction: (r.linkedin_action as LinkedinAction | null) ?? null,
    subjectTemplate: (r.subject_template as string | null) ?? null,
    bodyTemplate: (r.body_template as string) ?? "",
    stopOnReply: Boolean(r.stop_on_reply ?? true),
    emailThreadMode,
    createdAt: r.created_at as string,
  };
}

function mapEnrollment(r: Record<string, unknown>): OutreachEnrollment {
  return {
    id: r.id as string,
    sequenceId: r.sequence_id as string,
    source: r.source as EnrollmentSource,
    outreachProspectId: (r.outreach_prospect_id as string | null) ?? null,
    researchRowId: (r.research_row_id as string | null) ?? null,
    researchPersonId: (r.research_person_id as string | null) ?? null,
    crmCompanyId: (r.crm_company_id as string | null) ?? null,
    templateVars: (r.template_vars as Record<string, string> | null) ?? null,
    companyName: r.company_name as string,
    domain: (r.domain as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    contactLinkedin: (r.contact_linkedin as string | null) ?? null,
    contactRole: (r.contact_role as string | null) ?? null,
    status: r.status as OutreachEnrollment["status"],
    currentStepPosition: Number(r.current_step_position ?? 0),
    nextRunAt: (r.next_run_at as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    enrolledByEmail: (r.enrolled_by_email as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function getEnrollment(
  client: SupabaseClient,
  enrollmentId: string,
): Promise<OutreachEnrollment | null> {
  const { data, error } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapEnrollment(data as Record<string, unknown>) : null;
}

function mapTask(r: Record<string, unknown>): OutreachSendTask {
  return {
    id: r.id as string,
    enrollmentId: r.enrollment_id as string,
    stepId: r.step_id as string,
    channel: r.channel as StepChannel,
    mode: r.mode as StepMode,
    status: r.status as OutreachSendTask["status"],
    scheduledFor: r.scheduled_for as string,
    renderedSubject: (r.rendered_subject as string | null) ?? null,
    renderedBody: (r.rendered_body as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    providerMessageId: (r.provider_message_id as string | null) ?? null,
    sentAt: (r.sent_at as string | null) ?? null,
    sentByEmail: (r.sent_by_email as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    meta: (r.meta as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ---------------------------------------------------------------------------
// Sequences CRUD
// ---------------------------------------------------------------------------

export async function listSequences(
  client: SupabaseClient,
): Promise<OutreachSequence[]> {
  const { data, error } = await client
    .from("outreach_sequences")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  const sequences = (data ?? []).map((r) =>
    mapSequence(r as Record<string, unknown>),
  );

  // counts
  for (const s of sequences) {
    const { count: steps } = await client
      .from("outreach_sequence_steps")
      .select("id", { count: "exact", head: true })
      .eq("sequence_id", s.id);
    const { count: enrollments } = await client
      .from("outreach_enrollments")
      .select("id", { count: "exact", head: true })
      .eq("sequence_id", s.id)
      .eq("status", "active");
    s.stepCount = steps ?? 0;
    s.enrollmentCount = enrollments ?? 0;
  }
  return sequences;
}

export async function getSequence(
  client: SupabaseClient,
  id: string,
): Promise<{ sequence: OutreachSequence; steps: OutreachSequenceStep[] } | null> {
  const { data, error } = await client
    .from("outreach_sequences")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const steps = await listSteps(client, id);
  return { sequence: mapSequence(data as Record<string, unknown>), steps };
}

/** Store a complete campaign version independently of cascade-deleted tables. */
export async function snapshotSequence(
  client: SupabaseClient,
  sequenceId: string,
  opts: { reason?: string; createdBy?: string | null } = {},
): Promise<string> {
  const { data: sequence, error: sequenceError } = await client
    .from("outreach_sequences")
    .select("*")
    .eq("id", sequenceId)
    .maybeSingle();
  if (sequenceError) throw new Error(sequenceError.message);
  if (!sequence) throw new Error("Sequence not found");

  const [stepsResult, enrollmentsResult] = await Promise.all([
    client
      .from("outreach_sequence_steps")
      .select("*")
      .eq("sequence_id", sequenceId)
      .order("position", { ascending: true }),
    client.from("outreach_enrollments").select("*").eq("sequence_id", sequenceId),
  ]);
  if (stepsResult.error) throw new Error(stepsResult.error.message);
  if (enrollmentsResult.error) throw new Error(enrollmentsResult.error.message);
  const enrollmentIds = (enrollmentsResult.data ?? []).map((row) => row.id as string);
  const tasksResult = enrollmentIds.length
    ? await client.from("outreach_send_tasks").select("*").in("enrollment_id", enrollmentIds)
    : { data: [], error: null };
  if (tasksResult.error) throw new Error(tasksResult.error.message);

  const { data, error } = await client
    .from("outreach_sequence_snapshots")
    .insert({
      sequence_id: sequenceId,
      reason: opts.reason ?? "save",
      sequence_data: sequence,
      steps_data: stepsResult.data ?? [],
      enrollments_data: enrollmentsResult.data ?? [],
      tasks_data: tasksResult.data ?? [],
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to snapshot sequence: ${error.message}`);
  return data.id as string;
}

export async function listSequenceSnapshots(
  client: SupabaseClient,
  sequenceId: string,
  limit = 20,
): Promise<Array<{
  id: string;
  reason: string;
  stepCount: number;
  enrollmentCount: number;
  taskCount: number;
  createdAt: string;
}>> {
  const { data, error } = await client
    .from("outreach_sequence_snapshots")
    .select("id, reason, steps_data, enrollments_data, tasks_data, created_at")
    .eq("sequence_id", sequenceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((snapshot) => ({
    id: snapshot.id as string,
    reason: snapshot.reason as string,
    stepCount: Array.isArray(snapshot.steps_data) ? snapshot.steps_data.length : 0,
    enrollmentCount: Array.isArray(snapshot.enrollments_data)
      ? snapshot.enrollments_data.length
      : 0,
    taskCount: Array.isArray(snapshot.tasks_data) ? snapshot.tasks_data.length : 0,
    createdAt: snapshot.created_at as string,
  }));
}

/**
 * Exact recovery for a campaign, including the people and its queued/sent work.
 * The current version is snapshotted first so restore itself is undoable.
 */
export async function restoreSequenceSnapshot(
  client: SupabaseClient,
  snapshotId: string,
  opts: { createdBy?: string | null } = {},
): Promise<{ sequence: OutreachSequence; steps: OutreachSequenceStep[] }> {
  const { data: snapshot, error } = await client
    .from("outreach_sequence_snapshots")
    .select("*")
    .eq("id", snapshotId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!snapshot) throw new Error("Sequence snapshot not found");

  const sequence = snapshot.sequence_data as Record<string, unknown>;
  const sequenceId = sequence.id as string;
  const current = await getSequence(client, sequenceId);
  if (current) {
    await snapshotSequence(client, sequenceId, {
      reason: `before_restore:${snapshotId}`,
      createdBy: opts.createdBy,
    });
    // Cascade is intentional: we restore the snapshot's queue exactly below.
    const { error: deleteError } = await client
      .from("outreach_sequences")
      .delete()
      .eq("id", sequenceId);
    if (deleteError) throw new Error(deleteError.message);
  }

  const { error: sequenceInsertError } = await client
    .from("outreach_sequences")
    .insert(sequence);
  if (sequenceInsertError) throw new Error(sequenceInsertError.message);
  const steps = (snapshot.steps_data as Array<Record<string, unknown>>) ?? [];
  if (steps.length > 0) {
    const { error: stepsInsertError } = await client
      .from("outreach_sequence_steps")
      .insert(steps);
    if (stepsInsertError) throw new Error(stepsInsertError.message);
  }
  const enrollments = (snapshot.enrollments_data as Array<Record<string, unknown>>) ?? [];
  if (enrollments.length > 0) {
    const { error: enrollmentsInsertError } = await client
      .from("outreach_enrollments")
      .insert(enrollments);
    if (enrollmentsInsertError) throw new Error(enrollmentsInsertError.message);
  }
  const tasks = (snapshot.tasks_data as Array<Record<string, unknown>>) ?? [];
  if (tasks.length > 0) {
    const { error: tasksInsertError } = await client
      .from("outreach_send_tasks")
      .insert(tasks);
    if (tasksInsertError) throw new Error(tasksInsertError.message);
  }
  return (await getSequence(client, sequenceId))!;
}

export async function createSequence(
  client: SupabaseClient,
  input: {
    name: string;
    description?: string | null;
    createdByEmail?: string | null;
    defaultFromEmail?: string | null;
    mailboxId?: string | null;
    steps?: Array<{
      channel: StepChannel;
      mode: StepMode;
      delayHours?: number;
      linkedinAction?: LinkedinAction | null;
      subjectTemplate?: string | null;
      bodyTemplate: string;
    }>;
  },
): Promise<{ sequence: OutreachSequence; steps: OutreachSequenceStep[] }> {
  const name = input.name.trim();
  if (!name) throw new Error("name is required");

  const { data, error } = await client
    .from("outreach_sequences")
    .insert({
      name,
      description: input.description ?? null,
      status: "draft",
      default_from_email: input.defaultFromEmail ?? null,
      mailbox_id: input.mailboxId ?? null,
      created_by_email: input.createdByEmail ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const sequence = mapSequence(data as Record<string, unknown>);

  const stepDefs =
    input.steps && input.steps.length > 0
      ? input.steps
      : defaultSteps();

  const steps = await replaceSteps(client, sequence.id, stepDefs);
  return { sequence, steps };
}

function defaultSteps(): Array<{
  channel: StepChannel;
  mode: StepMode;
  delayHours: number;
  linkedinAction?: LinkedinAction | null;
  subjectTemplate?: string | null;
  bodyTemplate: string;
}> {
  return [
    {
      channel: "linkedin",
      mode: "semi",
      delayHours: 0,
      linkedinAction: "connect_note",
      bodyTemplate:
        "Hey {{first_name}} — saw {{company}} is hiring for QA. We help product teams ship quality with less flaky E2E pain. Open to a quick chat?",
    },
    {
      channel: "email",
      mode: "auto",
      delayHours: 24,
      subjectTemplate: "QA at {{company}}",
      bodyTemplate: `Hi {{first_name}},

Noticed {{company}} is investing in quality/engineering. We work with product teams on E2E reliability and QA automation that doesn't slow releases.

Worth a 15-min chat?

— Kodus`,
    },
    {
      channel: "linkedin",
      mode: "semi",
      delayHours: 72,
      linkedinAction: "message",
      bodyTemplate:
        "Following up {{first_name}} — happy to share how similar teams cut flaky suite time. Free this week?",
    },
  ];
}

export async function listSteps(
  client: SupabaseClient,
  sequenceId: string,
): Promise<OutreachSequenceStep[]> {
  const { data, error } = await client
    .from("outreach_sequence_steps")
    .select("*")
    .eq("sequence_id", sequenceId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapStep(r as Record<string, unknown>));
}

export async function replaceSteps(
  client: SupabaseClient,
  sequenceId: string,
  steps: Array<{
    channel: StepChannel;
    mode: StepMode;
    delayHours?: number;
    linkedinAction?: LinkedinAction | null;
    subjectTemplate?: string | null;
    bodyTemplate: string;
    stopOnReply?: boolean;
    emailThreadMode?: EmailThreadMode | null;
  }>,
): Promise<OutreachSequenceStep[]> {
  await snapshotSequence(client, sequenceId, { reason: "replace_steps" });
  // LinkedIn auto not supported in v1 — force semi
  let hasPreviousEmail = false;
  const normalized = steps.map((s, i) => {
    const mode: StepMode =
      s.channel === "linkedin" ? "semi" : s.mode === "semi" ? "semi" : "auto";
    if (s.channel === "linkedin" && !s.linkedinAction) {
      throw new Error(`Step ${i + 1}: linkedin_action required`);
    }
    if (s.channel === "email" && mode === "auto" && !s.bodyTemplate.trim()) {
      throw new Error(`Step ${i + 1}: body_template required`);
    }
    const isFirstEmail = s.channel === "email" && !hasPreviousEmail;
    if (s.channel === "email") hasPreviousEmail = true;
    const emailThreadMode =
      s.channel === "email"
        ? isFirstEmail || s.emailThreadMode === "new"
          ? "new"
          : "reply"
        : null;
    return {
      sequence_id: sequenceId,
      position: i,
      channel: s.channel,
      mode,
      delay_hours: s.delayHours ?? 0,
      linkedin_action: s.channel === "linkedin" ? s.linkedinAction ?? "message" : null,
      subject_template: s.subjectTemplate ?? null,
      body_template: s.bodyTemplate,
      stop_on_reply: s.stopOnReply !== false,
      email_thread_mode: emailThreadMode,
    };
  });

  // FK on outreach_send_tasks.step_id is ON DELETE CASCADE — deleting steps
  // wipes every task while enrollments stay behind. Reseed after rewrite.
  await client.from("outreach_sequence_steps").delete().eq("sequence_id", sequenceId);
  if (normalized.length === 0) return [];

  const { data, error } = await client
    .from("outreach_sequence_steps")
    .insert(normalized)
    .select("*");
  if (error) throw new Error(error.message);
  const savedSteps = (data ?? []).map((r) =>
    mapStep(r as Record<string, unknown>),
  );
  await reseedMissingTasksForSequence(client, sequenceId);
  return savedSteps;
}

/**
 * Active enrollments with no open send task get a fresh task for their current
 * step. Covers the case where steps were rewritten (CASCADE wiped tasks) or
 * enroll created without a task.
 */
export async function reseedMissingTasksForSequence(
  client: SupabaseClient,
  sequenceId: string,
): Promise<{ reseeded: number }> {
  const steps = await listSteps(client, sequenceId);
  if (steps.length === 0) return { reseeded: 0 };
  const stepByPos = new Map(steps.map((s) => [s.position, s]));

  const { data: enrs, error } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("sequence_id", sequenceId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  if (!enrs?.length) return { reseeded: 0 };

  // One batched open-task lookup (avoid N+1 COUNT per enrollment).
  const enrollmentIds = enrs.map((e) => e.id as string);
  const openEnrollmentIds = new Set<string>();
  const chunkSize = 100;
  for (let i = 0; i < enrollmentIds.length; i += chunkSize) {
    const slice = enrollmentIds.slice(i, i + chunkSize);
    const { data: openTasks, error: oErr } = await client
      .from("outreach_send_tasks")
      .select("enrollment_id")
      .in("enrollment_id", slice)
      .in("status", ["scheduled", "ready", "sending"]);
    if (oErr) throw new Error(oErr.message);
    for (const t of openTasks ?? []) {
      openEnrollmentIds.add(t.enrollment_id as string);
    }
  }

  const sendingWindow = await getSendingWindow(client);
  let reseeded = 0;

  for (const raw of enrs) {
    const enrollment = mapEnrollment(raw as Record<string, unknown>);
    if (openEnrollmentIds.has(enrollment.id)) continue;

    const step =
      stepByPos.get(enrollment.currentStepPosition) ?? steps[0] ?? null;
    if (!step) continue;

    const anchor = enrollment.nextRunAt
      ? new Date(enrollment.nextRunAt)
      : new Date();
    // Past due → send on next valid slot from now; future → keep planned time.
    const base =
      anchor.getTime() <= Date.now() ? new Date() : anchor;
    const when = nextSendingSlot(base, sendingWindow);

    const task = await createTaskForStep(client, enrollment, step, when);

    // Email step with no address creates a "skipped" task. Advance so the next
    // cron tick does not reseed another skipped row forever.
    if (
      task.status === "skipped" &&
      step.channel === "email" &&
      !enrollment.contactEmail?.trim()
    ) {
      await advanceEnrollment(client, enrollment.id);
      reseeded += 1;
      continue;
    }

    await client
      .from("outreach_enrollments")
      .update({
        current_step_position: step.position,
        next_run_at: when.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollment.id);
    reseeded += 1;
  }

  return { reseeded };
}

/** Repair orphan enrollments across all active sequences (queue/cron path). */
export async function reseedMissingTasksForActiveSequences(
  client: SupabaseClient,
): Promise<{ sequences: number; reseeded: number }> {
  const { data: seqs, error } = await client
    .from("outreach_sequences")
    .select("id")
    .eq("status", "active");
  if (error) throw new Error(error.message);

  let reseeded = 0;
  for (const s of seqs ?? []) {
    const res = await reseedMissingTasksForSequence(client, s.id as string);
    reseeded += res.reseeded;
  }
  return { sequences: seqs?.length ?? 0, reseeded };
}

export async function updateSequence(
  client: SupabaseClient,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: SequenceStatus;
    defaultFromEmail?: string | null;
    mailboxId?: string | null;
  },
): Promise<OutreachSequence> {
  await snapshotSequence(client, id, { reason: "update" });
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name != null) body.name = patch.name.trim();
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.status != null) body.status = patch.status;
  if (patch.defaultFromEmail !== undefined) {
    body.default_from_email = patch.defaultFromEmail;
  }
  if (patch.mailboxId !== undefined) body.mailbox_id = patch.mailboxId;
  const { data, error } = await client
    .from("outreach_sequences")
    .update(body)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const sequence = mapSequence(data as Record<string, unknown>);

  // Status is intentional — never auto-activate on enroll. Side effects hold/release queue.
  if (patch.status != null) {
    await applySequenceStatusSideEffects(client, id, patch.status);
  }
  return sequence;
}

async function getSequenceStatus(
  client: SupabaseClient,
  sequenceId: string,
): Promise<SequenceStatus | null> {
  const { data } = await client
    .from("outreach_sequences")
    .select("status")
    .eq("id", sequenceId)
    .maybeSingle();
  return (data?.status as SequenceStatus | undefined) ?? null;
}

/**
 * Hold or release tasks when the sequence status changes.
 * - not active → demote ready tasks back to scheduled (hidden from human queue)
 * - active → promote due scheduled tasks (LI / email semi) to ready
 */
async function applySequenceStatusSideEffects(
  client: SupabaseClient,
  sequenceId: string,
  status: SequenceStatus,
): Promise<void> {
  const { data: enrs } = await client
    .from("outreach_enrollments")
    .select("id")
    .eq("sequence_id", sequenceId);
  const enrollmentIds = (enrs ?? []).map((e) => e.id as string);
  if (enrollmentIds.length === 0) return;

  const now = new Date().toISOString();

  if (status !== "active") {
    // Pull work off the human queue until sequence is active again
    await client
      .from("outreach_send_tasks")
      .update({ status: "scheduled", updated_at: now })
      .in("enrollment_id", enrollmentIds)
      .eq("status", "ready");
    return;
  }

  // Activate: release due LinkedIn (and manual email) to the queue.
  // Auto email stays "scheduled" so processDueSequenceTasks can send it.
  // Activating on an off-day must not dump work into the queue — leave it
  // scheduled and let the cron release it on the next sending day.
  const sendingWindow = await getSendingWindow(client);
  if (!isSendingDay(new Date(now), sendingWindow)) return;

  await client
    .from("outreach_send_tasks")
    .update({ status: "ready", updated_at: now })
    .in("enrollment_id", enrollmentIds)
    .eq("status", "scheduled")
    .eq("channel", "linkedin")
    .lte("scheduled_for", now);

  await client
    .from("outreach_send_tasks")
    .update({ status: "ready", updated_at: now })
    .in("enrollment_id", enrollmentIds)
    .eq("status", "scheduled")
    .eq("channel", "email")
    .eq("mode", "semi")
    .lte("scheduled_for", now);
}

/**
 * Hard-delete a sequence. Cascades to steps, enrollments, and send_tasks
 * (FK ON DELETE CASCADE). Returns counts for UI/agent confirmation messaging.
 */
export async function deleteSequence(
  client: SupabaseClient,
  id: string,
): Promise<{
  ok: true;
  id: string;
  name: string;
  deletedEnrollments: number;
  deletedSteps: number;
}> {
  const existing = await getSequence(client, id);
  if (!existing) throw new Error("Sequence not found");
  await snapshotSequence(client, id, { reason: "delete" });

  const { count: enrollmentCount } = await client
    .from("outreach_enrollments")
    .select("id", { count: "exact", head: true })
    .eq("sequence_id", id);
  const stepCount = existing.steps.length;

  const { error } = await client
    .from("outreach_sequences")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);

  return {
    ok: true,
    id,
    name: existing.sequence.name,
    deletedEnrollments: enrollmentCount ?? 0,
    deletedSteps: stepCount,
  };
}

// ---------------------------------------------------------------------------
// Enroll
// ---------------------------------------------------------------------------

type ContactSnapshot = {
  companyName: string;
  domain: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactLinkedin: string | null;
  contactRole: string | null;
  researchRowId?: string | null;
  researchPersonId?: string | null;
  outreachProspectId?: string | null;
  crmCompanyId?: string | null;
  templateVars?: Record<string, string> | null;
  source: EnrollmentSource;
};

async function insertEnrollment(
  client: SupabaseClient,
  sequenceId: string,
  snap: ContactSnapshot,
  enrolledByEmail: string | null,
  firstStep: OutreachSequenceStep,
  opts?: { sequenceHasEmailSteps?: boolean },
): Promise<
  | { enrollment: OutreachEnrollment; task: OutreachSendTask; warning?: string }
  | null
  | { skipped: true; reason: string }
> {
  // Always enroll when we have a contact name or company. Missing email no longer blocks —
  // email steps are skipped with a clear warning/task error.
  if (
    firstStep.channel === "linkedin" &&
    !snap.contactLinkedin &&
    !snap.contactName
  ) {
    return {
      skipped: true,
      reason: `${snap.companyName}: no name or LinkedIn for first step`,
    };
  }

  const who = snap.contactName ?? snap.companyName;
  let warning: string | undefined;
  if (firstStep.channel === "linkedin" && !snap.contactLinkedin) {
    warning = "Missing LinkedIn URL — will show in queue without profile link";
  }
  if (!snap.contactEmail?.trim() && opts?.sequenceHasEmailSteps !== false) {
    warning = `${who}: no email — email steps for this lead will be skipped`;
  }

  // Enrolling on a Saturday must not generate a Saturday activity — roll the
  // first step forward to the next configured sending day.
  const sendingWindow = await getSendingWindow(client);
  const firstDue = nextSendingSlot(new Date(), sendingWindow);

  const { data: enr, error } = await client
    .from("outreach_enrollments")
    .insert({
      sequence_id: sequenceId,
      source: snap.source,
      outreach_prospect_id: snap.outreachProspectId ?? null,
      research_row_id: snap.researchRowId ?? null,
      research_person_id: snap.researchPersonId ?? null,
      crm_company_id: snap.crmCompanyId ?? null,
      template_vars: snap.templateVars ?? {},
      company_name: snap.companyName,
      domain: snap.domain,
      contact_name: snap.contactName,
      contact_email: snap.contactEmail,
      contact_linkedin: snap.contactLinkedin,
      contact_role: snap.contactRole,
      status: "active",
      current_step_position: firstStep.position,
      next_run_at: firstDue.toISOString(),
      enrolled_by_email: enrolledByEmail,
    })
    .select("*")
    .single();

  if (error) {
    // unique violation = already enrolled
    if (error.code === "23505") return null;
    throw new Error(error.message);
  }

  let enrollment = mapEnrollment(enr as Record<string, unknown>);
  const task = await createTaskForStep(
    client,
    enrollment,
    firstStep,
    firstDue,
  );

  // First step email with no address: already skipped — advance past consecutive email steps
  if (
    task.status === "skipped" &&
    firstStep.channel === "email" &&
    !snap.contactEmail?.trim()
  ) {
    const advanced = await advanceEnrollment(client, enrollment.id);
    if (advanced) enrollment = advanced;
  }

  return { enrollment, task, warning };
}

async function createTaskForStep(
  client: SupabaseClient,
  enrollment: OutreachEnrollment,
  step: OutreachSequenceStep,
  when: Date,
): Promise<OutreachSendTask> {
  const body = renderTemplate(step.bodyTemplate, enrollment);
  const subject = step.subjectTemplate
    ? renderTemplate(step.subjectTemplate, enrollment)
    : null;

  const due = when;
  // Only active sequences put work on the human queue / auto-send path.
  // Draft/paused/archived keep tasks scheduled until you activate.
  const seqStatus = await getSequenceStatus(client, enrollment.sequenceId);
  const sequenceLive = seqStatus === "active";
  let status: OutreachSendTask["status"] = "scheduled";
  let taskError: string | null = null;

  // No email → never put email work on the send queue
  if (step.channel === "email" && !enrollment.contactEmail?.trim()) {
    status = "skipped";
    taskError = "No contact email — email step skipped";
  } else if (
    sequenceLive &&
    step.channel === "linkedin" &&
    step.mode === "semi" &&
    due.getTime() <= Date.now() + 1000
  ) {
    status = "ready";
  }

  const { data, error } = await client
    .from("outreach_send_tasks")
    .insert({
      enrollment_id: enrollment.id,
      step_id: step.id,
      channel: step.channel,
      mode: step.mode,
      status,
      scheduled_for: due.toISOString(),
      rendered_subject: subject,
      rendered_body: body,
      error: taskError,
      provider:
        step.channel === "email"
          ? step.mode === "auto"
            ? "resend"
            : "manual"
          : "linkedin_semi",
      meta: {
        linkedin_action: step.linkedinAction,
        profile_url: enrollment.contactLinkedin,
        skipped_reason: taskError ? "missing_email" : undefined,
      },
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return mapTask(data as Record<string, unknown>);
}

export async function enrollFromResearch(
  client: SupabaseClient,
  input: {
    sequenceId: string;
    tableRef: string;
    rowIds?: string[];
    enrolledByEmail?: string | null;
    /** If true, one enrollment per person; else top person only per company */
    allPeople?: boolean;
  },
): Promise<{
  enrolled: number;
  skipped: number;
  errors: string[];
  warnings: string[];
  missingLinkedin: number;
  missingEmail: number;
  sequenceStatus: SequenceStatus;
}> {
  const seq = await getSequence(client, input.sequenceId);
  if (!seq) throw new Error("Sequence not found");
  if (seq.steps.length === 0) throw new Error("Sequence has no steps");
  const first = seq.steps[0];
  const needsEmailLater = seq.steps.some((s) => s.channel === "email");
  const needsLinkedinLater = seq.steps.some((s) => s.channel === "linkedin");

  const table = await resolveTable(client, input.tableRef);
  let rows = await listRows(client, table.id);
  if (input.rowIds?.length) {
    const set = new Set(input.rowIds);
    rows = rows.filter((r) => set.has(r.id));
  }

  let enrolled = 0;
  let skipped = 0;
  let missingLinkedin = 0;
  let missingEmail = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const people = await listPeople(client, row.id);
    const targets =
      people.length === 0
        ? [
            {
              id: null as string | null,
              name: row.companyName,
              role: null as string | null,
              email: null as string | null,
              linkedin: null as string | null,
            },
          ]
        : input.allPeople !== false
          ? people
          : [people.find((p) => p.email) ?? people[0]];

    for (const p of targets) {
      try {
        const result = await insertEnrollment(
          client,
          input.sequenceId,
          {
            source: "research",
            companyName: row.companyName,
            domain: row.domain,
            contactName: p.name !== row.companyName ? p.name : p.name,
            contactEmail: p.email,
            contactLinkedin: p.linkedin,
            contactRole: p.role,
            researchRowId: row.id,
            researchPersonId: p.id,
          },
          input.enrolledByEmail ?? null,
          first,
          { sequenceHasEmailSteps: needsEmailLater },
        );
        if (result && "skipped" in result && result.skipped) {
          skipped += 1;
          errors.push(result.reason);
          continue;
        }
        if (result && "enrollment" in result) {
          enrolled += 1;
          if (!p.linkedin && needsLinkedinLater) {
            missingLinkedin += 1;
            warnings.push(`${p.name}: enrolled without LinkedIn`);
          }
          if (!p.email && needsEmailLater) {
            missingEmail += 1;
            // Prefer the structured warning from insertEnrollment
            if (!result.warning) {
              warnings.push(
                `${p.name}: no email — email steps will be skipped`,
              );
            }
          }
          if (result.warning) warnings.push(result.warning);
        } else {
          skipped += 1;
        }
      } catch (err) {
        skipped += 1;
        errors.push(
          `${row.companyName}: ${err instanceof Error ? err.message : "fail"}`,
        );
      }
    }
  }

  // Do NOT auto-activate — user must set status to active intentionally.
  if (seq.sequence.status !== "active" && enrolled > 0) {
    warnings.push(
      `Sequence is "${seq.sequence.status}" — people enrolled but tasks stay held until you set status to active.`,
    );
  }

  return {
    enrolled,
    skipped,
    errors: errors.slice(0, 30),
    warnings: warnings.slice(0, 30),
    missingLinkedin,
    missingEmail,
    sequenceStatus: seq.sequence.status,
  };
}

/**
 * Enroll CRM accounts (companies + their contacts) into a sequence.
 * The entry path for product-signal tiers: filter accounts by tier in the
 * CRM, then enroll them here. Suppression: paying/closed accounts are
 * skipped, and accounts already active in ANY sequence are skipped unless
 * `allowParallel` is set.
 */
export async function enrollFromCrm(
  client: SupabaseClient,
  input: {
    sequenceId: string;
    companyIds: string[];
    enrolledByEmail?: string | null;
    /** If true, one enrollment per contact; else primary/first contact only. */
    allContacts?: boolean;
    /** Enroll even when the account has an active enrollment elsewhere. */
    allowParallel?: boolean;
  },
): Promise<{
  enrolled: number;
  skipped: number;
  errors: string[];
  warnings: string[];
  sequenceStatus: SequenceStatus;
}> {
  const seq = await getSequence(client, input.sequenceId);
  if (!seq) throw new Error("Sequence not found");
  if (seq.steps.length === 0) throw new Error("Sequence has no steps");
  const first = seq.steps[0];
  const needsEmailLater = seq.steps.some((s) => s.channel === "email");
  // Whether {{skip_reason}} needs a value is a property of the copy that will
  // be sent, not of the org receiving it. Trigger and destination sequence are
  // independent — an auto-enroll rule filters on trigger but points at any
  // sequence it likes, and the AI tool takes arbitrary company × sequence
  // pairs — so keying the fallback on the org's trigger gets it wrong in both
  // directions at once.
  const usesSkipReason = seq.steps.some(
    (s) =>
      (s.bodyTemplate ?? "").includes("skip_reason") ||
      (s.subjectTemplate ?? "").includes("skip_reason"),
  );

  const { listContacts, getCompany } = await import("@/lib/crm");

  let enrolled = 0;
  let skipped = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const companyId of input.companyIds) {
    let companyName = companyId;
    try {
      const company = await getCompany(client, companyId);
      if (!company) {
        skipped += 1;
        errors.push(`${companyId}: company not found`);
        continue;
      }
      companyName = company.name;

      // Suppression: never sequence paying or closed accounts.
      if (["customer", "churned", "lost"].includes(company.status)) {
        skipped += 1;
        errors.push(`${company.name}: status is ${company.status} — suppressed`);
        continue;
      }

      // Suppression: one active sequence per account at a time.
      if (!input.allowParallel) {
        const { data: active } = await client
          .from("outreach_enrollments")
          .select("id, sequence_id")
          .eq("crm_company_id", companyId)
          .eq("status", "active")
          .limit(1);
        if (active && active.length > 0) {
          skipped += 1;
          errors.push(
            `${company.name}: already active in another sequence — suppressed`,
          );
          continue;
        }
      }

      // Freeze product-signal tokens for templates ({{skip_reason}}, {{tier}},
      // {{trigger}}, {{dev_count}}, {{reviews_30d}}).
      const templateVars: Record<string, string> = {};
      if (company.orgId) {
        const { data: sig } = await client
          .from("product_signals_latest")
          .select("tier,trigger,top_skip_reason,dev_count,reviews_30d")
          .eq("org_id", company.orgId)
          .maybeSingle();
        if (sig) {
          if (sig.tier) templateVars.tier = String(sig.tier);
          if (sig.trigger) templateVars.trigger = String(sig.trigger);
          // Set only when the destination copy actually builds a sentence
          // around the token. An unconditional default would put "no reason
          // logged on our side" inside a free_limit sales email, where it reads
          // as an apology for something nobody asked about; leaving it unset
          // where the copy does use it renders "the reason we record is: ."
          if (sig.top_skip_reason) {
            templateVars.skip_reason = String(sig.top_skip_reason);
          } else if (usesSkipReason) {
            templateVars.skip_reason = "no reason logged on our side";
          }
          // dev_count is the git-derived team size, never user_count: that is
          // Kodus seats, usually 1, and it used to go out in real emails as if
          // it were the prospect's engineering headcount.
          if (sig.dev_count != null)
            templateVars.dev_count = String(sig.dev_count);
          if (sig.reviews_30d != null)
            templateVars.reviews_30d = String(sig.reviews_30d);
        }
      }

      const contacts = await listContacts(client, companyId);
      const withEmail = contacts.filter((c) => c.email);
      const primaryFirst = [...withEmail].sort(
        (a, b) => Number(b.isPrimary) - Number(a.isPrimary),
      );
      const targets = input.allContacts
        ? primaryFirst
        : primaryFirst.slice(0, 1);

      if (targets.length === 0) {
        skipped += 1;
        errors.push(`${company.name}: no contact with email`);
        continue;
      }

      for (const contact of targets) {
        const result = await insertEnrollment(
          client,
          input.sequenceId,
          {
            source: "crm",
            crmCompanyId: companyId,
            templateVars,
            companyName: company.name,
            domain: company.domain,
            contactName: contact.name,
            contactEmail: contact.email,
            contactLinkedin: contact.linkedin,
            contactRole: contact.role,
          },
          input.enrolledByEmail ?? null,
          first,
          { sequenceHasEmailSteps: needsEmailLater },
        );
        if (result && "enrollment" in result) {
          enrolled += 1;
          if (result.warning) warnings.push(result.warning);
        } else if (result && "skipped" in result && result.skipped) {
          skipped += 1;
          errors.push(result.reason);
        } else {
          skipped += 1; // unique violation: already enrolled in this sequence
        }
      }
    } catch (err) {
      skipped += 1;
      errors.push(
        `${companyName}: ${err instanceof Error ? err.message : "fail"}`,
      );
    }
  }

  if (seq.sequence.status !== "active" && enrolled > 0) {
    warnings.push(
      `Sequence is "${seq.sequence.status}" — accounts enrolled but tasks stay held until you set status to active.`,
    );
  }

  return {
    enrolled,
    skipped,
    errors: errors.slice(0, 30),
    warnings: warnings.slice(0, 30),
    sequenceStatus: seq.sequence.status,
  };
}

export async function enrollFromProspects(
  client: SupabaseClient,
  input: {
    sequenceId: string;
    prospectIds: string[];
    enrolledByEmail?: string | null;
  },
): Promise<{
  enrolled: number;
  skipped: number;
  errors: string[];
  sequenceStatus: SequenceStatus;
}> {
  const seq = await getSequence(client, input.sequenceId);
  if (!seq) throw new Error("Sequence not found");
  if (seq.steps.length === 0) throw new Error("Sequence has no steps");
  const first = seq.steps[0];

  let enrolled = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const pid of input.prospectIds) {
    try {
      const p = await getProspect(client, pid);
      if (!p) {
        skipped += 1;
        continue;
      }
      const hasEmailSteps = seq.steps.some((s) => s.channel === "email");
      const result = await insertEnrollment(
        client,
        input.sequenceId,
        {
          source: "outreach",
          companyName: p.niche || p.domain,
          domain: p.domain,
          contactName: p.contactName,
          contactEmail: p.contactEmail,
          contactLinkedin: p.contactUrl,
          contactRole: null,
          outreachProspectId: p.id,
        },
        input.enrolledByEmail ?? null,
        first,
        { sequenceHasEmailSteps: hasEmailSteps },
      );
      if (result && "skipped" in result && result.skipped) {
        skipped += 1;
        errors.push(result.reason);
      } else if (result && "enrollment" in result) {
        enrolled += 1;
        if (result.warning) errors.push(result.warning); // surface as notice list
      } else {
        skipped += 1;
      }
    } catch (err) {
      skipped += 1;
      errors.push(err instanceof Error ? err.message : "fail");
    }
  }

  return {
    enrolled,
    skipped,
    errors: errors.slice(0, 20),
    sequenceStatus: seq.sequence.status,
  };
}

// ---------------------------------------------------------------------------
// Queue + complete
// ---------------------------------------------------------------------------

export async function listReadyQueue(
  client: SupabaseClient,
  opts: { channel?: StepChannel; limit?: number } = {},
): Promise<OutreachSendTask[]> {
  let q = client
    .from("outreach_send_tasks")
    .select("*")
    .eq("status", "ready")
    .order("scheduled_for", { ascending: true })
    .limit(opts.limit ?? 100);
  if (opts.channel) q = q.eq("channel", opts.channel);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const tasks = (data ?? []).map((r) => mapTask(r as Record<string, unknown>));
  if (tasks.length === 0) return [];

  // Batch-load enrollments + steps (avoid N+1 on page load).
  const enrollmentIds = [...new Set(tasks.map((t) => t.enrollmentId))];
  const stepIds = [...new Set(tasks.map((t) => t.stepId))];

  const enrById = new Map<string, OutreachEnrollment>();
  const chunk = 100;
  for (let i = 0; i < enrollmentIds.length; i += chunk) {
    const slice = enrollmentIds.slice(i, i + chunk);
    const { data: enrs, error: eErr } = await client
      .from("outreach_enrollments")
      .select("*")
      .in("id", slice);
    if (eErr) throw new Error(eErr.message);
    for (const raw of enrs ?? []) {
      const enr = mapEnrollment(raw as Record<string, unknown>);
      enrById.set(enr.id, enr);
    }
  }

  const stepById = new Map<string, OutreachSequenceStep>();
  for (let i = 0; i < stepIds.length; i += chunk) {
    const slice = stepIds.slice(i, i + chunk);
    const { data: steps, error: sErr } = await client
      .from("outreach_sequence_steps")
      .select("*")
      .in("id", slice);
    if (sErr) throw new Error(sErr.message);
    for (const raw of steps ?? []) {
      const step = mapStep(raw as Record<string, unknown>);
      stepById.set(step.id, step);
    }
  }

  const seqIds = [
    ...new Set(
      [...enrById.values()]
        .map((e) => e.sequenceId)
        .filter(Boolean),
    ),
  ];
  const seqMeta = new Map<string, { name: string; status: SequenceStatus }>();
  if (seqIds.length > 0) {
    const { data: seqs, error: seqErr } = await client
      .from("outreach_sequences")
      .select("id, name, status")
      .in("id", seqIds);
    if (seqErr) throw new Error(seqErr.message);
    for (const s of seqs ?? []) {
      seqMeta.set(s.id as string, {
        name: (s.name as string) ?? "Sequence",
        status: (s.status as SequenceStatus) ?? "draft",
      });
    }
  }

  const live: OutreachSendTask[] = [];
  for (const t of tasks) {
    const enr = enrById.get(t.enrollmentId);
    if (!enr) continue;
    const meta = seqMeta.get(enr.sequenceId);
    if (!meta || meta.status !== "active") continue;
    t.enrollment = enr;
    t.sequenceName = meta.name;
    const step = stepById.get(t.stepId);
    if (step) t.step = step;
    live.push(t);
  }
  return live;
}

/**
 * Fast path for the Today UI: promote due *human* work to ready only.
 * Does NOT send auto email (that stays on the cron / processDueSequenceTasks).
 */
export async function promoteDueHumanQueue(
  client: SupabaseClient,
): Promise<{ promoted: number }> {
  const now = new Date().toISOString();
  const sendingWindow = await getSendingWindow(client);
  if (!isSendingDay(new Date(now), sendingWindow)) {
    return { promoted: 0 };
  }

  const { data: activeSeqs, error: sErr } = await client
    .from("outreach_sequences")
    .select("id")
    .eq("status", "active");
  if (sErr) throw new Error(sErr.message);
  const seqIds = (activeSeqs ?? []).map((s) => s.id as string);
  if (seqIds.length === 0) return { promoted: 0 };

  const { data: activeEnrs, error: eErr } = await client
    .from("outreach_enrollments")
    .select("id")
    .eq("status", "active")
    .in("sequence_id", seqIds);
  if (eErr) throw new Error(eErr.message);
  const enrollmentIds = (activeEnrs ?? []).map((e) => e.id as string);
  if (enrollmentIds.length === 0) return { promoted: 0 };

  let promoted = 0;
  const chunkSize = 100;

  // LinkedIn semi (always human)
  for (let i = 0; i < enrollmentIds.length; i += chunkSize) {
    const slice = enrollmentIds.slice(i, i + chunkSize);
    const { data, error } = await client
      .from("outreach_send_tasks")
      .update({ status: "ready", updated_at: now })
      .eq("status", "scheduled")
      .eq("channel", "linkedin")
      .lte("scheduled_for", now)
      .in("enrollment_id", slice)
      .select("id");
    if (error) throw new Error(error.message);
    promoted += data?.length ?? 0;
  }

  // Email that is already semi, or auto-send disabled → human queue
  const { isEmailAutoSendEnabled } = await import("@/lib/outreach/mailbox");
  const autoOn = await isEmailAutoSendEnabled(client, null);
  if (!autoOn) {
    // One RPC per chunk: bulk UPDATE + jsonb merge (preserves profile_url etc.).
    // Migration: 20260728_promote_email_human_queue.sql
    for (let i = 0; i < enrollmentIds.length; i += chunkSize) {
      const slice = enrollmentIds.slice(i, i + chunkSize);
      const { data: n, error } = await client.rpc(
        "promote_due_email_to_human_queue",
        {
          p_enrollment_ids: slice,
          p_now: now,
        },
      );
      if (error) {
        // Fallback if migration not applied yet: bulk promote without wiping
        // unrelated channels; meta merge via flag-only is worse than sequential
        // merge — prefer sequential only for small slices.
        if (
          /function|does not exist|PGRST202|42883/i.test(error.message ?? "")
        ) {
          const { data: due, error: selErr } = await client
            .from("outreach_send_tasks")
            .select("id, meta")
            .eq("status", "scheduled")
            .eq("channel", "email")
            .lte("scheduled_for", now)
            .in("enrollment_id", slice);
          if (selErr) throw new Error(selErr.message);
          for (const row of due ?? []) {
            const meta =
              row.meta &&
              typeof row.meta === "object" &&
              !Array.isArray(row.meta)
                ? (row.meta as Record<string, unknown>)
                : {};
            const { data: rows, error: uErr } = await client
              .from("outreach_send_tasks")
              .update({
                status: "ready",
                mode: "semi",
                provider: "manual",
                updated_at: now,
                meta: { ...meta, auto_send_disabled: true },
              })
              .eq("id", row.id as string)
              .eq("status", "scheduled")
              .select("id");
            if (uErr) throw new Error(uErr.message);
            promoted += rows?.length ?? 0;
          }
          continue;
        }
        throw new Error(error.message);
      }
      promoted += typeof n === "number" ? n : Number(n) || 0;
    }
  } else {
    // Only promote email tasks that are already semi
    for (let i = 0; i < enrollmentIds.length; i += chunkSize) {
      const slice = enrollmentIds.slice(i, i + chunkSize);
      const { data, error } = await client
        .from("outreach_send_tasks")
        .update({ status: "ready", updated_at: now })
        .eq("status", "scheduled")
        .eq("channel", "email")
        .eq("mode", "semi")
        .lte("scheduled_for", now)
        .in("enrollment_id", slice)
        .select("id");
      if (error) throw new Error(error.message);
      promoted += data?.length ?? 0;
    }
  }

  return { promoted };
}

/** Counts for the daily activity board. */
/** Per-inbox capacity for the ops strip on Sequences → Today. */
export type DayMailboxStatus = {
  id: string;
  label: string;
  fromEmail: string;
  dailyCap: number;
  /** Effective sends today (resets when `sentTodayDate` ≠ UTC date). */
  sentToday: number;
  lastSentAt: string | null;
  enabled: boolean;
  emailAutoSend: boolean;
};

/** Per active sequence: auto email + human ready work for the day. */
export type DaySequenceStatus = {
  id: string;
  name: string;
  emailSentToday: number;
  /** Scheduled auto emails blocked on daily cap (retry tomorrow / raise cap). */
  emailWaitingCap: number;
  readyLinkedin: number;
  readyEmail: number;
};

export type ActivityStats = {
  readyLinkedin: number;
  readyEmail: number;
  readyTotal: number;
  sentToday: number;
  skippedToday: number;
  emailAutoSend: boolean;
  mailboxes: DayMailboxStatus[];
  sequences: DaySequenceStatus[];
};

/**
 * Today queue counters + ops strip (inbox cap, auto email by sequence).
 * Ready totals only count tasks on *active* sequence enrollments so they
 * match `listReadyQueue` (draft/paused rows do not inflate the day).
 */
export async function getActivityStats(
  client: SupabaseClient,
): Promise<ActivityStats> {
  const { isEmailAutoSendEnabled, listMailboxes } = await import(
    "@/lib/outreach/mailbox"
  );
  const emailAutoSend = await isEmailAutoSendEnabled(client);

  const todayUtc = new Date().toISOString().slice(0, 10);
  const startIso = `${todayUtc}T00:00:00.000Z`;

  const mailboxesRaw = await listMailboxes(client);
  const mailboxes: DayMailboxStatus[] = mailboxesRaw
    .filter((m) => m.enabled)
    .map((m) => ({
      id: m.id,
      label: m.label,
      fromEmail: m.fromEmail,
      dailyCap: m.dailyCap,
      sentToday: m.sentTodayDate === todayUtc ? m.sentToday : 0,
      lastSentAt: m.lastSentAt,
      enabled: m.enabled,
      emailAutoSend: m.emailAutoSend,
    }));

  const { data: activeSeqs, error: seqErr } = await client
    .from("outreach_sequences")
    .select("id, name")
    .eq("status", "active")
    .order("name", { ascending: true });
  if (seqErr) throw new Error(seqErr.message);

  const sequencesMeta = activeSeqs ?? [];
  const activeSeqIds = sequencesMeta.map((s) => s.id as string);
  const seqByEnrollment = new Map<string, string>();
  const enrollmentIds: string[] = [];

  // One (chunked) query for all active enrollments — avoid N+1 per sequence.
  const enrChunk = 100;
  for (let i = 0; i < activeSeqIds.length; i += enrChunk) {
    const seqSlice = activeSeqIds.slice(i, i + enrChunk);
    if (seqSlice.length === 0) break;
    const { data: enrs, error: eErr } = await client
      .from("outreach_enrollments")
      .select("id, sequence_id")
      .eq("status", "active")
      .in("sequence_id", seqSlice);
    if (eErr) throw new Error(eErr.message);
    for (const e of enrs ?? []) {
      const id = e.id as string;
      enrollmentIds.push(id);
      seqByEnrollment.set(id, e.sequence_id as string);
    }
  }

  const bySeq = new Map<
    string,
    {
      emailSentToday: number;
      emailWaitingCap: number;
      readyLinkedin: number;
      readyEmail: number;
    }
  >();
  for (const s of sequencesMeta) {
    bySeq.set(s.id as string, {
      emailSentToday: 0,
      emailWaitingCap: 0,
      readyLinkedin: 0,
      readyEmail: 0,
    });
  }

  let readyLinkedin = 0;
  let readyEmail = 0;
  let sentToday = 0;
  let skippedToday = 0;

  const isCapError = (error: string | null | undefined) =>
    typeof error === "string" && /cap/i.test(error);

  const chunkSize = 100;
  for (let i = 0; i < enrollmentIds.length; i += chunkSize) {
    const slice = enrollmentIds.slice(i, i + chunkSize);
    if (slice.length === 0) break;

    const { data: readyRows, error: rErr } = await client
      .from("outreach_send_tasks")
      .select("enrollment_id, channel")
      .eq("status", "ready")
      .in("enrollment_id", slice);
    if (rErr) throw new Error(rErr.message);
    for (const t of readyRows ?? []) {
      const seqId = seqByEnrollment.get(t.enrollment_id as string);
      if (!seqId) continue;
      const bucket = bySeq.get(seqId);
      if (!bucket) continue;
      if (t.channel === "linkedin") {
        readyLinkedin += 1;
        bucket.readyLinkedin += 1;
      } else if (t.channel === "email") {
        readyEmail += 1;
        bucket.readyEmail += 1;
      }
    }

    // Filter cap text in app code — avoid leading-wildcard ILIKE on error.
    const { data: scheduledEmailRows, error: cErr } = await client
      .from("outreach_send_tasks")
      .select("enrollment_id, error")
      .eq("channel", "email")
      .eq("status", "scheduled")
      .not("error", "is", null)
      .in("enrollment_id", slice);
    if (cErr) throw new Error(cErr.message);
    for (const t of scheduledEmailRows ?? []) {
      if (!isCapError(t.error as string | null)) continue;
      const seqId = seqByEnrollment.get(t.enrollment_id as string);
      if (!seqId) continue;
      const bucket = bySeq.get(seqId);
      if (bucket) bucket.emailWaitingCap += 1;
    }

    const { data: sentRows, error: sErr } = await client
      .from("outreach_send_tasks")
      .select("enrollment_id, status, channel")
      .in("status", ["sent", "skipped"])
      .gte("sent_at", startIso)
      .in("enrollment_id", slice);
    if (sErr) throw new Error(sErr.message);
    for (const t of sentRows ?? []) {
      if (t.status === "skipped") {
        skippedToday += 1;
        continue;
      }
      sentToday += 1;
      if (t.channel === "email") {
        const seqId = seqByEnrollment.get(t.enrollment_id as string);
        if (!seqId) continue;
        const bucket = bySeq.get(seqId);
        if (bucket) bucket.emailSentToday += 1;
      }
    }
  }

  const sequences: DaySequenceStatus[] = sequencesMeta.map((s) => {
    const b = bySeq.get(s.id as string)!;
    return {
      id: s.id as string,
      name: (s.name as string) || "Sequence",
      emailSentToday: b.emailSentToday,
      emailWaitingCap: b.emailWaitingCap,
      readyLinkedin: b.readyLinkedin,
      readyEmail: b.readyEmail,
    };
  });

  return {
    readyLinkedin,
    readyEmail,
    readyTotal: readyLinkedin + readyEmail,
    sentToday,
    skippedToday,
    emailAutoSend,
    mailboxes,
    sequences,
  };
}

export async function completeTask(
  client: SupabaseClient,
  taskId: string,
  input: {
    outcome: "sent" | "skipped";
    sentByEmail?: string | null;
  },
): Promise<{ task: OutreachSendTask; enrollment: OutreachEnrollment | null }> {
  const { data: raw, error } = await client
    .from("outreach_send_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!raw) throw new Error("Task not found");
  const task = mapTask(raw as Record<string, unknown>);
  if (task.status === "sent" || task.status === "skipped") {
    return { task, enrollment: null };
  }

  const now = new Date().toISOString();
  const { data: updated, error: uerr } = await client
    .from("outreach_send_tasks")
    .update({
      status: input.outcome === "sent" ? "sent" : "skipped",
      sent_at: now,
      sent_by_email: input.sentByEmail ?? null,
      updated_at: now,
    })
    .eq("id", taskId)
    .select("*")
    .single();
  if (uerr) throw new Error(uerr.message);

  const enrollment = await advanceEnrollment(client, task.enrollmentId);

  if (input.outcome === "sent") {
    await recordOutreachOnCrm(client, enrollment, {
      channel: task.channel,
      sentAt: now,
      actorEmail: input.sentByEmail ?? null,
    });
  }

  // best-effort prospect status
  if (enrollment?.outreachProspectId && input.outcome === "sent") {
    try {
      await updateProspect(client, enrollment.outreachProspectId, {
        status: "contacted",
        lastTouchAt: now,
      });
    } catch {
      /* ignore */
    }
  }

  return {
    task: mapTask(updated as Record<string, unknown>),
    enrollment,
  };
}

/**
 * Write a send onto the CRM account it went to.
 *
 * Until this existed the CRM could not answer "have I already written to this
 * account". The fact was in outreach_send_tasks the whole time, but reaching it
 * meant joining through the enrollment, so in practice nobody could tell at a
 * glance — and the accounts list showed a contacted account and an untouched one
 * identically.
 *
 * Best-effort by design: a failure here must never turn a delivered email into a
 * failed task. The send already happened; losing the bookkeeping is the smaller
 * loss, and the send task itself remains the source of truth.
 *
 * Only fires for enrollments that carry a crm_company_id. The research-table
 * sequences do not, which is correct — those prospects are not CRM accounts.
 */
async function recordOutreachOnCrm(
  client: SupabaseClient,
  enrollment: OutreachEnrollment | null,
  opts: { channel: string; sentAt: string; actorEmail?: string | null },
): Promise<void> {
  const companyId = enrollment?.crmCompanyId;
  if (!companyId) return;
  try {
    const { logActivity } = await import("@/lib/crm");
    const who = enrollment?.contactName ?? enrollment?.contactEmail ?? "contact";
    await logActivity(client, companyId, "outreach_sent", {
      summary: `${opts.channel === "linkedin" ? "LinkedIn" : "Email"} sent to ${who}`,
      meta: {
        channel: opts.channel,
        enrollment_id: enrollment?.id,
        sequence_id: enrollment?.sequenceId,
        contact_email: enrollment?.contactEmail,
      },
      actorEmail: opts.actorEmail ?? null,
    });

    // Denormalised onto the account so the list can show "2 sent · 3d ago"
    // without walking the activity table. last_activity_at cannot serve here:
    // the signal sweep moves it every few hours on every account.
    //
    // Through an RPC rather than read-then-write: one account can hold several
    // contacts on the same sequence, so two sends landing together would both
    // read the same count and both write base + 1, quietly losing one.
    const { error } = await client.rpc("bump_outreach_counters", {
      p_company_id: companyId,
      p_sent_at: opts.sentAt,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn("[outreach] failed to record send on CRM account:", err);
  }
}

async function advanceEnrollment(
  client: SupabaseClient,
  enrollmentId: string,
): Promise<OutreachEnrollment | null> {
  const { data: enrRaw } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (!enrRaw) return null;
  const enrollment = mapEnrollment(enrRaw as Record<string, unknown>);
  if (enrollment.status !== "active") return enrollment;

  const steps = await listSteps(client, enrollment.sequenceId);
  const currentIdx = steps.findIndex(
    (s) => s.position === enrollment.currentStepPosition,
  );
  const next = currentIdx >= 0 ? steps[currentIdx + 1] : null;

  if (!next) {
    const { data } = await client
      .from("outreach_enrollments")
      .update({
        status: "completed",
        next_run_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollmentId)
      .select("*")
      .single();
    return data ? mapEnrollment(data as Record<string, unknown>) : enrollment;
  }

  // Raw delay first, then roll forward off any non-sending day. A 24h wait that
  // lands on Saturday becomes Monday rather than shifting every later step too.
  const sendingWindow = await getSendingWindow(client);
  const when = nextSendingSlot(
    new Date(Date.now() + next.delayHours * 3600 * 1000),
    sendingWindow,
  );
  // Use enrollment snapshot with next position for template/skip logic
  const enrollmentAtNext: OutreachEnrollment = {
    ...enrollment,
    currentStepPosition: next.position,
  };
  const nextTask = await createTaskForStep(
    client,
    enrollmentAtNext,
    next,
    when,
  );

  const { data } = await client
    .from("outreach_enrollments")
    .update({
      current_step_position: next.position,
      next_run_at: when.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", enrollmentId)
    .select("*")
    .single();

  const updated = data
    ? mapEnrollment(data as Record<string, unknown>)
    : enrollmentAtNext;

  // Chain-skip email steps when lead has no email (don't leave dead scheduled tasks)
  if (
    nextTask.status === "skipped" &&
    next.channel === "email" &&
    !enrollment.contactEmail?.trim()
  ) {
    return advanceEnrollment(client, enrollmentId);
  }

  return updated;
}

/**
 * Promote due scheduled tasks:
 * - linkedin semi → ready (human queue)
 * - email auto → send via product-configured mailbox (Settings → Outreach email)
 */
export async function processDueSequenceTasks(
  client: SupabaseClient,
  opts?: { reseedOrphans?: boolean },
): Promise<{
  promoted: number;
  emailsSent: number;
  emailsFailed: number;
  emailsSkipped: number;
  deferred: number;
  reseeded: number;
}> {
  // Optional repair: enrollments can outlive tasks when steps are rewritten
  // (CASCADE). Default off on the HTTP queue path — too slow for a page load.
  // Cron / explicit repair passes reseedOrphans: true.
  let reseeded = 0;
  if (opts?.reseedOrphans) {
    try {
      const repair = await reseedMissingTasksForActiveSequences(client);
      reseeded = repair.reseeded;
    } catch (err) {
      console.warn("[sequences] reseed missing tasks failed:", err);
    }
  }

  const now = new Date().toISOString();

  // Only pull work for *active* sequences. Draft/paused tasks used to fill the
  // limit(100) batch and starve live cadences (hundreds of stuck draft LinkedIn
  // rows → zero promotions per tick).
  const { data: activeSeqs, error: activeSeqErr } = await client
    .from("outreach_sequences")
    .select("id, mailbox_id")
    .eq("status", "active");
  if (activeSeqErr) throw new Error(activeSeqErr.message);
  const activeSeqRows = activeSeqs ?? [];
  if (activeSeqRows.length === 0) {
    return {
      promoted: 0,
      emailsSent: 0,
      emailsFailed: 0,
      emailsSkipped: 0,
      deferred: 0,
      reseeded,
    };
  }
  const mailboxBySeq = new Map(
    activeSeqRows.map((s) => [
      s.id as string,
      (s.mailbox_id as string | null) ?? null,
    ]),
  );

  const { data: activeEnrs, error: activeEnrErr } = await client
    .from("outreach_enrollments")
    .select("id, sequence_id")
    .eq("status", "active")
    .in(
      "sequence_id",
      activeSeqRows.map((s) => s.id as string),
    );
  if (activeEnrErr) throw new Error(activeEnrErr.message);
  const enrollmentIds = (activeEnrs ?? []).map((e) => e.id as string);
  const seqByEnrollment = new Map(
    (activeEnrs ?? []).map((e) => [
      e.id as string,
      e.sequence_id as string,
    ]),
  );
  if (enrollmentIds.length === 0) {
    return {
      promoted: 0,
      emailsSent: 0,
      emailsFailed: 0,
      emailsSkipped: 0,
      deferred: 0,
      reseeded,
    };
  }

  // Chunk .in() to stay under URL/body limits
  const dueTasks: Record<string, unknown>[] = [];
  const chunkSize = 100;
  for (let i = 0; i < enrollmentIds.length && dueTasks.length < 100; i += chunkSize) {
    const slice = enrollmentIds.slice(i, i + chunkSize);
    const { data, error } = await client
      .from("outreach_send_tasks")
      .select("*")
      .eq("status", "scheduled")
      .lte("scheduled_for", now)
      .in("enrollment_id", slice)
      .order("scheduled_for", { ascending: true })
      .limit(100 - dueTasks.length);
    if (error) throw new Error(error.message);
    dueTasks.push(...((data ?? []) as Record<string, unknown>[]));
  }

  // The cron ticks 24/7; the sending window decides whether it may act today.
  // This also catches tasks scheduled before the window was configured.
  const sendingWindow = await getSendingWindow(client);
  const withinWindow = isSendingDay(new Date(now), sendingWindow);

  let promoted = 0;
  let emailsSent = 0;
  let emailsFailed = 0;
  let emailsSkipped = 0;
  let deferred = 0;

  for (const raw of dueTasks) {
    const task = mapTask(raw);
    const sequenceId = seqByEnrollment.get(task.enrollmentId);
    if (!sequenceId) continue;
    const mailboxId = mailboxBySeq.get(sequenceId) ?? null;

    // Off-day: push the task (and the enrollment) to the next sending day
    // instead of firing it. Rescheduling rather than skipping keeps the queue
    // honest about when the lead will actually be contacted.
    //
    // Anchored on the task's own scheduled_for, not on `now`: anchoring on now
    // would collapse every deferred task onto one timestamp, destroying the
    // stagger and firing the whole weekend's backlog in one burst on Monday.
    if (!withinWindow) {
      const due = nextSendingSlotAfter(
        new Date(task.scheduledFor),
        new Date(now),
        sendingWindow,
      );
      await client
        .from("outreach_send_tasks")
        .update({ scheduled_for: due.toISOString(), updated_at: now })
        .eq("id", task.id)
        .eq("status", "scheduled");
      await client
        .from("outreach_enrollments")
        .update({ next_run_at: due.toISOString(), updated_at: now })
        .eq("id", task.enrollmentId);
      deferred += 1;
      continue;
    }

    if (task.channel === "linkedin") {
      await client
        .from("outreach_send_tasks")
        .update({ status: "ready", updated_at: now })
        .eq("id", task.id)
        .eq("status", "scheduled");
      promoted += 1;
      continue;
    }

    if (task.channel === "email" && task.mode === "auto") {
      const { isEmailAutoSendEnabled } = await import("@/lib/outreach/mailbox");
      const auto = await isEmailAutoSendEnabled(client, mailboxId);
      if (!auto) {
        // Workspace config: email auto-send off → human activity queue
        await client
          .from("outreach_send_tasks")
          .update({
            status: "ready",
            mode: "semi",
            provider: "manual",
            updated_at: now,
            meta: {
              ...(task.meta ?? {}),
              auto_send_disabled: true,
            },
          })
          .eq("id", task.id)
          .eq("status", "scheduled");
        promoted += 1;
        continue;
      }
      const result = await sendDueEmailTask(client, task, mailboxId);
      if (result === "sent") emailsSent += 1;
      else if (result === "failed") emailsFailed += 1;
      else emailsSkipped += 1;
    } else if (task.channel === "email") {
      // email semi → human queue
      await client
        .from("outreach_send_tasks")
        .update({ status: "ready", updated_at: now })
        .eq("id", task.id)
        .eq("status", "scheduled");
      promoted += 1;
    }
  }

  return {
    promoted,
    emailsSent,
    emailsFailed,
    emailsSkipped,
    deferred,
    reseeded,
  };
}

async function sendDueEmailTask(
  client: SupabaseClient,
  task: OutreachSendTask,
  mailboxId: string | null,
): Promise<"sent" | "failed" | "skipped"> {
  const now = new Date().toISOString();

  const { data: enrRaw } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("id", task.enrollmentId)
    .maybeSingle();
  if (!enrRaw) {
    await client
      .from("outreach_send_tasks")
      .update({
        status: "failed",
        error: "Enrollment missing",
        updated_at: now,
      })
      .eq("id", task.id);
    return "failed";
  }
  const enrollment = mapEnrollment(enrRaw as Record<string, unknown>);
  if (enrollment.status !== "active") {
    await client
      .from("outreach_send_tasks")
      .update({
        status: "cancelled",
        error: `Enrollment ${enrollment.status}`,
        updated_at: now,
      })
      .eq("id", task.id);
    return "skipped";
  }

  const to = enrollment.contactEmail?.trim();
  if (!to) {
    await client
      .from("outreach_send_tasks")
      .update({
        status: "skipped",
        error: "No contact email",
        updated_at: now,
      })
      .eq("id", task.id);
    await advanceEnrollment(client, enrollment.id);
    return "skipped";
  }

  // claim
  await client
    .from("outreach_send_tasks")
    .update({ status: "sending", updated_at: now })
    .eq("id", task.id)
    .eq("status", "scheduled");

  const { sendOutreachEmail } = await import("@/lib/outreach/send-email");
  let subject = task.renderedSubject ?? "";
  const body = task.renderedBody ?? "";

  // Per-step: new thread vs reply to previous email in this enrollment
  const { data: stepRow } = await client
    .from("outreach_sequence_steps")
    .select("email_thread_mode, position")
    .eq("id", task.stepId)
    .maybeSingle();
  const requestedThreadMode =
    (stepRow?.email_thread_mode as string | null) === "new" ? "new" : "reply";

  const priorThread =
    requestedThreadMode === "reply"
      ? await getEnrollmentEmailThread(client, enrollment.id)
      : null;
  // A reply cannot exist without an earlier sent email for this enrollment.
  const threadMode = priorThread ? "reply" : "new";

  // Reply mode: subject follows the thread root (Re: original) for client threading
  if (threadMode === "reply" && priorThread?.rootSubject?.trim()) {
    const root = priorThread.rootSubject.trim().replace(/^(re:\s*)+/i, "");
    const desired = `Re: ${root}`;
    // If empty or already a Re: of something, normalize to root thread subject
    if (!subject.trim() || /^re:\s/i.test(subject.trim())) {
      subject = desired;
    }
  } else if (requestedThreadMode === "reply") {
    // A stale/invalid first-step reply is sent as a fresh conversation.
    subject = subject.replace(/^(re:\s*)+/i, "");
  }

  const send = await sendOutreachEmail(client, {
    to,
    subject,
    text: body,
    mailboxId,
    thread: priorThread
      ? {
          inReplyTo: priorThread.lastRfcMessageId,
          references: priorThread.references,
          gmailThreadId: priorThread.gmailThreadId,
        }
      : null,
  });

  if (!send.ok) {
    // Cap / no mailbox: leave as scheduled for retry later
    if (send.code === "cap" || send.code === "no_mailbox") {
      await client
        .from("outreach_send_tasks")
        .update({
          status: "scheduled",
          error: send.error,
          updated_at: now,
        })
        .eq("id", task.id);
      return "skipped";
    }

    const { looksLikeHardBounce } = await import("@/lib/email-verifier");
    const hardBounce = looksLikeHardBounce(send.error);

    await client
      .from("outreach_send_tasks")
      .update({
        status: "failed",
        error: send.error,
        provider: "smtp",
        updated_at: now,
      })
      .eq("id", task.id);
    await client
      .from("outreach_enrollments")
      .update({
        status: hardBounce ? "bounced" : enrollment.status,
        last_error: send.error,
        updated_at: now,
      })
      .eq("id", enrollment.id);

    // Ground-truth: hard bounce updates research_people.email_status
    if (hardBounce && to) {
      try {
        const { markResearchPeopleEmailBounced } = await import(
          "@/lib/research/tables"
        );
        await markResearchPeopleEmailBounced(client, to, {
          reason: send.error.slice(0, 120),
        });
      } catch (err) {
        console.warn("[sequences] mark bounced failed:", err);
      }
    }
    return "failed";
  }

  const nextRefs = [
    ...(priorThread?.references
      ? priorThread.references.split(/\s+/).filter(Boolean)
      : []),
    send.rfcMessageId,
  ]
    .filter(Boolean)
    .map((id) => (id.startsWith("<") ? id : `<${id}>`));
  const uniqueRefs = [...new Set(nextRefs)].join(" ");

  await client
    .from("outreach_send_tasks")
    .update({
      status: "sent",
      sent_at: now,
      provider: send.gmailThreadId ? "gmail" : "smtp",
      provider_message_id: send.messageId,
      error: null,
      updated_at: now,
      meta: {
        ...(task.meta ?? {}),
        mailbox_id: send.mailboxId,
        from: send.from,
        rfc_message_id: send.rfcMessageId,
        gmail_thread_id: send.gmailThreadId,
        thread_root_message_id:
          priorThread?.rootRfcMessageId ?? send.rfcMessageId,
        thread_references: uniqueRefs,
        threaded: Boolean(priorThread?.lastRfcMessageId),
        email_thread_mode: threadMode,
        subject: subject,
      },
    })
    .eq("id", task.id);

  await advanceEnrollment(client, enrollment.id);

  await recordOutreachOnCrm(client, enrollment, {
    channel: task.channel,
    sentAt: now,
    // Auto-sent: no human pressed anything, so the timeline says so.
    actorEmail: null,
  });

  if (enrollment.outreachProspectId) {
    try {
      await updateProspect(client, enrollment.outreachProspectId, {
        status: "contacted",
        lastTouchAt: now,
      });
    } catch {
      /* ignore */
    }
  }

  return "sent";
}

/**
 * Prior email in this enrollment for reply-threading (In-Reply-To / References / Gmail threadId).
 */
async function getEnrollmentEmailThread(
  client: SupabaseClient,
  enrollmentId: string,
): Promise<{
  rootRfcMessageId: string;
  lastRfcMessageId: string;
  references: string;
  gmailThreadId: string | null;
  rootSubject: string | null;
} | null> {
  const { data, error } = await client
    .from("outreach_send_tasks")
    .select("provider_message_id, rendered_subject, meta, sent_at, created_at")
    .eq("enrollment_id", enrollmentId)
    .eq("channel", "email")
    .eq("status", "sent")
    .order("sent_at", { ascending: true })
    .limit(20);
  if (error || !data?.length) return null;

  const rows = data as Array<Record<string, unknown>>;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const firstMeta = (first.meta ?? {}) as Record<string, unknown>;
  const lastMeta = (last.meta ?? {}) as Record<string, unknown>;

  const rootRfc =
    (firstMeta.rfc_message_id as string | undefined) ||
    (firstMeta.thread_root_message_id as string | undefined) ||
    (typeof first.provider_message_id === "string" &&
    first.provider_message_id.includes("@")
      ? first.provider_message_id
      : null);
  if (!rootRfc) return null;

  const lastRfc =
    (lastMeta.rfc_message_id as string | undefined) ||
    (typeof last.provider_message_id === "string" &&
    last.provider_message_id.includes("@")
      ? last.provider_message_id
      : rootRfc);

  const chain: string[] = [];
  for (const r of rows) {
    const m = (r.meta ?? {}) as Record<string, unknown>;
    const id =
      (m.rfc_message_id as string | undefined) ||
      (typeof r.provider_message_id === "string" &&
      String(r.provider_message_id).includes("@")
        ? String(r.provider_message_id)
        : null);
    if (id) {
      const norm = id.startsWith("<") ? id : `<${id}>`;
      if (!chain.includes(norm)) chain.push(norm);
    }
  }
  if (!chain.length) {
    chain.push(rootRfc.startsWith("<") ? rootRfc : `<${rootRfc}>`);
  }

  const gmailThreadId =
    (lastMeta.gmail_thread_id as string | undefined) ||
    (firstMeta.gmail_thread_id as string | undefined) ||
    null;

  const rootSubject =
    (firstMeta.subject as string | undefined) ||
    (first.rendered_subject as string | null) ||
    null;

  return {
    rootRfcMessageId: rootRfc.startsWith("<") ? rootRfc : `<${rootRfc}>`,
    lastRfcMessageId: lastRfc.startsWith("<") ? lastRfc : `<${lastRfc}>`,
    references: chain.join(" "),
    gmailThreadId,
    rootSubject,
  };
}

export async function listEnrollments(
  client: SupabaseClient,
  sequenceId: string,
): Promise<OutreachEnrollment[]> {
  const { data, error } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("sequence_id", sequenceId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapEnrollment(r as Record<string, unknown>));
}

/**
 * Remove contacts from a sequence without erasing its delivery history.
 *
 * An enrollment is cancelled rather than deleted so any completed/sent work
 * remains auditable. Pending tasks are cancelled and the contact may be
 * enrolled in another sequence afterwards.
 */
export async function unenrollFromSequence(
  client: SupabaseClient,
  input: {
    sequenceId: string;
    enrollmentIds?: string[];
    researchPersonIds?: string[];
    researchRowIds?: string[];
  },
): Promise<{
  cancelled: number;
  alreadyInactive: number;
  pendingTasksCancelled: number;
  enrollmentIds: string[];
}> {
  const queries = [];
  if (input.enrollmentIds?.length) {
    queries.push(
      client
        .from("outreach_enrollments")
        .select("id, status")
        .eq("sequence_id", input.sequenceId)
        .in("id", input.enrollmentIds),
    );
  }
  if (input.researchPersonIds?.length) {
    queries.push(
      client
        .from("outreach_enrollments")
        .select("id, status")
        .eq("sequence_id", input.sequenceId)
        .in("research_person_id", input.researchPersonIds),
    );
  }
  if (input.researchRowIds?.length) {
    queries.push(
      client
        .from("outreach_enrollments")
        .select("id, status")
        .eq("sequence_id", input.sequenceId)
        .in("research_row_id", input.researchRowIds),
    );
  }
  if (queries.length === 0) {
    throw new Error("Provide enrollmentIds, researchPersonIds, or researchRowIds");
  }

  const results = await Promise.all(queries);
  const matches = new Map<string, string>();
  for (const { data, error } of results) {
    if (error) throw new Error(error.message);
    for (const enrollment of data ?? []) {
      matches.set(enrollment.id as string, enrollment.status as string);
    }
  }

  const activeIds = [...matches]
    .filter(([, status]) => status === "active" || status === "paused")
    .map(([id]) => id);
  const alreadyInactive = matches.size - activeIds.length;
  if (activeIds.length === 0) {
    return {
      cancelled: 0,
      alreadyInactive,
      pendingTasksCancelled: 0,
      enrollmentIds: [],
    };
  }

  await snapshotSequence(client, input.sequenceId, {
    reason: `unenroll:${activeIds.length}`,
  });

  const now = new Date().toISOString();
  const { data: cancelledTasks, error: tasksError } = await client
    .from("outreach_send_tasks")
    .update({
      status: "cancelled",
      error: "Enrollment removed from sequence",
      updated_at: now,
    })
    .in("enrollment_id", activeIds)
    .in("status", ["scheduled", "ready"])
    .select("id");
  if (tasksError) throw new Error(tasksError.message);

  const { error: enrollmentsError } = await client
    .from("outreach_enrollments")
    .update({
      status: "cancelled",
      next_run_at: null,
      last_error: "Removed from sequence",
      updated_at: now,
    })
    .in("id", activeIds);
  if (enrollmentsError) throw new Error(enrollmentsError.message);

  return {
    cancelled: activeIds.length,
    alreadyInactive,
    pendingTasksCancelled: cancelledTasks?.length ?? 0,
    enrollmentIds: activeIds,
  };
}

/**
 * Mark an enrollment as replied and cancel remaining scheduled/ready tasks.
 * Used by Gmail reply sync (strong match) and manual mark-replied.
 *
 * Convert handoff: also upserts CRM Account (domain + contact) as qualified —
 * best-effort so a CRM failure never blocks stopping the sequence.
 */
export async function markEnrollmentReplied(
  client: SupabaseClient,
  enrollmentId: string,
  opts?: { source?: string },
): Promise<{
  updated: boolean;
  alreadyTerminal: boolean;
  pendingTasksCancelled: number;
  enrollment: OutreachEnrollment | null;
  crm?: {
    companyId: string | null;
    created: boolean;
    contactCreated: boolean;
    skipped?: string;
  };
}> {
  const { data: raw, error } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!raw) {
    return {
      updated: false,
      alreadyTerminal: false,
      pendingTasksCancelled: 0,
      enrollment: null,
    };
  }

  const enrollment = mapEnrollment(raw as Record<string, unknown>);
  const terminal = new Set([
    "replied",
    "completed",
    "cancelled",
    "bounced",
    "failed",
  ]);
  const now = new Date().toISOString();
  const source = opts?.source?.trim() || "manual";

  const { data: cancelledTasks, error: tasksError } = await client
    .from("outreach_send_tasks")
    .update({
      status: "cancelled",
      error: `Stopped on reply (${source})`,
      updated_at: now,
    })
    .eq("enrollment_id", enrollmentId)
    .in("status", ["scheduled", "ready"])
    .select("id");
  if (tasksError) throw new Error(tasksError.message);

  let finalEnrollment = enrollment;
  let updatedFlag = false;
  let alreadyTerminal = false;

  if (terminal.has(enrollment.status)) {
    alreadyTerminal = true;
    if (enrollment.status === "replied") {
      // Already replied — still ensure CRM handoff (idempotent).
    } else {
      // completed/cancelled/etc. → upgrade to replied
      const { data: updated, error: enrollError } = await client
        .from("outreach_enrollments")
        .update({
          status: "replied",
          next_run_at: null,
          last_error: null,
          updated_at: now,
        })
        .eq("id", enrollmentId)
        .select("*")
        .single();
      if (enrollError) throw new Error(enrollError.message);
      finalEnrollment = mapEnrollment(updated as Record<string, unknown>);
      updatedFlag = true;
    }
  } else {
    const { data: updated, error: enrollError } = await client
      .from("outreach_enrollments")
      .update({
        status: "replied",
        next_run_at: null,
        last_error: null,
        updated_at: now,
      })
      .eq("id", enrollmentId)
      .select("*")
      .single();
    if (enrollError) throw new Error(enrollError.message);
    finalEnrollment = mapEnrollment(updated as Record<string, unknown>);
    updatedFlag = true;
  }

  // CRM handoff: reply → Accounts (domain + contact). Never fail the stop.
  let crm:
    | {
        companyId: string | null;
        created: boolean;
        contactCreated: boolean;
        skipped?: string;
      }
    | undefined;
  try {
    const { promoteEnrollmentToCrm } = await import("@/lib/crm");
    const promoted = await promoteEnrollmentToCrm(client, finalEnrollment, {
      reason: "reply",
    });
    crm = {
      companyId: promoted.company?.id ?? null,
      created: promoted.created,
      contactCreated: promoted.contactCreated,
      skipped: promoted.skipped,
    };
  } catch (err) {
    console.warn("[sequences] CRM promote on reply failed:", err);
    crm = {
      companyId: null,
      created: false,
      contactCreated: false,
      skipped: err instanceof Error ? err.message : "CRM promote failed",
    };
  }

  return {
    updated: updatedFlag,
    alreadyTerminal,
    pendingTasksCancelled: cancelledTasks?.length ?? 0,
    enrollment: finalEnrollment,
    crm,
  };
}

/**
 * Hard bounce / DSN: stop the cadence and record bounce (not engagement).
 */
export async function markEnrollmentBounced(
  client: SupabaseClient,
  enrollmentId: string,
  opts?: { source?: string; reason?: string | null },
): Promise<{
  updated: boolean;
  alreadyTerminal: boolean;
  pendingTasksCancelled: number;
  enrollment: OutreachEnrollment | null;
}> {
  const { data: raw, error } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!raw) {
    return {
      updated: false,
      alreadyTerminal: false,
      pendingTasksCancelled: 0,
      enrollment: null,
    };
  }

  const enrollment = mapEnrollment(raw as Record<string, unknown>);
  const terminal = new Set([
    "replied",
    "completed",
    "cancelled",
    "bounced",
    "failed",
  ]);
  const now = new Date().toISOString();
  const source = opts?.source?.trim() || "bounce";
  const reason = (opts?.reason ?? "Hard bounce / address not found").slice(
    0,
    240,
  );

  const { data: cancelledTasks, error: tasksError } = await client
    .from("outreach_send_tasks")
    .update({
      status: "cancelled",
      error: `Stopped on bounce (${source})`,
      updated_at: now,
    })
    .eq("enrollment_id", enrollmentId)
    .in("status", ["scheduled", "ready"])
    .select("id");
  if (tasksError) throw new Error(tasksError.message);

  if (enrollment.status === "bounced") {
    return {
      updated: false,
      alreadyTerminal: true,
      pendingTasksCancelled: cancelledTasks?.length ?? 0,
      enrollment,
    };
  }

  // Bounce wins over false "replied" from DSN misclassification.
  const { data: updated, error: enrollError } = await client
    .from("outreach_enrollments")
    .update({
      status: "bounced",
      next_run_at: null,
      last_error: reason,
      updated_at: now,
    })
    .eq("id", enrollmentId)
    .select("*")
    .single();
  if (enrollError) throw new Error(enrollError.message);

  if (enrollment.contactEmail?.trim()) {
    try {
      const { markResearchPeopleEmailBounced } = await import(
        "@/lib/research/tables"
      );
      await markResearchPeopleEmailBounced(client, enrollment.contactEmail, {
        reason: reason.slice(0, 120),
      });
    } catch (err) {
      console.warn("[sequences] mark research bounce failed:", err);
    }
  }

  return {
    updated: true,
    alreadyTerminal: terminal.has(enrollment.status),
    pendingTasksCancelled: cancelledTasks?.length ?? 0,
    enrollment: mapEnrollment(updated as Record<string, unknown>),
  };
}

/**
 * Pause or resume a single person in a sequence (not the whole campaign).
 */
export async function setEnrollmentPaused(
  client: SupabaseClient,
  enrollmentId: string,
  paused: boolean,
  opts?: { reason?: string | null },
): Promise<OutreachEnrollment> {
  const { data: raw, error } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!raw) throw new Error("Enrollment not found");
  const enrollment = mapEnrollment(raw as Record<string, unknown>);

  const terminal = new Set([
    "completed",
    "cancelled",
    "bounced",
    "failed",
    "replied",
  ]);
  if (terminal.has(enrollment.status) && paused) {
    throw new Error(
      `Cannot pause enrollment in status "${enrollment.status}"`,
    );
  }

  const now = new Date().toISOString();

  if (paused) {
    const { error: cancelErr } = await client
      .from("outreach_send_tasks")
      .update({
        status: "cancelled",
        error: opts?.reason?.trim() || "Paused by user",
        updated_at: now,
      })
      .eq("enrollment_id", enrollmentId)
      .in("status", ["scheduled", "ready"]);
    if (cancelErr) throw new Error(cancelErr.message);

    const { data, error: uErr } = await client
      .from("outreach_enrollments")
      .update({
        status: "paused",
        next_run_at: null,
        last_error: opts?.reason?.trim() || "Paused by user",
        updated_at: now,
      })
      .eq("id", enrollmentId)
      .select("*")
      .single();
    if (uErr) throw new Error(uErr.message);
    return mapEnrollment(data as Record<string, unknown>);
  }

  // Resume: active + create task for current step if none open
  const { data, error: uErr } = await client
    .from("outreach_enrollments")
    .update({
      status: "active",
      last_error: null,
      updated_at: now,
    })
    .eq("id", enrollmentId)
    .select("*")
    .single();
  if (uErr) throw new Error(uErr.message);

  let active = mapEnrollment(data as Record<string, unknown>);
  const { count: openCount, error: openErr } = await client
    .from("outreach_send_tasks")
    .select("id", { count: "exact", head: true })
    .eq("enrollment_id", enrollmentId)
    .in("status", ["scheduled", "ready", "sending"]);
  if (openErr) throw new Error(openErr.message);

  if ((openCount ?? 0) === 0) {
    const steps = await listSteps(client, active.sequenceId);
    const stepByPos = new Map(steps.map((s) => [s.position, s]));
    const step =
      stepByPos.get(active.currentStepPosition) ?? steps[0] ?? null;
    if (step) {
      const sendingWindow = await getSendingWindow(client);
      const when = nextSendingSlot(new Date(), sendingWindow);
      const task = await createTaskForStep(client, active, step, when);
      if (
        task.status === "skipped" &&
        step.channel === "email" &&
        !active.contactEmail?.trim()
      ) {
        const advanced = await advanceEnrollment(client, enrollmentId);
        if (advanced) return advanced;
      } else {
        const { data: patched } = await client
          .from("outreach_enrollments")
          .update({
            current_step_position: step.position,
            next_run_at: when.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", enrollmentId)
          .select("*")
          .single();
        if (patched) {
          active = mapEnrollment(patched as Record<string, unknown>);
        }
      }
    }
  }

  return active;
}

type ResearchPersonSnapshot = {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  linkedin: string | null;
};

function normalizedPersonValue(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function enrollmentMatchesResearchPerson(
  enrollment: OutreachEnrollment,
  person: ResearchPersonSnapshot,
): boolean {
  if (enrollment.researchPersonId === person.id) return true;

  const enrollmentEmail = normalizedPersonValue(enrollment.contactEmail);
  const personEmail = normalizedPersonValue(person.email);
  if (enrollmentEmail && personEmail && enrollmentEmail === personEmail) {
    return true;
  }

  const enrollmentLinkedin = normalizedPersonValue(enrollment.contactLinkedin);
  const personLinkedin = normalizedPersonValue(person.linkedin);
  if (
    enrollmentLinkedin &&
    personLinkedin &&
    enrollmentLinkedin === personLinkedin
  ) {
    return true;
  }

  return (
    normalizedPersonValue(enrollment.contactName) ===
    normalizedPersonValue(person.name)
  );
}

/**
 * Keep active campaign snapshots aligned when research_people is rewritten.
 *
 * savePeople intentionally replaces research_people rows, so person IDs can
 * rotate even when the human is the same. We match on stable identity fields,
 * then refresh the enrollment and its unsent task renderings. If the campaign
 * skipped its first email only because it was missing, an email discovered
 * before any send restarts that lead at the skipped email step.
 */
export async function syncResearchPeopleToEnrollments(
  client: SupabaseClient,
  rowId: string,
  people: ResearchPersonSnapshot[],
): Promise<{
  synchronized: number;
  pendingTasksRerendered: number;
  restartedAfterEmailFound: number;
}> {
  const { data: rawEnrollments, error: enrollmentsError } = await client
    .from("outreach_enrollments")
    .select("*")
    .eq("research_row_id", rowId)
    .in("status", ["active", "paused"]);
  if (enrollmentsError) throw new Error(enrollmentsError.message);

  const enrollments = (rawEnrollments ?? []).map((row) =>
    mapEnrollment(row as Record<string, unknown>),
  );
  if (enrollments.length === 0) {
    return {
      synchronized: 0,
      pendingTasksRerendered: 0,
      restartedAfterEmailFound: 0,
    };
  }

  const enrollmentIds = enrollments.map((enrollment) => enrollment.id);
  const { data: rawTasks, error: tasksError } = await client
    .from("outreach_send_tasks")
    .select("*")
    .in("enrollment_id", enrollmentIds);
  if (tasksError) throw new Error(tasksError.message);

  const tasksByEnrollment = new Map<string, OutreachSendTask[]>();
  for (const rawTask of rawTasks ?? []) {
    const task = mapTask(rawTask as Record<string, unknown>);
    const tasks = tasksByEnrollment.get(task.enrollmentId) ?? [];
    tasks.push(task);
    tasksByEnrollment.set(task.enrollmentId, tasks);
  }

  const stepLists = await Promise.all(
    [...new Set(enrollments.map((enrollment) => enrollment.sequenceId))].map(
      async (sequenceId) => [sequenceId, await listSteps(client, sequenceId)] as const,
    ),
  );
  const stepsBySequence = new Map(stepLists);
  const now = new Date().toISOString();
  let synchronized = 0;
  let pendingTasksRerendered = 0;
  let restartedAfterEmailFound = 0;

  for (const enrollment of enrollments) {
    const person = people.find((candidate) =>
      enrollmentMatchesResearchPerson(enrollment, candidate),
    );
    if (!person) continue;

    const refreshed: OutreachEnrollment = {
      ...enrollment,
      researchPersonId: person.id,
      contactName: person.name,
      contactRole: person.role,
      contactEmail: person.email,
      contactLinkedin: person.linkedin,
    };
    const { error: updateEnrollmentError } = await client
      .from("outreach_enrollments")
      .update({
        research_person_id: person.id,
        contact_name: person.name,
        contact_role: person.role,
        contact_email: person.email,
        contact_linkedin: person.linkedin,
        updated_at: now,
      })
      .eq("id", enrollment.id);
    if (updateEnrollmentError) throw new Error(updateEnrollmentError.message);
    synchronized++;

    const steps = stepsBySequence.get(enrollment.sequenceId) ?? [];
    const stepById = new Map(steps.map((step) => [step.id, step]));
    const tasks = tasksByEnrollment.get(enrollment.id) ?? [];
    const hasSentTask = tasks.some((task) => task.status === "sent");
    const skippedEmail = person.email
      ? tasks
          .filter(
            (task) =>
              task.status === "skipped" &&
              task.error === "No contact email — email step skipped",
          )
          .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0]
      : undefined;

    if (skippedEmail && !hasSentTask) {
      const skippedStep = stepById.get(skippedEmail.stepId);
      if (skippedStep) {
        const resetTaskIds = tasks
          .filter(
            (task) => task.status === "scheduled" || task.status === "ready")
          .map((task) => task.id);
        if (resetTaskIds.length > 0) {
          const { error } = await client
            .from("outreach_send_tasks")
            .update({
              status: "cancelled",
              error: "Reset after contact email was found",
              updated_at: now,
            })
            .in("id", resetTaskIds);
          if (error) throw new Error(error.message);
        }

        const { error: restartTaskError } = await client
          .from("outreach_send_tasks")
          .update({
            status: "scheduled",
            error: null,
            rendered_subject: skippedStep.subjectTemplate
              ? renderTemplate(skippedStep.subjectTemplate, refreshed)
              : null,
            rendered_body: renderTemplate(skippedStep.bodyTemplate, refreshed),
            meta: {
              linkedin_action: skippedStep.linkedinAction,
              profile_url: refreshed.contactLinkedin,
            },
            updated_at: now,
          })
          .eq("id", skippedEmail.id);
        if (restartTaskError) throw new Error(restartTaskError.message);

        const { error: restartEnrollmentError } = await client
          .from("outreach_enrollments")
          .update({
            current_step_position: skippedStep.position,
            next_run_at: skippedEmail.scheduledFor,
            updated_at: now,
          })
          .eq("id", enrollment.id);
        if (restartEnrollmentError) throw new Error(restartEnrollmentError.message);
        restartedAfterEmailFound++;
        continue;
      }
    }

    for (const task of tasks) {
      if (task.status !== "scheduled" && task.status !== "ready") continue;
      const step = stepById.get(task.stepId);
      if (!step) continue;
      const { error } = await client
        .from("outreach_send_tasks")
        .update({
          rendered_subject: step.subjectTemplate
            ? renderTemplate(step.subjectTemplate, refreshed)
            : null,
          rendered_body: renderTemplate(step.bodyTemplate, refreshed),
          meta: {
            ...task.meta,
            linkedin_action: step.linkedinAction,
            profile_url: refreshed.contactLinkedin,
          },
          updated_at: now,
        })
        .eq("id", task.id);
      if (error) throw new Error(error.message);
      pendingTasksRerendered++;
    }
  }

  return { synchronized, pendingTasksRerendered, restartedAfterEmailFound };
}

export type SequenceStepProgress = {
  position: number;
  channel: StepChannel;
  mode: StepMode;
  linkedinAction: LinkedinAction | null;
  /** Best task status for this step (none if not reached) */
  status: TaskStatus | "pending" | "none";
  error: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  /** Rendered email subject (email steps) */
  subject: string | null;
  /** Short preview of rendered body */
  bodySnippet: string | null;
};

export type SequenceLeadProgress = {
  enrollment: OutreachEnrollment;
  steps: SequenceStepProgress[];
  completedSteps: number;
  totalSteps: number;
  /** 0–100 */
  progressPct: number;
  lastTaskError: string | null;
};

export type SequenceHealth = {
  sequenceId: string;
  totalSteps: number;
  enrollments: {
    total: number;
    byStatus: Record<string, number>;
  };
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    email: Record<string, number>;
    linkedin: Record<string, number>;
  };
  rates: {
    /** bounced enrollments / total enrollments */
    bounceRate: number;
    /** failed email tasks / (sent+failed email tasks) */
    emailFailRate: number;
    /** skipped / (sent+skipped+failed) */
    skipRate: number;
    /** completed enrollments / total */
    completionRate: number;
  };
  recentErrors: Array<{
    contactName: string | null;
    companyName: string;
    channel: string;
    error: string;
    at: string;
    enrollmentStatus: string;
  }>;
  leads: SequenceLeadProgress[];
  steps: Array<{
    position: number;
    channel: StepChannel;
    mode: StepMode;
    linkedinAction: LinkedinAction | null;
  }>;
};

function emptyCountMap(keys: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const k of keys) m[k] = 0;
  return m;
}

/**
 * Health + per-lead progress for a sequence dashboard.
 */
export async function getSequenceHealth(
  client: SupabaseClient,
  sequenceId: string,
): Promise<SequenceHealth | null> {
  const detail = await getSequence(client, sequenceId);
  if (!detail) return null;
  const { steps } = detail;
  const enrollments = await listEnrollments(client, sequenceId);

  const enrByStatus = emptyCountMap([
    "active",
    "paused",
    "completed",
    "replied",
    "bounced",
    "failed",
    "cancelled",
  ]);
  for (const e of enrollments) {
    enrByStatus[e.status] = (enrByStatus[e.status] ?? 0) + 1;
  }

  const taskStatusKeys = [
    "scheduled",
    "ready",
    "sending",
    "sent",
    "failed",
    "skipped",
    "cancelled",
  ];
  const tasksByStatus = emptyCountMap(taskStatusKeys);
  const emailByStatus = emptyCountMap(taskStatusKeys);
  const linkedinByStatus = emptyCountMap(taskStatusKeys);

  const enrollmentIds = enrollments.map((e) => e.id);
  let allTasks: OutreachSendTask[] = [];
  if (enrollmentIds.length > 0) {
    // chunk in case of many enrollments
    const chunk = 100;
    for (let i = 0; i < enrollmentIds.length; i += chunk) {
      const slice = enrollmentIds.slice(i, i + chunk);
      const { data, error } = await client
        .from("outreach_send_tasks")
        .select("*")
        .in("enrollment_id", slice)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      allTasks = allTasks.concat(
        (data ?? []).map((r) => mapTask(r as Record<string, unknown>)),
      );
    }
  }

  for (const t of allTasks) {
    tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
    if (t.channel === "email") {
      emailByStatus[t.status] = (emailByStatus[t.status] ?? 0) + 1;
    } else {
      linkedinByStatus[t.status] = (linkedinByStatus[t.status] ?? 0) + 1;
    }
  }

  const enrTotal = enrollments.length || 1;
  const bounced = enrByStatus.bounced ?? 0;
  const completed = enrByStatus.completed ?? 0;
  const emailSent = emailByStatus.sent ?? 0;
  const emailFailed = emailByStatus.failed ?? 0;
  const emailSkipped = emailByStatus.skipped ?? 0;
  const emailDecided = emailSent + emailFailed + emailSkipped;
  const allDecided =
    (tasksByStatus.sent ?? 0) +
    (tasksByStatus.failed ?? 0) +
    (tasksByStatus.skipped ?? 0);

  const tasksByEnrollment = new Map<string, OutreachSendTask[]>();
  for (const t of allTasks) {
    const list = tasksByEnrollment.get(t.enrollmentId) ?? [];
    list.push(t);
    tasksByEnrollment.set(t.enrollmentId, list);
  }

  const stepById = new Map(steps.map((s) => [s.id, s]));

  const leads: SequenceLeadProgress[] = enrollments.map((enrollment) => {
    const tasks = tasksByEnrollment.get(enrollment.id) ?? [];
    // Best status per step position (prefer sent > failed > skipped > ready > scheduled)
    const rank = (s: TaskStatus | "pending" | "none") => {
      const order: Record<string, number> = {
        sent: 6,
        failed: 5,
        skipped: 4,
        sending: 3,
        ready: 2,
        scheduled: 1,
        cancelled: 0,
        pending: 0,
        none: -1,
      };
      return order[s] ?? 0;
    };
    const byPos = new Map<number, OutreachSendTask>();
    for (const t of tasks) {
      const step = stepById.get(t.stepId);
      const pos = step?.position ?? -1;
      if (pos < 0) continue;
      const prev = byPos.get(pos);
      if (!prev || rank(t.status) >= rank(prev.status)) byPos.set(pos, t);
    }

    const snippet = (body: string | null | undefined) => {
      if (!body?.trim()) return null;
      const one = body.replace(/\s+/g, " ").trim();
      return one.length > 160 ? `${one.slice(0, 160)}…` : one;
    };

    const stepProgress: SequenceStepProgress[] = steps.map((s) => {
      const t = byPos.get(s.position);
      if (!t) {
        // Not started: if current position passed this step and enrollment done, mark pending/none
        const reached =
          enrollment.status === "completed" ||
          enrollment.currentStepPosition > s.position ||
          (enrollment.currentStepPosition === s.position &&
            enrollment.status === "active");
        return {
          position: s.position,
          channel: s.channel,
          mode: s.mode,
          linkedinAction: s.linkedinAction,
          status: reached && enrollment.currentStepPosition === s.position
            ? "pending"
            : enrollment.currentStepPosition > s.position
              ? "pending"
              : "none",
          error: null,
          scheduledFor: null,
          sentAt: null,
          subject: null,
          bodySnippet: null,
        };
      }
      return {
        position: s.position,
        channel: s.channel,
        mode: s.mode,
        linkedinAction: t.step?.linkedinAction ?? s.linkedinAction,
        status: t.status,
        error: t.error,
        scheduledFor: t.scheduledFor,
        sentAt: t.sentAt,
        subject: t.renderedSubject,
        bodySnippet: snippet(t.renderedBody),
      };
    });

    const doneStatuses = new Set(["sent", "skipped", "failed", "cancelled"]);
    const completedSteps = stepProgress.filter((s) =>
      doneStatuses.has(s.status),
    ).length;
    const totalSteps = steps.length;
    const progressPct =
      totalSteps === 0
        ? 0
        : enrollment.status === "completed"
          ? 100
          : Math.round((completedSteps / totalSteps) * 100);

    const lastTaskError =
      enrollment.lastError ??
      [...tasks]
        .reverse()
        .find((t) => t.error)?.error ??
      null;

    return {
      enrollment,
      steps: stepProgress,
      completedSteps,
      totalSteps,
      progressPct,
      lastTaskError,
    };
  });

  // Recent errors: failed tasks + bounced enrollments
  const recentErrors: SequenceHealth["recentErrors"] = [];
  for (const t of [...allTasks].reverse()) {
    if (t.status !== "failed" && !(t.status === "skipped" && t.error)) continue;
    if (!t.error) continue;
    const enr = enrollments.find((e) => e.id === t.enrollmentId);
    if (!enr) continue;
    recentErrors.push({
      contactName: enr.contactName,
      companyName: enr.companyName,
      channel: t.channel,
      error: t.error,
      at: t.updatedAt || t.sentAt || t.createdAt,
      enrollmentStatus: enr.status,
    });
    if (recentErrors.length >= 25) break;
  }
  for (const e of enrollments) {
    if (e.status !== "bounced" && e.status !== "failed") continue;
    if (!e.lastError) continue;
    if (recentErrors.some((r) => r.error === e.lastError && r.companyName === e.companyName))
      continue;
    recentErrors.unshift({
      contactName: e.contactName,
      companyName: e.companyName,
      channel: "email",
      error: e.lastError,
      at: e.updatedAt,
      enrollmentStatus: e.status,
    });
  }

  return {
    sequenceId,
    totalSteps: steps.length,
    enrollments: {
      total: enrollments.length,
      byStatus: enrByStatus,
    },
    tasks: {
      total: allTasks.length,
      byStatus: tasksByStatus,
      email: emailByStatus,
      linkedin: linkedinByStatus,
    },
    rates: {
      bounceRate: Math.round((bounced / enrTotal) * 1000) / 10,
      emailFailRate:
        emailDecided === 0
          ? 0
          : Math.round((emailFailed / emailDecided) * 1000) / 10,
      skipRate:
        allDecided === 0
          ? 0
          : Math.round(((tasksByStatus.skipped ?? 0) / allDecided) * 1000) / 10,
      completionRate: Math.round((completed / enrTotal) * 1000) / 10,
    },
    recentErrors: recentErrors.slice(0, 25),
    leads,
    steps: steps.map((s) => ({
      position: s.position,
      channel: s.channel,
      mode: s.mode,
      linkedinAction: s.linkedinAction,
    })),
  };
}
