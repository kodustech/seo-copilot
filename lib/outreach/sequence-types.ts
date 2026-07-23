export type SequenceStatus = "draft" | "active" | "paused" | "archived";
export type StepChannel = "email" | "linkedin";
export type StepMode = "auto" | "semi";
export type LinkedinAction = "connect_note" | "message";
/** Email steps only: open a new thread or reply to the last email in this enrollment. */
export type EmailThreadMode = "new" | "reply";
export type EnrollmentSource = "research" | "outreach" | "manual";
export type EnrollmentStatus =
  | "active"
  | "paused"
  | "completed"
  | "replied"
  | "bounced"
  | "failed"
  | "cancelled";
export type TaskStatus =
  | "scheduled"
  | "ready"
  | "sending"
  | "sent"
  | "failed"
  | "skipped"
  | "cancelled";

export type OutreachSequence = {
  id: string;
  name: string;
  description: string | null;
  status: SequenceStatus;
  defaultFromEmail: string | null;
  mailboxId: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
  stepCount?: number;
  enrollmentCount?: number;
};

export type OutreachSequenceStep = {
  id: string;
  sequenceId: string;
  position: number;
  channel: StepChannel;
  mode: StepMode;
  delayHours: number;
  linkedinAction: LinkedinAction | null;
  subjectTemplate: string | null;
  bodyTemplate: string;
  stopOnReply: boolean;
  /** email only; null on linkedin steps */
  emailThreadMode: EmailThreadMode | null;
  createdAt: string;
};

export type OutreachEnrollment = {
  id: string;
  sequenceId: string;
  source: EnrollmentSource;
  outreachProspectId: string | null;
  researchRowId: string | null;
  researchPersonId: string | null;
  companyName: string;
  domain: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactLinkedin: string | null;
  contactRole: string | null;
  status: EnrollmentStatus;
  currentStepPosition: number;
  nextRunAt: string | null;
  lastError: string | null;
  enrolledByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutreachSendTask = {
  id: string;
  enrollmentId: string;
  stepId: string;
  channel: StepChannel;
  mode: StepMode;
  status: TaskStatus;
  scheduledFor: string;
  renderedSubject: string | null;
  renderedBody: string | null;
  provider: string | null;
  providerMessageId: string | null;
  sentAt: string | null;
  sentByEmail: string | null;
  error: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // joined
  enrollment?: OutreachEnrollment;
  step?: OutreachSequenceStep;
  sequenceName?: string | null;
};
