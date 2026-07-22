import type { SupabaseClient } from "@supabase/supabase-js";

import { renderTemplate } from "@/lib/outreach/renderer";
import type {
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
    createdByEmail: (r.created_by_email as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapStep(r: Record<string, unknown>): OutreachSequenceStep {
  return {
    id: r.id as string,
    sequenceId: r.sequence_id as string,
    position: Number(r.position),
    channel: r.channel as StepChannel,
    mode: r.mode as StepMode,
    delayHours: Number(r.delay_hours ?? 0),
    linkedinAction: (r.linkedin_action as LinkedinAction | null) ?? null,
    subjectTemplate: (r.subject_template as string | null) ?? null,
    bodyTemplate: (r.body_template as string) ?? "",
    stopOnReply: Boolean(r.stop_on_reply ?? true),
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

export async function createSequence(
  client: SupabaseClient,
  input: {
    name: string;
    description?: string | null;
    createdByEmail?: string | null;
    defaultFromEmail?: string | null;
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
  }>,
): Promise<OutreachSequenceStep[]> {
  // LinkedIn auto not supported in v1 — force semi
  const normalized = steps.map((s, i) => {
    const mode: StepMode =
      s.channel === "linkedin" ? "semi" : s.mode === "semi" ? "semi" : "auto";
    if (s.channel === "linkedin" && !s.linkedinAction) {
      throw new Error(`Step ${i + 1}: linkedin_action required`);
    }
    if (s.channel === "email" && mode === "auto" && !s.bodyTemplate.trim()) {
      throw new Error(`Step ${i + 1}: body_template required`);
    }
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
    };
  });

  await client.from("outreach_sequence_steps").delete().eq("sequence_id", sequenceId);
  if (normalized.length === 0) return [];

  const { data, error } = await client
    .from("outreach_sequence_steps")
    .insert(normalized)
    .select("*");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapStep(r as Record<string, unknown>));
}

export async function updateSequence(
  client: SupabaseClient,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: SequenceStatus;
    defaultFromEmail?: string | null;
  },
): Promise<OutreachSequence> {
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name != null) body.name = patch.name.trim();
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.status != null) body.status = patch.status;
  if (patch.defaultFromEmail !== undefined) {
    body.default_from_email = patch.defaultFromEmail;
  }
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

  const { data: enr, error } = await client
    .from("outreach_enrollments")
    .insert({
      sequence_id: sequenceId,
      source: snap.source,
      outreach_prospect_id: snap.outreachProspectId ?? null,
      research_row_id: snap.researchRowId ?? null,
      research_person_id: snap.researchPersonId ?? null,
      company_name: snap.companyName,
      domain: snap.domain,
      contact_name: snap.contactName,
      contact_email: snap.contactEmail,
      contact_linkedin: snap.contactLinkedin,
      contact_role: snap.contactRole,
      status: "active",
      current_step_position: firstStep.position,
      next_run_at: new Date().toISOString(),
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
  let task = await createTaskForStep(
    client,
    enrollment,
    firstStep,
    new Date(),
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

  const seqNameCache = new Map<string, string>();
  const seqStatusCache = new Map<string, SequenceStatus | null>();
  const live: OutreachSendTask[] = [];

  for (const t of tasks) {
    const { data: enr } = await client
      .from("outreach_enrollments")
      .select("*")
      .eq("id", t.enrollmentId)
      .maybeSingle();
    const { data: step } = await client
      .from("outreach_sequence_steps")
      .select("*")
      .eq("id", t.stepId)
      .maybeSingle();
    if (enr) {
      t.enrollment = mapEnrollment(enr as Record<string, unknown>);
      const seqId = t.enrollment.sequenceId;
      if (seqId) {
        if (!seqNameCache.has(seqId)) {
          const { data: seq } = await client
            .from("outreach_sequences")
            .select("name, status")
            .eq("id", seqId)
            .maybeSingle();
          seqNameCache.set(seqId, (seq?.name as string) ?? "Sequence");
          seqStatusCache.set(
            seqId,
            (seq?.status as SequenceStatus | undefined) ?? null,
          );
        }
        if (!seqStatusCache.has(seqId)) {
          seqStatusCache.set(seqId, await getSequenceStatus(client, seqId));
        }
        // Hide tasks from draft/paused/archived sequences
        if (seqStatusCache.get(seqId) !== "active") {
          continue;
        }
        t.sequenceName = seqNameCache.get(seqId) ?? null;
      }
    }
    if (step) t.step = mapStep(step as Record<string, unknown>);
    live.push(t);
  }
  return live;
}

/** Counts for the daily activity board. */
export async function getActivityStats(
  client: SupabaseClient,
): Promise<{
  readyLinkedin: number;
  readyEmail: number;
  readyTotal: number;
  sentToday: number;
  skippedToday: number;
  emailAutoSend: boolean;
}> {
  const { isEmailAutoSendEnabled } = await import("@/lib/outreach/mailbox");
  const emailAutoSend = await isEmailAutoSendEnabled(client);

  const { count: readyLinkedin } = await client
    .from("outreach_send_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "ready")
    .eq("channel", "linkedin");
  const { count: readyEmail } = await client
    .from("outreach_send_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "ready")
    .eq("channel", "email");

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const startIso = start.toISOString();

  const { count: sentToday } = await client
    .from("outreach_send_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .gte("sent_at", startIso);
  const { count: skippedToday } = await client
    .from("outreach_send_tasks")
    .select("id", { count: "exact", head: true })
    .eq("status", "skipped")
    .gte("sent_at", startIso);

  const li = readyLinkedin ?? 0;
  const em = readyEmail ?? 0;
  return {
    readyLinkedin: li,
    readyEmail: em,
    readyTotal: li + em,
    sentToday: sentToday ?? 0,
    skippedToday: skippedToday ?? 0,
    emailAutoSend,
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

  const when = new Date(Date.now() + next.delayHours * 3600 * 1000);
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
): Promise<{
  promoted: number;
  emailsSent: number;
  emailsFailed: number;
  emailsSkipped: number;
}> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("outreach_send_tasks")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_for", now)
    .limit(100);
  if (error) throw new Error(error.message);

  let promoted = 0;
  let emailsSent = 0;
  let emailsFailed = 0;
  let emailsSkipped = 0;

  for (const raw of data ?? []) {
    const task = mapTask(raw as Record<string, unknown>);

    // Respect sequence status: only active sequences run / hit the queue
    const { data: enrRaw } = await client
      .from("outreach_enrollments")
      .select("sequence_id, status")
      .eq("id", task.enrollmentId)
      .maybeSingle();
    if (!enrRaw) continue;
    if ((enrRaw.status as string) !== "active") continue;
    const seqStatus = await getSequenceStatus(
      client,
      enrRaw.sequence_id as string,
    );
    if (seqStatus !== "active") {
      // leave scheduled — will resume when sequence is activated
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
      const auto = await isEmailAutoSendEnabled(client);
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
      const result = await sendDueEmailTask(client, task);
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

  return { promoted, emailsSent, emailsFailed, emailsSkipped };
}

async function sendDueEmailTask(
  client: SupabaseClient,
  task: OutreachSendTask,
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
  const subject = task.renderedSubject ?? "";
  const body = task.renderedBody ?? "";

  const send = await sendOutreachEmail(client, {
    to,
    subject,
    text: body,
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

  await client
    .from("outreach_send_tasks")
    .update({
      status: "sent",
      sent_at: now,
      provider: "smtp",
      provider_message_id: send.messageId,
      error: null,
      updated_at: now,
      meta: {
        ...(task.meta ?? {}),
        mailbox_id: send.mailboxId,
        from: send.from,
      },
    })
    .eq("id", task.id);

  await advanceEnrollment(client, enrollment.id);

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
        };
      }
      return {
        position: s.position,
        channel: s.channel,
        mode: s.mode,
        linkedinAction: s.linkedinAction,
        status: t.status,
        error: t.error,
        scheduledFor: t.scheduledFor,
        sentAt: t.sentAt,
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


