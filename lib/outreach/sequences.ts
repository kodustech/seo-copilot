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
  return mapSequence(data as Record<string, unknown>);
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
): Promise<{ enrollment: OutreachEnrollment; task: OutreachSendTask } | null> {
  // Need contact path for first step
  if (firstStep.channel === "email" && !snap.contactEmail) {
    return null;
  }
  if (firstStep.channel === "linkedin" && !snap.contactLinkedin && !snap.contactName) {
    // allow name-only for semi (user finds profile); better with URL
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

  const enrollment = mapEnrollment(enr as Record<string, unknown>);
  const task = await createTaskForStep(client, enrollment, firstStep, new Date());
  return { enrollment, task };
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
  let status: OutreachSendTask["status"] = "scheduled";
  // If already due, LI semi goes straight to the human queue.
  if (step.channel === "linkedin" && step.mode === "semi" && due.getTime() <= Date.now() + 1000) {
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
      provider:
        step.channel === "email"
          ? step.mode === "auto"
            ? "resend"
            : "manual"
          : "linkedin_semi",
      meta: {
        linkedin_action: step.linkedinAction,
        profile_url: enrollment.contactLinkedin,
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
): Promise<{ enrolled: number; skipped: number; errors: string[] }> {
  const seq = await getSequence(client, input.sequenceId);
  if (!seq) throw new Error("Sequence not found");
  if (seq.steps.length === 0) throw new Error("Sequence has no steps");
  const first = seq.steps[0];

  const table = await resolveTable(client, input.tableRef);
  let rows = await listRows(client, table.id);
  if (input.rowIds?.length) {
    const set = new Set(input.rowIds);
    rows = rows.filter((r) => set.has(r.id));
  }

  let enrolled = 0;
  let skipped = 0;
  const errors: string[] = [];

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
        );
        if (result) enrolled += 1;
        else skipped += 1;
      } catch (err) {
        skipped += 1;
        errors.push(
          `${row.companyName}: ${err instanceof Error ? err.message : "fail"}`,
        );
      }
    }
  }

  // activate sequence if still draft
  if (seq.sequence.status === "draft" && enrolled > 0) {
    await updateSequence(client, input.sequenceId, { status: "active" });
  }

  return { enrolled, skipped, errors: errors.slice(0, 20) };
}

export async function enrollFromProspects(
  client: SupabaseClient,
  input: {
    sequenceId: string;
    prospectIds: string[];
    enrolledByEmail?: string | null;
  },
): Promise<{ enrolled: number; skipped: number; errors: string[] }> {
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
      );
      if (result) enrolled += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      errors.push(err instanceof Error ? err.message : "fail");
    }
  }

  if (seq.sequence.status === "draft" && enrolled > 0) {
    await updateSequence(client, input.sequenceId, { status: "active" });
  }

  return { enrolled, skipped, errors: errors.slice(0, 20) };
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
    .limit(opts.limit ?? 50);
  if (opts.channel) q = q.eq("channel", opts.channel);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const tasks = (data ?? []).map((r) => mapTask(r as Record<string, unknown>));

  // join enrollment + step
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
    if (enr) t.enrollment = mapEnrollment(enr as Record<string, unknown>);
    if (step) t.step = mapStep(step as Record<string, unknown>);
  }
  return tasks;
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
  await createTaskForStep(client, enrollment, next, when);

  // if next is linkedin semi and delay is 0 / past, already ready
  // if email auto in future, processDue will handle

  // If linkedin and scheduled in past... createTaskForStep sets ready for LI always
  // For delayed LI, should stay scheduled until due — fix createTaskForStep
  // Actually for delay > 0 linkedin we need scheduled first. Fix below in runner.

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

  return data ? mapEnrollment(data as Record<string, unknown>) : enrollment;
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
        last_error: send.error,
        updated_at: now,
      })
      .eq("id", enrollment.id);
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
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapEnrollment(r as Record<string, unknown>));
}


