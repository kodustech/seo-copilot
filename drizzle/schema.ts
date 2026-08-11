import { pgTable, index, uniqueIndex, foreignKey, pgPolicy, check, uuid, text, integer, date, timestamp, boolean, unique, bigint, jsonb, smallint, numeric, varchar, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const goals = pgTable("goals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	description: text(),
	unit: text(),
	targetCount: integer("target_count").default(1).notNull(),
	currentCount: integer("current_count").default(0).notNull(),
	periodStart: date("period_start").notNull(),
	periodEnd: date("period_end").notNull(),
	status: text().default('active').notNull(),
	priority: text().default('medium').notNull(),
	responsibleEmail: text("responsible_email"),
	projectRef: text("project_ref"),
	notes: text(),
	createdByEmail: text("created_by_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	kind: text().default('output').notNull(),
	recurrenceId: uuid("recurrence_id"),
}, (table) => [
	index("goals_period_idx").using("btree", table.periodStart.asc().nullsLast().op("date_ops"), table.periodEnd.asc().nullsLast().op("date_ops")),
	uniqueIndex("goals_recurrence_period_uidx").using("btree", table.recurrenceId.asc().nullsLast().op("date_ops"), table.periodStart.asc().nullsLast().op("uuid_ops")).where(sql`(recurrence_id IS NOT NULL)`),
	index("goals_responsible_idx").using("btree", table.responsibleEmail.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("goals_status_idx").using("btree", table.status.asc().nullsLast().op("date_ops"), table.periodEnd.desc().nullsFirst().op("date_ops")),
	foreignKey({
			columns: [table.recurrenceId],
			foreignColumns: [goalRecurrences.id],
			name: "goals_recurrence_id_fkey"
		}).onDelete("set null"),
	pgPolicy("Service role can manage goals", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("Authenticated users can write goals", { as: "permissive", for: "all", to: ["authenticated"] }),
	pgPolicy("Authenticated users can read goals", { as: "permissive", for: "select", to: ["authenticated"] }),
	check("goals_kind_check", sql`kind = ANY (ARRAY['input'::text, 'output'::text])`),
	check("goals_priority_check", sql`priority = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])`),
	check("goals_status_check", sql`status = ANY (ARRAY['active'::text, 'completed'::text, 'missed'::text, 'paused'::text, 'archived'::text])`),
]);

export const goalRecurrences = pgTable("goal_recurrences", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	description: text(),
	unit: text(),
	targetCount: integer("target_count").default(1).notNull(),
	kind: text().default('output').notNull(),
	priority: text().default('medium').notNull(),
	cadence: text().notNull(),
	active: boolean().default(true).notNull(),
	responsibleEmail: text("responsible_email"),
	projectRef: text("project_ref"),
	notes: text(),
	createdByEmail: text("created_by_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("goal_recurrences_active_idx").using("btree", table.active.asc().nullsLast().op("text_ops"), table.cadence.asc().nullsLast().op("text_ops")),
	pgPolicy("Service role can manage goal_recurrences", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("Authenticated users can write goal_recurrences", { as: "permissive", for: "all", to: ["authenticated"] }),
	pgPolicy("Authenticated users can read goal_recurrences", { as: "permissive", for: "select", to: ["authenticated"] }),
	check("goal_recurrences_cadence_check", sql`cadence = ANY (ARRAY['weekly'::text, 'monthly'::text])`),
	check("goal_recurrences_kind_check", sql`kind = ANY (ARRAY['input'::text, 'output'::text])`),
	check("goal_recurrences_priority_check", sql`priority = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])`),
]);

export const jobRuns = pgTable("job_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	jobId: uuid("job_id").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	status: text().default('running'),
	resultSummary: text("result_summary"),
	error: text(),
	webhookStatus: integer("webhook_status"),
}, (table) => [
	index("idx_job_runs_job_id").using("btree", table.jobId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [scheduledJobs.id],
			name: "job_runs_job_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("Users can read own job_runs", { as: "permissive", for: "select", to: ["authenticated"], using: sql`(EXISTS ( SELECT 1
   FROM scheduled_jobs sj
  WHERE ((sj.id = job_runs.job_id) AND (sj.user_email = ( SELECT (auth.jwt() ->> 'email'::text))))))` }),
	pgPolicy("Service role manages job_runs", { as: "permissive", for: "all", to: ["service_role"] }),
	check("job_runs_status_check", sql`status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])`),
]);

export const linkedinCommenterTriggers = pgTable("linkedin_commenter_triggers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	commenterId: uuid("commenter_id").notNull(),
	commentId: text("comment_id").notNull(),
	postUrl: text("post_url").notNull(),
	activityId: text("activity_id"),
	postSocialId: text("post_social_id"),
	commentText: text("comment_text"),
	commentedAt: timestamp("commented_at", { withTimezone: true, mode: 'string' }),
	isReply: boolean("is_reply").default(false).notNull(),
	reactionCount: integer("reaction_count"),
	replyCount: integer("reply_count"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("linkedin_commenter_triggers_commenter_idx").using("btree", table.commenterId.asc().nullsLast().op("timestamptz_ops"), table.commentedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("linkedin_commenter_triggers_post_idx").using("btree", table.postUrl.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.commenterId],
			foreignColumns: [linkedinCommenters.id],
			name: "linkedin_commenter_triggers_commenter_id_fkey"
		}).onDelete("cascade"),
	unique("linkedin_commenter_triggers_comment_key").on(table.commentId, table.commenterId),
	pgPolicy("linkedin_commenter_triggers_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`true` }),
]);

export const llmMentionsSnapshots = pgTable("llm_mentions_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	snapshotDate: date("snapshot_date").notNull(),
	platform: text().notNull(),
	mentions: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	aiSearchVolume: bigint("ai_search_volume", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	impressions: bigint({ mode: "number" }).default(0).notNull(),
	topSources: jsonb("top_sources").default([]).notNull(),
	topQuestions: jsonb("top_questions").default([]).notNull(),
	rawResponse: jsonb("raw_response"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_llm_mentions_snapshots_latest").using("btree", table.snapshotDate.desc().nullsFirst().op("date_ops"), table.platform.asc().nullsLast().op("text_ops")),
	unique("llm_mentions_snapshots_snapshot_date_platform_key").on(table.platform, table.snapshotDate),
	pgPolicy("Service role can manage snapshots", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("Authenticated users can read snapshots", { as: "permissive", for: "select", to: ["authenticated"] }),
	check("llm_mentions_snapshots_platform_check", sql`platform = ANY (ARRAY['google'::text, 'chat_gpt'::text])`),
]);

export const outreachSettings = pgTable("outreach_settings", {
	id: text().default('default').primaryKey().notNull(),
	sendingDays: smallint("sending_days").array().default([1, 2, 3, 4, 5]).notNull(),
	timezone: text().default('America/Sao_Paulo').notNull(),
	updatedByEmail: text("updated_by_email"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	check("outreach_settings_id_check", sql`id = 'default'::text`),
	check("outreach_settings_sending_days_not_empty", sql`array_length(sending_days, 1) >= 1`),
	check("outreach_settings_sending_days_range", sql`sending_days <@ '{0,1,2,3,4,5,6}'::smallint[]`),
]);

export const outreachSequenceSnapshots = pgTable("outreach_sequence_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	sequenceId: uuid("sequence_id").notNull(),
	reason: text().default('save').notNull(),
	sequenceData: jsonb("sequence_data").notNull(),
	stepsData: jsonb("steps_data").default([]).notNull(),
	enrollmentsData: jsonb("enrollments_data").default([]).notNull(),
	tasksData: jsonb("tasks_data").default([]).notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("outreach_sequence_snapshots_sequence_idx").using("btree", table.sequenceId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("outreach_sequence_snapshots_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_sequence_snapshots_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
]);

export const xReplyDrafts = pgTable("x_reply_drafts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	candidateId: uuid("candidate_id").notNull(),
	userEmail: text("user_email").notNull(),
	position: integer().notNull(),
	angle: text().notNull(),
	draftText: text("draft_text").notNull(),
	selected: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("x_reply_drafts_candidate_position_uidx").using("btree", table.candidateId.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
	index("x_reply_drafts_user_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.candidateId],
			foreignColumns: [xReplyCandidates.id],
			name: "x_reply_drafts_candidate_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("x_reply_drafts_update_own", { as: "permissive", for: "update", to: ["public"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))`, withCheck: sql`(user_email = (auth.jwt() ->> 'email'::text))`  }),
	pgPolicy("x_reply_drafts_select_own", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("x_reply_drafts_insert_own", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("x_reply_drafts_delete_own", { as: "permissive", for: "delete", to: ["public"] }),
	check("x_reply_drafts_angle_check", sql`angle = ANY (ARRAY['contrarian'::text, 'add_specificity'::text, 'sharp_question'::text])`),
]);

export const xTargetAccounts = pgTable("x_target_accounts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	xUsername: text("x_username").notNull(),
	xUserId: text("x_user_id").notNull(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	enabled: boolean().default(true).notNull(),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("x_target_accounts_user_enabled_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops"), table.enabled.asc().nullsLast().op("text_ops")),
	uniqueIndex("x_target_accounts_user_username_uidx").using("btree", sql`user_email`, sql`lower(x_username)`),
	pgPolicy("x_target_accounts_update_own", { as: "permissive", for: "update", to: ["public"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))`, withCheck: sql`(user_email = (auth.jwt() ->> 'email'::text))`  }),
	pgPolicy("x_target_accounts_insert_own", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("x_target_accounts_delete_own", { as: "permissive", for: "delete", to: ["public"] }),
	pgPolicy("x_target_accounts_select_own", { as: "permissive", for: "select", to: ["public"] }),
]);

export const brandVoiceProfiles = pgTable("brand_voice_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	scope: text().default('kodus').notNull(),
	tone: text(),
	persona: text(),
	writingGuidelines: text("writing_guidelines"),
	preferredWords: text("preferred_words").array().default([""]).notNull(),
	forbiddenWords: text("forbidden_words").array().default([""]).notNull(),
	additionalInstructions: text("additional_instructions"),
	updatedBy: text("updated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	worldview: text(),
	competitorDomains: text("competitor_domains").array().default([""]).notNull(),
}, (table) => [
	uniqueIndex("brand_voice_profiles_scope_uidx").using("btree", table.scope.asc().nullsLast().op("text_ops")),
	unique("brand_voice_profiles_scope_key").on(table.scope),
	pgPolicy("brand_voice_profiles_select_authenticated", { as: "permissive", for: "select", to: ["public"], using: sql`(auth.role() = 'authenticated'::text)` }),
]);

export const crmActivities = pgTable("crm_activities", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	companyId: uuid("company_id").notNull(),
	kind: text().notNull(),
	summary: text(),
	meta: jsonb().default({}),
	actorEmail: text("actor_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("crm_activities_company_idx").using("btree", table.companyId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("crm_activities_promote_note_uq").using("btree", sql`company_id`, sql`((meta ->> 'enrollment_id'::text))`, sql`((meta ->> 'reason'::text))`).where(sql`((kind = 'note'::text) AND ((meta ->> 'enrollment_id'::text) IS NOT NULL))`),
	foreignKey({
			columns: [table.companyId],
			foreignColumns: [crmCompanies.id],
			name: "crm_activities_company_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("crm_activities_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("crm_activities_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("crm_activities_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("crm_activities_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const researchRows = pgTable("research_rows", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tableId: uuid("table_id").notNull(),
	companyName: text("company_name").notNull(),
	domain: text(),
	source: text().default('manual').notNull(),
	status: text().default('pending').notNull(),
	icpScore: numeric("icp_score"),
	triggerScore: numeric("trigger_score"),
	fitScore: numeric("fit_score"),
	antiFlags: text("anti_flags").array().default([""]),
	whyNow: text("why_now"),
	pass: boolean(),
	packRaw: jsonb("pack_raw").default({}),
	lastResearchedAt: timestamp("last_researched_at", { withTimezone: true, mode: 'string' }),
	error: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	cells: jsonb().default({}).notNull(),
}, (table) => [
	uniqueIndex("research_rows_table_domain_uniq").using("btree", sql`table_id`, sql`lower(domain)`).where(sql`(domain IS NOT NULL)`),
	index("research_rows_table_score_idx").using("btree", table.tableId.asc().nullsLast().op("numeric_ops"), table.icpScore.desc().nullsLast().op("numeric_ops")),
	index("research_rows_table_status_idx").using("btree", table.tableId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.tableId],
			foreignColumns: [researchTables.id],
			name: "research_rows_table_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("research_rows_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("research_rows_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("research_rows_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("research_rows_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const keywords = pgTable("keywords", {
	id: uuid().default(sql`extensions.uuid_generate_v4()`).primaryKey().notNull(),
	keyword: text().notNull(),
	searchVolume: numeric("search_volume"),
	cpc: numeric(),
	competition: text(),
	idea: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taskId: bigint("task_id", { mode: "number" }),
	language: varchar(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	locationCode: bigint("location_code", { mode: "number" }),
}, (table) => [
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [task.id],
			name: "keywords_task_id_fkey"
		}).onDelete("cascade"),
]);

export const userVoiceProfiles = pgTable("user_voice_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	tone: text(),
	persona: text(),
	writingGuidelines: text("writing_guidelines"),
	preferredWords: text("preferred_words").array().default([""]).notNull(),
	forbiddenWords: text("forbidden_words").array().default([""]).notNull(),
	additionalInstructions: text("additional_instructions"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	worldview: text(),
}, (table) => [
	uniqueIndex("user_voice_profiles_user_email_uidx").using("btree", table.userEmail.asc().nullsLast().op("text_ops")),
	unique("user_voice_profiles_user_email_key").on(table.userEmail),
	pgPolicy("user_voice_profiles_update_own", { as: "permissive", for: "update", to: ["public"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))`, withCheck: sql`(user_email = (auth.jwt() ->> 'email'::text))`  }),
	pgPolicy("user_voice_profiles_select_own", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("user_voice_profiles_insert_own", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("user_voice_profiles_delete_own", { as: "permissive", for: "delete", to: ["public"] }),
]);

export const crmStatusSla = pgTable("crm_status_sla", {
	status: text().primaryKey().notNull(),
	idleDays: integer("idle_days").default(14).notNull(),
	label: text(),
}, (table) => [
	pgPolicy("crm_status_sla_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("crm_status_sla_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("crm_status_sla_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("crm_status_sla_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const crmFieldDefs = pgTable("crm_field_defs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	key: text().notNull(),
	label: text().notNull(),
	type: text().notNull(),
	options: jsonb().default([]).notNull(),
	position: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("crm_field_defs_position_idx").using("btree", table.position.asc().nullsLast().op("int4_ops"), table.label.asc().nullsLast().op("int4_ops")),
	unique("crm_field_defs_key_uniq").on(table.key),
	pgPolicy("crm_field_defs_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("crm_field_defs_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("crm_field_defs_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("crm_field_defs_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("crm_field_defs_type_check", sql`type = ANY (ARRAY['text'::text, 'number'::text, 'boolean'::text, 'select'::text])`),
]);

export const articles = pgTable("articles", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "articles_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taskId: bigint("task_id", { mode: "number" }).notNull(),
	url: varchar(),
	keywordId: uuid("keyword_id").defaultRandom(),
}, (table) => [
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [task.id],
			name: "articles_task_id_fkey"
		}),
	foreignKey({
			columns: [table.keywordId],
			foreignColumns: [keywords.id],
			name: "articles_keyword_id_fkey"
		}),
]);

export const conversations = pgTable("conversations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	title: text().default('Nova conversa').notNull(),
	messages: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_conversations_updated_at").using("btree", table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_conversations_user_email").using("btree", table.userEmail.asc().nullsLast().op("text_ops")),
	pgPolicy("Users can write own conversations", { as: "permissive", for: "all", to: ["authenticated"], using: sql`(user_email = ( SELECT (auth.jwt() ->> 'email'::text)))`, withCheck: sql`(user_email = ( SELECT (auth.jwt() ->> 'email'::text)))`  }),
	pgPolicy("Users can read own conversations", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("Service role manages conversations", { as: "permissive", for: "all", to: ["service_role"] }),
]);

export const calendarItems = pgTable("calendar_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	title: text().notNull(),
	notes: text(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('planned').notNull(),
	sourceType: text("source_type").default('idea').notNull(),
	sourceId: text("source_id"),
	postType: text("post_type"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("calendar_items_starts_at_idx").using("btree", table.startsAt.asc().nullsLast().op("timestamptz_ops")),
	index("calendar_items_user_email_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops")),
	pgPolicy("calendar_items_update_own", { as: "permissive", for: "update", to: ["public"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))`, withCheck: sql`(user_email = (auth.jwt() ->> 'email'::text))`  }),
	pgPolicy("calendar_items_select_own", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("calendar_items_delete_own", { as: "permissive", for: "delete", to: ["public"] }),
	pgPolicy("calendar_items_insert_own", { as: "permissive", for: "insert", to: ["public"] }),
	check("calendar_items_post_type_check", sql`post_type = ANY (ARRAY['article'::text, 'social'::text])`),
	check("calendar_items_source_type_check", sql`source_type = ANY (ARRAY['idea'::text, 'task'::text, 'campaign'::text])`),
	check("calendar_items_status_check", sql`status = ANY (ARRAY['planned'::text, 'done'::text, 'canceled'::text])`),
]);

export const crmCompanies = pgTable("crm_companies", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	domain: text(),
	orgId: text("org_id"),
	status: text().default('lead').notNull(),
	priority: text().default('medium').notNull(),
	ownerEmail: text("owner_email"),
	industry: text(),
	size: text(),
	country: text(),
	website: text(),
	linkedin: text(),
	arr: numeric(),
	tags: text().array().default([""]),
	enrichment: jsonb().default({}),
	source: text().default('manual'),
	notes: text(),
	lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	createdByEmail: text("created_by_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	devCount: integer("dev_count"),
	properties: jsonb().default({}).notNull(),
	tier: text(),
	deployment: text(),
	trigger: text(),
	prepStatus: text("prep_status").default('not_started').notNull(),
	lastOutreachAt: timestamp("last_outreach_at", { withTimezone: true, mode: 'string' }),
	outreachSentCount: integer("outreach_sent_count").default(0).notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("crm_companies_active_idx").using("btree", table.lastActivityAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(archived_at IS NULL)`),
	index("crm_companies_deployment_idx").using("btree", table.deployment.asc().nullsLast().op("text_ops")).where(sql`(deployment IS NOT NULL)`),
	uniqueIndex("crm_companies_domain_uniq").using("btree", sql`lower(domain)`).where(sql`(domain IS NOT NULL)`),
	index("crm_companies_last_activity_idx").using("btree", table.lastActivityAt.asc().nullsLast().op("timestamptz_ops")),
	index("crm_companies_last_outreach_at_idx").using("btree", table.lastOutreachAt.desc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("crm_companies_org_id_uniq").using("btree", table.orgId.asc().nullsLast().op("text_ops")).where(sql`(org_id IS NOT NULL)`),
	index("crm_companies_prep_status_idx").using("btree", table.prepStatus.asc().nullsLast().op("text_ops")).where(sql`(prep_status = ANY (ARRAY['not_started'::text, 'enriched'::text, 'ready'::text]))`),
	index("crm_companies_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("crm_companies_tier_idx").using("btree", table.tier.asc().nullsLast().op("text_ops")).where(sql`(tier IS NOT NULL)`),
	index("crm_companies_trigger_idx").using("btree", table.trigger.asc().nullsLast().op("text_ops")).where(sql`(trigger IS NOT NULL)`),
	pgPolicy("crm_companies_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("crm_companies_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("crm_companies_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("crm_companies_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("crm_companies_prep_status_check", sql`prep_status = ANY (ARRAY['not_started'::text, 'enriched'::text, 'ready'::text, 'parked'::text])`),
]);

export const crmComments = pgTable("crm_comments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	companyId: uuid("company_id").notNull(),
	authorEmail: text("author_email"),
	bodyMd: text("body_md").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("crm_comments_company_idx").using("btree", table.companyId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.companyId],
			foreignColumns: [crmCompanies.id],
			name: "crm_comments_company_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("crm_comments_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("crm_comments_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("crm_comments_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("crm_comments_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const researchTables = pgTable("research_tables", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	rubricId: text("rubric_id").default('qe-kodus-v1').notNull(),
	description: text(),
	createdByEmail: text("created_by_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	rubricJson: jsonb("rubric_json"),
	slug: text(),
	columns: jsonb().default([]).notNull(),
}, (table) => [
	uniqueIndex("research_tables_slug_uniq").using("btree", table.slug.asc().nullsLast().op("text_ops")).where(sql`(slug IS NOT NULL)`),
	pgPolicy("research_tables_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("research_tables_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("research_tables_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("research_tables_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const scheduledJobs = pgTable("scheduled_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	name: text().notNull(),
	prompt: text().notNull(),
	cronExpression: text("cron_expression").notNull(),
	webhookUrl: text("webhook_url").notNull(),
	enabled: boolean().default(true),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_scheduled_jobs_enabled").using("btree", table.enabled.asc().nullsLast().op("bool_ops")).where(sql`(enabled = true)`),
	pgPolicy("Users can write own scheduled_jobs", { as: "permissive", for: "all", to: ["authenticated"], using: sql`(user_email = ( SELECT (auth.jwt() ->> 'email'::text)))`, withCheck: sql`(user_email = ( SELECT (auth.jwt() ->> 'email'::text)))`  }),
	pgPolicy("Users can read own scheduled_jobs", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("Service role manages scheduled_jobs", { as: "permissive", for: "all", to: ["service_role"] }),
]);

export const ideaCardStates = pgTable("idea_card_states", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	cardKey: text("card_key").notNull(),
	state: text().notNull(),
	payload: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idea_card_states_user_card_uidx").using("btree", table.userEmail.asc().nullsLast().op("text_ops"), table.cardKey.asc().nullsLast().op("text_ops")),
	index("idea_card_states_user_state_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops"), table.state.asc().nullsLast().op("text_ops")),
	pgPolicy("idea_card_states_update_own", { as: "permissive", for: "update", to: ["public"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))`, withCheck: sql`(user_email = (auth.jwt() ->> 'email'::text))`  }),
	pgPolicy("idea_card_states_select_own", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("idea_card_states_insert_own", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("idea_card_states_delete_own", { as: "permissive", for: "delete", to: ["public"] }),
	check("idea_card_states_state_check", sql`state = ANY (ARRAY['saved'::text, 'dismissed'::text, 'promoted'::text])`),
]);

export const outreachProspects = pgTable("outreach_prospects", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	domain: text().notNull(),
	url: text(),
	targetType: text("target_type").notNull(),
	contactName: text("contact_name"),
	contactEmail: text("contact_email"),
	contactUrl: text("contact_url"),
	dr: integer(),
	niche: text(),
	status: text().default('prospect').notNull(),
	priority: text().default('medium').notNull(),
	lastTouchAt: timestamp("last_touch_at", { withTimezone: true, mode: 'string' }),
	nextFollowupAt: timestamp("next_followup_at", { withTimezone: true, mode: 'string' }),
	notes: text(),
	responsibleEmail: text("responsible_email"),
	source: text(),
	sourceMentionId: uuid("source_mention_id"),
	createdByEmail: text("created_by_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("outreach_prospects_domain_idx").using("btree", table.domain.asc().nullsLast().op("text_ops")),
	index("outreach_prospects_followup_idx").using("btree", table.nextFollowupAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(next_followup_at IS NOT NULL)`),
	index("outreach_prospects_responsible_idx").using("btree", table.responsibleEmail.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("outreach_prospects_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	uniqueIndex("outreach_prospects_url_unique").using("btree", table.url.asc().nullsLast().op("text_ops")).where(sql`(url IS NOT NULL)`),
	foreignKey({
			columns: [table.sourceMentionId],
			foreignColumns: [socialMentions.id],
			name: "outreach_prospects_source_mention_id_fkey"
		}).onDelete("set null"),
	pgPolicy("Service role can manage prospects", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("Authenticated users can write prospects", { as: "permissive", for: "all", to: ["authenticated"] }),
	pgPolicy("Authenticated users can read prospects", { as: "permissive", for: "select", to: ["authenticated"] }),
	check("outreach_prospects_priority_check", sql`priority = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])`),
	check("outreach_prospects_status_check", sql`status = ANY (ARRAY['prospect'::text, 'researching'::text, 'drafted'::text, 'contacted'::text, 'replied'::text, 'won'::text, 'lost'::text, 'snoozed'::text])`),
	check("outreach_prospects_target_type_check", sql`target_type = ANY (ARRAY['listicle'::text, 'guest_post'::text, 'podcast'::text, 'awesome_list'::text, 'article'::text, 'newsletter'::text, 'partnership'::text, 'link_reclamation'::text, 'other'::text])`),
]);

export const outreachAutoEnrollRules = pgTable("outreach_auto_enroll_rules", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	sequenceId: uuid("sequence_id").notNull(),
	name: text(),
	filters: jsonb().default({}).notNull(),
	active: boolean().default(false).notNull(),
	maxPerRun: integer("max_per_run").default(10).notNull(),
	allContacts: boolean("all_contacts").default(false).notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	lastResult: jsonb("last_result"),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("outreach_auto_enroll_rules_active_idx").using("btree", table.active.asc().nullsLast().op("bool_ops")).where(sql`(active = true)`),
	index("outreach_auto_enroll_rules_sequence_idx").using("btree", table.sequenceId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.sequenceId],
			foreignColumns: [outreachSequences.id],
			name: "outreach_auto_enroll_rules_sequence_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("outreach_auto_enroll_rules_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_auto_enroll_rules_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("outreach_auto_enroll_rules_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("outreach_auto_enroll_rules_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const outreachEnrollments = pgTable("outreach_enrollments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	sequenceId: uuid("sequence_id").notNull(),
	source: text().notNull(),
	outreachProspectId: uuid("outreach_prospect_id"),
	researchRowId: uuid("research_row_id"),
	researchPersonId: uuid("research_person_id"),
	companyName: text("company_name").notNull(),
	domain: text(),
	contactName: text("contact_name"),
	contactEmail: text("contact_email"),
	contactLinkedin: text("contact_linkedin"),
	contactRole: text("contact_role"),
	status: text().default('active').notNull(),
	currentStepPosition: integer("current_step_position").default(0).notNull(),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }),
	lastError: text("last_error"),
	enrolledByEmail: text("enrolled_by_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	crmCompanyId: uuid("crm_company_id"),
	templateVars: jsonb("template_vars").default({}),
}, (table) => [
	index("outreach_enrollments_crm_company_idx").using("btree", table.crmCompanyId.asc().nullsLast().op("uuid_ops")).where(sql`(crm_company_id IS NOT NULL)`),
	index("outreach_enrollments_next_run_idx").using("btree", table.nextRunAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((status = 'active'::text) AND (next_run_at IS NOT NULL))`),
	uniqueIndex("outreach_enrollments_seq_email_uniq").using("btree", sql`sequence_id`, sql`lower(contact_email)`).where(sql`((contact_email IS NOT NULL) AND (status = ANY (ARRAY['active'::text, 'paused'::text])))`),
	uniqueIndex("outreach_enrollments_seq_linkedin_uniq").using("btree", table.sequenceId.asc().nullsLast().op("text_ops"), table.contactLinkedin.asc().nullsLast().op("text_ops")).where(sql`((contact_linkedin IS NOT NULL) AND (status = ANY (ARRAY['active'::text, 'paused'::text])))`),
	index("outreach_enrollments_sequence_idx").using("btree", table.sequenceId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.crmCompanyId],
			foreignColumns: [crmCompanies.id],
			name: "outreach_enrollments_crm_company_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.outreachProspectId],
			foreignColumns: [outreachProspects.id],
			name: "outreach_enrollments_outreach_prospect_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.sequenceId],
			foreignColumns: [outreachSequences.id],
			name: "outreach_enrollments_sequence_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("outreach_enrollments_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_enrollments_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("outreach_enrollments_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("outreach_enrollments_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("outreach_enrollments_source_check", sql`source = ANY (ARRAY['research'::text, 'outreach'::text, 'manual'::text, 'crm'::text])`),
	check("outreach_enrollments_status_check", sql`status = ANY (ARRAY['active'::text, 'paused'::text, 'completed'::text, 'replied'::text, 'bounced'::text, 'failed'::text, 'cancelled'::text])`),
]);

export const outreachReplyMessages = pgTable("outreach_reply_messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	threadId: uuid("thread_id").notNull(),
	gmailMessageId: text("gmail_message_id").notNull(),
	direction: text().notNull(),
	fromEmail: text("from_email"),
	toEmails: text("to_emails").array().default([""]).notNull(),
	subject: text(),
	bodyText: text("body_text"),
	bodyHtml: text("body_html"),
	snippet: text(),
	rfcMessageId: text("rfc_message_id"),
	inReplyTo: text("in_reply_to"),
	internalDate: timestamp("internal_date", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("outreach_reply_messages_rfc_idx").using("btree", table.rfcMessageId.asc().nullsLast().op("text_ops")).where(sql`(rfc_message_id IS NOT NULL)`),
	index("outreach_reply_messages_thread_idx").using("btree", table.threadId.asc().nullsLast().op("timestamptz_ops"), table.internalDate.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.threadId],
			foreignColumns: [outreachReplyThreads.id],
			name: "outreach_reply_messages_thread_id_fkey"
		}).onDelete("cascade"),
	unique("outreach_reply_messages_thread_id_gmail_message_id_key").on(table.gmailMessageId, table.threadId),
	pgPolicy("outreach_reply_messages_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_reply_messages_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("outreach_reply_messages_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("outreach_reply_messages_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("outreach_reply_messages_direction_check", sql`direction = ANY (ARRAY['inbound'::text, 'outbound_ours'::text])`),
]);

export const researchPeopleSnapshots = pgTable("research_people_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	rowId: uuid("row_id").notNull(),
	reason: text().default('save').notNull(),
	people: jsonb().default([]).notNull(),
	personCount: integer("person_count").default(0).notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("research_people_snapshots_row_idx").using("btree", table.rowId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.rowId],
			foreignColumns: [researchRows.id],
			name: "research_people_snapshots_row_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("research_people_snapshots_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`true` }),
	pgPolicy("research_people_snapshots_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
]);

export const researchRuns = pgTable("research_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tableId: uuid("table_id"),
	kind: text().notNull(),
	status: text().default('running').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	summary: jsonb().default({}),
	lastError: text("last_error"),
	createdBy: text("created_by"),
}, (table) => [
	index("research_runs_table_idx").using("btree", table.tableId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.tableId],
			foreignColumns: [researchTables.id],
			name: "research_runs_table_id_fkey"
		}).onDelete("set null"),
	pgPolicy("research_runs_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("research_runs_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("research_runs_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("research_runs_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const researchTableSnapshots = pgTable("research_table_snapshots", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tableId: uuid("table_id").notNull(),
	reason: text().default('save').notNull(),
	tableData: jsonb("table_data").notNull(),
	rowsData: jsonb("rows_data").default([]).notNull(),
	rowCount: integer("row_count").default(0).notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("research_table_snapshots_table_idx").using("btree", table.tableId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("research_table_snapshots_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`true` }),
	pgPolicy("research_table_snapshots_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
]);

export const outreachSequences = pgTable("outreach_sequences", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	status: text().default('draft').notNull(),
	defaultFromEmail: text("default_from_email"),
	createdByEmail: text("created_by_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	mailboxId: uuid("mailbox_id"),
}, (table) => [
	index("outreach_sequences_mailbox_idx").using("btree", table.mailboxId.asc().nullsLast().op("uuid_ops")).where(sql`(mailbox_id IS NOT NULL)`),
	foreignKey({
			columns: [table.mailboxId],
			foreignColumns: [outreachMailboxes.id],
			name: "outreach_sequences_mailbox_id_fkey"
		}).onDelete("set null"),
	pgPolicy("outreach_sequences_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_sequences_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("outreach_sequences_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("outreach_sequences_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("outreach_sequences_status_check", sql`status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'archived'::text])`),
]);

export const researchPeople = pgTable("research_people", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	rowId: uuid("row_id").notNull(),
	name: text().notNull(),
	role: text(),
	linkedin: text(),
	email: text(),
	emailStatus: text("email_status"),
	emailSource: text("email_source"),
	providerUsed: text("provider_used"),
	confidence: numeric(),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("research_people_row_idx").using("btree", table.rowId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.rowId],
			foreignColumns: [researchRows.id],
			name: "research_people_row_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("research_people_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("research_people_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("research_people_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("research_people_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const productSignalsLatest = pgTable("product_signals_latest", {
	orgId: text("org_id").primaryKey().notNull(),
	orgName: text("org_name"),
	orgType: text("org_type"),
	signupAt: timestamp("signup_at", { withTimezone: true, mode: 'string' }),
	connectedGit: boolean("connected_git").default(false).notNull(),
	planType: text("plan_type"),
	subscriptionStatus: text("subscription_status"),
	trialEnd: timestamp("trial_end", { withTimezone: true, mode: 'string' }),
	totalLicenses: integer("total_licenses"),
	assignedLicenses: integer("assigned_licenses"),
	userCount: integer("user_count"),
	reviews7D: integer("reviews_7d"),
	reviews30D: integer("reviews_30d"),
	lastReviewAt: timestamp("last_review_at", { withTimezone: true, mode: 'string' }),
	skips30D: integer("skips_30d"),
	topSkipReason: text("top_skip_reason"),
	tier: text(),
	trigger: text(),
	health: text(),
	computedAt: timestamp("computed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	codeHostMemberCount: integer("code_host_member_count"),
	codeHostMemberCountAt: timestamp("code_host_member_count_at", { withTimezone: true, mode: 'string' }),
	prAuthorCount: integer("pr_author_count"),
	devCount: integer("dev_count"),
	devCountSource: text("dev_count_source"),
	prsReviewed30D: integer("prs_reviewed_30d"),
	suggestions30D: integer("suggestions_30d"),
	suggestionsImplemented30D: integer("suggestions_implemented_30d"),
	suggestionsPartial30D: integer("suggestions_partial_30d"),
}, (table) => [
	index("product_signals_latest_dev_count_idx").using("btree", table.devCount.asc().nullsLast().op("int4_ops")).where(sql`(dev_count IS NOT NULL)`),
	index("product_signals_latest_tier_idx").using("btree", table.tier.asc().nullsLast().op("text_ops")).where(sql`(tier IS NOT NULL)`),
	pgPolicy("product_signals_latest_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`true` }),
]);

export const socialMentions = pgTable("social_mentions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	platform: text().notNull(),
	url: text().notNull(),
	author: text(),
	authorProfileUrl: text("author_profile_url"),
	title: text().notNull(),
	content: text().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	relevance: text().notNull(),
	intent: text().notNull(),
	suggestedApproach: text("suggested_approach").notNull(),
	status: text().default('new').notNull(),
	keywordsMatched: text("keywords_matched").array().default([""]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_social_mentions_platform").using("btree", table.platform.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	index("idx_social_mentions_status").using("btree", table.status.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	unique("social_mentions_url_key").on(table.url),
	pgPolicy("Service role can manage mentions", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("Authenticated users can read mentions", { as: "permissive", for: "select", to: ["authenticated"] }),
	check("social_mentions_intent_check", sql`intent = ANY (ARRAY['asking_help'::text, 'complaining'::text, 'comparing_tools'::text, 'discussing'::text, 'sharing_experience'::text, 'backlink_opportunity'::text, 'competitor_listicle'::text])`),
	check("social_mentions_platform_check", sql`platform = ANY (ARRAY['reddit'::text, 'twitter'::text, 'linkedin'::text, 'hackernews'::text, 'web'::text, 'github'::text])`),
	check("social_mentions_relevance_check", sql`relevance = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])`),
	check("social_mentions_status_check", sql`status = ANY (ARRAY['new'::text, 'contacted'::text, 'replied'::text, 'dismissed'::text])`),
]);

export const crmContacts = pgTable("crm_contacts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	companyId: uuid("company_id").notNull(),
	name: text().notNull(),
	email: text(),
	role: text(),
	phone: text(),
	linkedin: text(),
	isPrimary: boolean("is_primary").default(false),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("crm_contacts_active_idx").using("btree", table.companyId.asc().nullsLast().op("uuid_ops")).where(sql`(archived_at IS NULL)`),
	index("crm_contacts_company_idx").using("btree", table.companyId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.companyId],
			foreignColumns: [crmCompanies.id],
			name: "crm_contacts_company_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("crm_contacts_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("crm_contacts_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("crm_contacts_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("crm_contacts_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const growthWorkItems = pgTable("growth_work_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	title: text().notNull(),
	description: text(),
	itemType: text("item_type").default('idea').notNull(),
	stage: text().default('backlog').notNull(),
	source: text().default('manual').notNull(),
	sourceRef: text("source_ref"),
	priority: text().default('medium').notNull(),
	link: text(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	payload: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	columnId: uuid("column_id"),
	position: integer().default(0),
	responsibleEmail: text("responsible_email"),
}, (table) => [
	index("growth_work_items_responsible_email_idx").using("btree", table.responsibleEmail.asc().nullsLast().op("text_ops")),
	index("growth_work_items_stage_idx").using("btree", table.stage.asc().nullsLast().op("text_ops")),
	index("growth_work_items_updated_at_idx").using("btree", table.updatedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("growth_work_items_user_email_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops")),
	uniqueIndex("growth_work_items_user_source_ref_unique_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops"), table.sourceRef.asc().nullsLast().op("text_ops")).where(sql`(source_ref IS NOT NULL)`),
	foreignKey({
			columns: [table.columnId],
			foreignColumns: [kanbanColumns.id],
			name: "growth_work_items_column_id_fkey"
		}).onDelete("set null"),
	pgPolicy("growth_work_items_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("growth_work_items_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("growth_work_items_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("growth_work_items_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("growth_work_items_item_type_check", sql`item_type = ANY (ARRAY['idea'::text, 'keyword'::text, 'title'::text, 'article'::text, 'social'::text, 'update'::text, 'task'::text])`),
	check("growth_work_items_priority_check", sql`priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])`),
	check("growth_work_items_source_check", sql`source = ANY (ARRAY['manual'::text, 'blog'::text, 'changelog'::text, 'agent'::text, 'n8n'::text])`),
]);

export const enrichmentCache = pgTable("enrichment_cache", {
	cacheKey: text("cache_key").primaryKey().notNull(),
	value: jsonb().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("enrichment_cache_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	pgPolicy("enrichment_cache_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("enrichment_cache_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("enrichment_cache_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("enrichment_cache_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const ideaSessions = pgTable("idea_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	topic: text(),
	lanes: jsonb().default([]).notNull(),
	cards: jsonb().default([]).notNull(),
	generatedAt: timestamp("generated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idea_sessions_user_generated_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops"), table.generatedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("idea_sessions_select_own", { as: "permissive", for: "select", to: ["public"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))` }),
	pgPolicy("idea_sessions_insert_own", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("idea_sessions_delete_own", { as: "permissive", for: "delete", to: ["public"] }),
]);

export const linkedinCommenters = pgTable("linkedin_commenters", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	researchTableId: uuid("research_table_id").notNull(),
	profileUrl: text("profile_url").notNull(),
	name: text().notNull(),
	headline: text(),
	networkDistance: text("network_distance"),
	providerId: text("provider_id"),
	publicIdentifier: text("public_identifier"),
	profilePictureUrl: text("profile_picture_url"),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("linkedin_commenters_distance_idx").using("btree", table.researchTableId.asc().nullsLast().op("text_ops"), table.networkDistance.asc().nullsLast().op("uuid_ops")).where(sql`(network_distance IS NOT NULL)`),
	index("linkedin_commenters_table_idx").using("btree", table.researchTableId.asc().nullsLast().op("timestamptz_ops"), table.lastSeenAt.desc().nullsFirst().op("uuid_ops")),
	foreignKey({
			columns: [table.researchTableId],
			foreignColumns: [researchTables.id],
			name: "linkedin_commenters_research_table_id_fkey"
		}).onDelete("cascade"),
	unique("linkedin_commenters_table_profile_key").on(table.profileUrl, table.researchTableId),
	pgPolicy("linkedin_commenters_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`true` }),
]);

export const kanbanColumns = pgTable("kanban_columns", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	position: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("kanban_columns_slug_key").on(table.slug),
	pgPolicy("kanban_columns_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("kanban_columns_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("kanban_columns_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("kanban_columns_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const mcpPersonalTokens = pgTable("mcp_personal_tokens", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	userEmail: text("user_email").notNull(),
	name: text().notNull(),
	tokenPrefix: text("token_prefix").notNull(),
	tokenHash: text("token_hash").notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("mcp_personal_tokens_hash_idx").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")).where(sql`(revoked_at IS NULL)`),
	index("mcp_personal_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(revoked_at IS NULL)`),
	unique("mcp_personal_tokens_token_hash_key").on(table.tokenHash),
	pgPolicy("mcp_personal_tokens_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`(user_id = auth.uid())` }),
	pgPolicy("mcp_personal_tokens_select", { as: "permissive", for: "select", to: ["authenticated"] }),
]);

export const outreachMailboxes = pgTable("outreach_mailboxes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	label: text().default('Outreach').notNull(),
	fromName: text("from_name"),
	fromEmail: text("from_email").notNull(),
	provider: text().default('smtp').notNull(),
	smtpHost: text("smtp_host").default('smtp.gmail.com').notNull(),
	smtpPort: integer("smtp_port").default(587).notNull(),
	smtpSecure: boolean("smtp_secure").default(false).notNull(),
	smtpUser: text("smtp_user"),
	smtpPassEncrypted: text("smtp_pass_encrypted"),
	dailyCap: integer("daily_cap").default(40).notNull(),
	isDefault: boolean("is_default").default(true).notNull(),
	enabled: boolean().default(true).notNull(),
	sentToday: integer("sent_today").default(0).notNull(),
	sentTodayDate: date("sent_today_date"),
	lastTestedAt: timestamp("last_tested_at", { withTimezone: true, mode: 'string' }),
	lastTestOk: boolean("last_test_ok"),
	lastTestError: text("last_test_error"),
	lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: 'string' }),
	createdByEmail: text("created_by_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authMethod: text("auth_method").default('smtp').notNull(),
	oauthRefreshTokenEncrypted: text("oauth_refresh_token_encrypted"),
	oauthAccessTokenEncrypted: text("oauth_access_token_encrypted"),
	oauthTokenExpiresAt: timestamp("oauth_token_expires_at", { withTimezone: true, mode: 'string' }),
	emailAutoSend: boolean("email_auto_send").default(true).notNull(),
	gmailHistoryId: text("gmail_history_id"),
	oauthGrantedScopes: text("oauth_granted_scopes"),
	gmailReadonlyOk: boolean("gmail_readonly_ok"),
}, (table) => [
	index("outreach_mailboxes_enabled_idx").using("btree", table.enabled.asc().nullsLast().op("bool_ops"), table.isDefault.asc().nullsLast().op("bool_ops")),
	uniqueIndex("outreach_mailboxes_one_default").using("btree", table.isDefault.asc().nullsLast().op("bool_ops")).where(sql`(is_default = true)`),
	pgPolicy("outreach_mailboxes_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_mailboxes_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("outreach_mailboxes_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("outreach_mailboxes_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("outreach_mailboxes_auth_method_check", sql`auth_method = ANY (ARRAY['smtp'::text, 'oauth'::text])`),
	check("outreach_mailboxes_daily_cap_check", sql`(daily_cap > 0) AND (daily_cap <= 500)`),
	check("outreach_mailboxes_provider_check", sql`provider = ANY (ARRAY['smtp'::text, 'gmail'::text, 'google_oauth'::text])`),
]);

export const outreachReplyThreads = pgTable("outreach_reply_threads", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	mailboxId: uuid("mailbox_id"),
	enrollmentId: uuid("enrollment_id"),
	sequenceId: uuid("sequence_id"),
	gmailThreadId: text("gmail_thread_id").notNull(),
	contactEmail: text("contact_email"),
	contactName: text("contact_name"),
	companyName: text("company_name"),
	subject: text(),
	snippet: text(),
	status: text().default('new').notNull(),
	snoozedUntil: timestamp("snoozed_until", { withTimezone: true, mode: 'string' }),
	matchedHow: text("matched_how").default('unmatched').notNull(),
	messageCount: integer("message_count").default(0).notNull(),
	firstInboundAt: timestamp("first_inbound_at", { withTimezone: true, mode: 'string' }),
	lastInboundAt: timestamp("last_inbound_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	channel: text().default('email').notNull(),
	unipileAccountId: text("unipile_account_id"),
	contactLinkedin: text("contact_linkedin"),
	replyClass: text("reply_class"),
	replyClassConfidence: numeric("reply_class_confidence"),
	replyClassReason: text("reply_class_reason"),
	replyClassModel: text("reply_class_model"),
	replyClassifiedAt: timestamp("reply_classified_at", { withTimezone: true, mode: 'string' }),
	replyClassifiedInboundAt: timestamp("reply_classified_inbound_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("outreach_reply_threads_class_idx").using("btree", table.replyClass.asc().nullsLast().op("text_ops"), table.firstInboundAt.desc().nullsFirst().op("text_ops")),
	uniqueIndex("outreach_reply_threads_email_uniq").using("btree", table.mailboxId.asc().nullsLast().op("uuid_ops"), table.gmailThreadId.asc().nullsLast().op("uuid_ops")).where(sql`((channel = 'email'::text) AND (mailbox_id IS NOT NULL))`),
	index("outreach_reply_threads_enrollment_idx").using("btree", table.enrollmentId.asc().nullsLast().op("uuid_ops")).where(sql`(enrollment_id IS NOT NULL)`),
	index("outreach_reply_threads_first_inbound_idx").using("btree", table.firstInboundAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("outreach_reply_threads_linkedin_uniq").using("btree", table.unipileAccountId.asc().nullsLast().op("text_ops"), table.gmailThreadId.asc().nullsLast().op("text_ops")).where(sql`((channel = 'linkedin'::text) AND (unipile_account_id IS NOT NULL))`),
	index("outreach_reply_threads_needs_class_idx").using("btree", table.lastInboundAt.desc().nullsFirst().op("timestamptz_ops")).where(sql`(reply_class IS NULL)`),
	index("outreach_reply_threads_sequence_idx").using("btree", table.sequenceId.asc().nullsLast().op("uuid_ops")).where(sql`(sequence_id IS NOT NULL)`),
	index("outreach_reply_threads_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.lastInboundAt.desc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.enrollmentId],
			foreignColumns: [outreachEnrollments.id],
			name: "outreach_reply_threads_enrollment_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.mailboxId],
			foreignColumns: [outreachMailboxes.id],
			name: "outreach_reply_threads_mailbox_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sequenceId],
			foreignColumns: [outreachSequences.id],
			name: "outreach_reply_threads_sequence_id_fkey"
		}).onDelete("set null"),
	pgPolicy("outreach_reply_threads_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_reply_threads_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("outreach_reply_threads_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("outreach_reply_threads_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("outreach_reply_threads_channel_check", sql`channel = ANY (ARRAY['email'::text, 'linkedin'::text])`),
	check("outreach_reply_threads_matched_how_check", sql`matched_how = ANY (ARRAY['gmail_thread'::text, 'in_reply_to'::text, 'from_email'::text, 'linkedin_profile'::text, 'unmatched'::text])`),
	check("outreach_reply_threads_reply_class_check", sql`(reply_class IS NULL) OR (reply_class = ANY (ARRAY['positive'::text, 'neutral'::text, 'not_now'::text, 'not_interested'::text, 'referral'::text, 'auto_reply'::text, 'unsubscribe'::text, 'bounce'::text]))`),
	check("outreach_reply_threads_status_check", sql`status = ANY (ARRAY['new'::text, 'open'::text, 'done'::text, 'snoozed'::text])`),
]);

export const outreachSendTasks = pgTable("outreach_send_tasks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	enrollmentId: uuid("enrollment_id").notNull(),
	stepId: uuid("step_id").notNull(),
	channel: text().notNull(),
	mode: text().notNull(),
	status: text().default('scheduled').notNull(),
	scheduledFor: timestamp("scheduled_for", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	renderedSubject: text("rendered_subject"),
	renderedBody: text("rendered_body"),
	provider: text(),
	providerMessageId: text("provider_message_id"),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	sentByEmail: text("sent_by_email"),
	error: text(),
	meta: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("outreach_send_tasks_due_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.scheduledFor.asc().nullsLast().op("text_ops")),
	index("outreach_send_tasks_enrollment_idx").using("btree", table.enrollmentId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("outreach_send_tasks_queue_idx").using("btree", table.channel.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.scheduledFor.asc().nullsLast().op("text_ops")).where(sql`(status = 'ready'::text)`),
	index("outreach_send_tasks_sent_at_idx").using("btree", table.sentAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'sent'::text)`),
	foreignKey({
			columns: [table.enrollmentId],
			foreignColumns: [outreachEnrollments.id],
			name: "outreach_send_tasks_enrollment_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.stepId],
			foreignColumns: [outreachSequenceSteps.id],
			name: "outreach_send_tasks_step_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("outreach_send_tasks_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_send_tasks_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("outreach_send_tasks_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("outreach_send_tasks_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("outreach_send_tasks_channel_check", sql`channel = ANY (ARRAY['email'::text, 'linkedin'::text])`),
	check("outreach_send_tasks_mode_check", sql`mode = ANY (ARRAY['auto'::text, 'semi'::text])`),
	check("outreach_send_tasks_status_check", sql`status = ANY (ARRAY['scheduled'::text, 'ready'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'cancelled'::text])`),
]);

export const outreachSequenceSteps = pgTable("outreach_sequence_steps", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	sequenceId: uuid("sequence_id").notNull(),
	position: integer().notNull(),
	channel: text().notNull(),
	mode: text().notNull(),
	delayHours: integer("delay_hours").default(0).notNull(),
	linkedinAction: text("linkedin_action"),
	subjectTemplate: text("subject_template"),
	bodyTemplate: text("body_template").default('').notNull(),
	stopOnReply: boolean("stop_on_reply").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	emailThreadMode: text("email_thread_mode"),
}, (table) => [
	foreignKey({
			columns: [table.sequenceId],
			foreignColumns: [outreachSequences.id],
			name: "outreach_sequence_steps_sequence_id_fkey"
		}).onDelete("cascade"),
	unique("outreach_sequence_steps_sequence_id_position_key").on(table.position, table.sequenceId),
	pgPolicy("outreach_sequence_steps_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("outreach_sequence_steps_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("outreach_sequence_steps_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("outreach_sequence_steps_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
	check("outreach_sequence_steps_linkedin_action_check", sql`(linkedin_action IS NULL) OR (linkedin_action = ANY (ARRAY['connect_note'::text, 'message'::text]))`),
	check("outreach_sequence_steps_channel_check", sql`channel = ANY (ARRAY['email'::text, 'linkedin'::text])`),
	check("outreach_sequence_steps_delay_hours_check", sql`delay_hours >= 0`),
	check("outreach_sequence_steps_email_thread_mode_check", sql`(email_thread_mode IS NULL) OR (email_thread_mode = ANY (ARRAY['new'::text, 'reply'::text]))`),
	check("outreach_sequence_steps_mode_check", sql`mode = ANY (ARRAY['auto'::text, 'semi'::text])`),
]);

export const socialYoloPosts = pgTable("social_yolo_posts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	batchDate: date("batch_date").notNull(),
	position: integer().notNull(),
	lane: text().notNull(),
	theme: text().notNull(),
	platform: text().notNull(),
	hook: text().default('').notNull(),
	content: text().notNull(),
	cta: text().default('').notNull(),
	hashtags: text().array().default([""]).notNull(),
	status: text().default('draft').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("social_yolo_posts_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("social_yolo_posts_user_batch_idx").using("btree", table.userEmail.asc().nullsLast().op("date_ops"), table.batchDate.desc().nullsFirst().op("date_ops")),
	uniqueIndex("social_yolo_posts_user_batch_position_idx").using("btree", table.userEmail.asc().nullsLast().op("int4_ops"), table.batchDate.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
	pgPolicy("social_yolo_posts_update_own", { as: "permissive", for: "update", to: ["public"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))`, withCheck: sql`(user_email = (auth.jwt() ->> 'email'::text))`  }),
	pgPolicy("social_yolo_posts_select_own", { as: "permissive", for: "select", to: ["public"] }),
	pgPolicy("social_yolo_posts_insert_own", { as: "permissive", for: "insert", to: ["public"] }),
	pgPolicy("social_yolo_posts_delete_own", { as: "permissive", for: "delete", to: ["public"] }),
	check("social_yolo_posts_lane_check", sql`lane = ANY (ARRAY['blog'::text, 'changelog'::text, 'mixed'::text, 'hackernews'::text, 'research'::text, 'adversarial'::text])`),
	check("social_yolo_posts_status_check", sql`status = ANY (ARRAY['draft'::text, 'selected'::text, 'discarded'::text])`),
]);

export const productSignalsHistory = pgTable("product_signals_history", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: text("org_id").notNull(),
	tier: text(),
	trigger: text(),
	health: text(),
	planType: text("plan_type"),
	subscriptionStatus: text("subscription_status"),
	prevTier: text("prev_tier"),
	prevTrigger: text("prev_trigger"),
	reviews30D: integer("reviews_30d"),
	skips30D: integer("skips_30d"),
	topSkipReason: text("top_skip_reason"),
	computedAt: timestamp("computed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("product_signals_history_org_idx").using("btree", table.orgId.asc().nullsLast().op("text_ops"), table.computedAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("product_signals_history_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`true` }),
]);

export const xReplyCandidates = pgTable("x_reply_candidates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	targetAccountId: uuid("target_account_id").notNull(),
	xPostId: text("x_post_id").notNull(),
	postUrl: text("post_url").notNull(),
	postText: text("post_text").notNull(),
	postCreatedAt: timestamp("post_created_at", { withTimezone: true, mode: 'string' }).notNull(),
	authorUsername: text("author_username").notNull(),
	authorDisplayName: text("author_display_name"),
	authorAvatarUrl: text("author_avatar_url"),
	metrics: jsonb().default({}).notNull(),
	engagementScore: numeric("engagement_score").default('0').notNull(),
	status: text().default('new').notNull(),
	snoozedUntil: timestamp("snoozed_until", { withTimezone: true, mode: 'string' }),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	userHint: text("user_hint"),
}, (table) => [
	index("x_reply_candidates_target_idx").using("btree", table.targetAccountId.asc().nullsLast().op("timestamptz_ops"), table.postCreatedAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("x_reply_candidates_user_post_uidx").using("btree", table.userEmail.asc().nullsLast().op("text_ops"), table.xPostId.asc().nullsLast().op("text_ops")),
	index("x_reply_candidates_user_status_idx").using("btree", table.userEmail.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops"), table.postCreatedAt.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.targetAccountId],
			foreignColumns: [xTargetAccounts.id],
			name: "x_reply_candidates_target_account_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("x_reply_candidates_update_own", { as: "permissive", for: "update", to: ["public"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))`, withCheck: sql`(user_email = (auth.jwt() ->> 'email'::text))`  }),
	pgPolicy("x_reply_candidates_select_own", { as: "permissive", for: "select", to: ["public"] }),
	check("x_reply_candidates_status_check", sql`status = ANY (ARRAY['new'::text, 'drafted'::text, 'dismissed'::text, 'replied'::text, 'snoozed'::text])`),
]);

export const task = pgTable("task", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "task_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: text(),
});

export const researchEvidence = pgTable("research_evidence", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	rowId: uuid("row_id").notNull(),
	criterionId: text("criterion_id").notNull(),
	kind: text().notNull(),
	status: text().notNull(),
	confidence: numeric().default('0'),
	evidence: text(),
	sources: jsonb().default([]),
	weight: numeric().default('0'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	uniqueIndex("research_evidence_row_criterion_uniq").using("btree", table.rowId.asc().nullsLast().op("text_ops"), table.criterionId.asc().nullsLast().op("text_ops")),
	index("research_evidence_row_idx").using("btree", table.rowId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.rowId],
			foreignColumns: [researchRows.id],
			name: "research_evidence_row_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("research_evidence_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("research_evidence_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("research_evidence_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("research_evidence_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const userNotifications = pgTable("user_notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userEmail: text("user_email").notNull(),
	kind: text().notNull(),
	severity: text().default('info').notNull(),
	title: text().notNull(),
	body: text(),
	source: text(),
	sourceId: text("source_id"),
	link: text(),
	dedupeKey: text("dedupe_key").notNull(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	uniqueIndex("user_notifications_dedupe_uniq").using("btree", table.userEmail.asc().nullsLast().op("text_ops"), table.dedupeKey.asc().nullsLast().op("text_ops")),
	index("user_notifications_user_idx").using("btree", table.userEmail.asc().nullsLast().op("timestamptz_ops"), table.readAt.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	pgPolicy("user_notifications_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`(user_email = (auth.jwt() ->> 'email'::text))` }),
	pgPolicy("user_notifications_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("user_notifications_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const researchExcludedCompanies = pgTable("research_excluded_companies", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tableId: uuid("table_id").notNull(),
	domain: text(),
	companyKey: text("company_key").notNull(),
	companyName: text("company_name").notNull(),
	reason: text(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	uniqueIndex("research_excluded_table_company_uniq").using("btree", table.tableId.asc().nullsLast().op("text_ops"), table.companyKey.asc().nullsLast().op("text_ops")),
	uniqueIndex("research_excluded_table_domain_uniq").using("btree", sql`table_id`, sql`lower(domain)`).where(sql`(domain IS NOT NULL)`),
	pgPolicy("research_excluded_companies_update", { as: "permissive", for: "update", to: ["authenticated"], using: sql`true` }),
	pgPolicy("research_excluded_companies_select", { as: "permissive", for: "select", to: ["authenticated"] }),
	pgPolicy("research_excluded_companies_insert", { as: "permissive", for: "insert", to: ["authenticated"] }),
	pgPolicy("research_excluded_companies_delete", { as: "permissive", for: "delete", to: ["authenticated"] }),
]);

export const companyEnrichment = pgTable("company_enrichment", {
	domain: text().primaryKey().notNull(),
	employeeCount: integer("employee_count"),
	industry: text(),
	companyType: text("company_type"),
	country: text(),
	foundedYear: integer("founded_year"),
	name: text(),
	provider: text().default('ninjapear').notNull(),
	error: text(),
	raw: jsonb(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("company_enrichment_fetched_idx").using("btree", table.fetchedAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("company_enrichment_select", { as: "permissive", for: "select", to: ["authenticated"], using: sql`true` }),
]);

export const personas = pgTable("personas", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	handle: text().notNull(),
	displayName: text("display_name").notNull(),
	bio: text().notNull(),
	avatarUrl: text("avatar_url"),
	backstory: text().notNull(),
	disclosure: text().notNull(),
	beat: text().notNull(),
	tone: text(),
	writingGuidelines: text("writing_guidelines"),
	preferredWords: text("preferred_words").array().default([""]).notNull(),
	forbiddenWords: text("forbidden_words").array().default([""]).notNull(),
	allowedTopics: text("allowed_topics").array().default([""]).notNull(),
	forbiddenTopics: text("forbidden_topics").array().default([""]).notNull(),
	contentConfig: jsonb("content_config").default({}).notNull(),
	status: text().default('paused').notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("personas_handle_key").on(table.handle),
	pgPolicy("personas_authenticated_all", { as: "permissive", for: "all", to: ["authenticated"], using: sql`true`, withCheck: sql`true`  }),
	check("personas_status_check", sql`status = ANY (ARRAY['active'::text, 'paused'::text])`),
]);

export const personaChannels = pgTable("persona_channels", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	personaId: uuid("persona_id").notNull(),
	platform: text().notNull(),
	externalHandle: text("external_handle"),
	publishVia: text("publish_via").notNull(),
	automationLevel: text("automation_level").default('approve_first').notNull(),
	maxPostsPerDay: integer("max_posts_per_day").default(2).notNull(),
	maxRepliesPerDay: integer("max_replies_per_day").default(5).notNull(),
	credentialsRef: text("credentials_ref"),
	channelConfig: jsonb("channel_config").default({}).notNull(),
	onboarding: jsonb().default({}).notNull(),
	status: text().default('pending_setup').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.personaId],
			foreignColumns: [personas.id],
			name: "persona_channels_persona_id_fkey"
		}).onDelete("cascade"),
	unique("persona_channels_persona_id_platform_key").on(table.personaId, table.platform),
	pgPolicy("persona_channels_authenticated_all", { as: "permissive", for: "all", to: ["authenticated"], using: sql`true`, withCheck: sql`true`  }),
	check("persona_channels_platform_check", sql`platform = ANY (ARRAY['x'::text, 'devto'::text, 'blog'::text, 'medium'::text, 'reddit'::text, 'hackernews'::text])`),
	check("persona_channels_publish_via_check", sql`publish_via = ANY (ARRAY['post_bridge'::text, 'api'::text, 'n8n'::text, 'manual'::text])`),
	check("persona_channels_automation_level_check", sql`automation_level = ANY (ARRAY['auto'::text, 'approve_first'::text, 'draft_only'::text])`),
	check("persona_channels_status_check", sql`status = ANY (ARRAY['pending_setup'::text, 'active'::text, 'paused'::text])`),
]);

export const personaActivities = pgTable("persona_activities", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	personaId: uuid("persona_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	kind: text().notNull(),
	status: text().default('draft').notNull(),
	title: text(),
	content: text().notNull(),
	contentMeta: jsonb("content_meta").default({}).notNull(),
	sourceKind: text("source_kind"),
	sourceRef: text("source_ref"),
	parentActivityId: uuid("parent_activity_id"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	externalId: text("external_id"),
	externalUrl: text("external_url"),
	error: text(),
	approvedBy: text("approved_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("persona_activities_created_idx").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("persona_activities_persona_status_idx").using("btree", table.personaId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("persona_activities_status_scheduled_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.scheduledAt.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.personaId],
			foreignColumns: [personas.id],
			name: "persona_activities_persona_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [personaChannels.id],
			name: "persona_activities_channel_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentActivityId],
			foreignColumns: [table.id],
			name: "persona_activities_parent_activity_id_fkey"
		}).onDelete("set null"),
	pgPolicy("persona_activities_authenticated_all", { as: "permissive", for: "all", to: ["authenticated"], using: sql`true`, withCheck: sql`true`  }),
	check("persona_activities_kind_check", sql`kind = ANY (ARRAY['post'::text, 'reply'::text, 'quote'::text, 'article'::text, 'crosspost'::text])`),
	check("persona_activities_status_check", sql`status = ANY (ARRAY['draft'::text, 'approved'::text, 'scheduled'::text, 'publishing'::text, 'published'::text, 'failed'::text, 'discarded'::text])`),
]);

export const personaActivityMetrics = pgTable("persona_activity_metrics", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	activityId: uuid("activity_id").notNull(),
	collectedAt: timestamp("collected_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	metrics: jsonb().default({}).notNull(),
	engagementScore: numeric("engagement_score").default('0').notNull(),
}, (table) => [
	index("persona_activity_metrics_activity_idx").using("btree", table.activityId.asc().nullsLast().op("timestamptz_ops"), table.collectedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.activityId],
			foreignColumns: [personaActivities.id],
			name: "persona_activity_metrics_activity_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("persona_activity_metrics_authenticated_all", { as: "permissive", for: "all", to: ["authenticated"], using: sql`true`, withCheck: sql`true`  }),
]);

export const personaLearnings = pgTable("persona_learnings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	personaId: uuid("persona_id").notNull(),
	kind: text().notNull(),
	insight: text().notNull(),
	evidence: jsonb().default({}).notNull(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("persona_learnings_persona_status_idx").using("btree", table.personaId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.personaId],
			foreignColumns: [personas.id],
			name: "persona_learnings_persona_id_fkey"
		}).onDelete("cascade"),
	pgPolicy("persona_learnings_authenticated_all", { as: "permissive", for: "all", to: ["authenticated"], using: sql`true`, withCheck: sql`true`  }),
	check("persona_learnings_kind_check", sql`kind = ANY (ARRAY['works'::text, 'avoid'::text])`),
	check("persona_learnings_status_check", sql`status = ANY (ARRAY['active'::text, 'retired'::text])`),
]);

export const goalLinks = pgTable("goal_links", {
	goalId: uuid("goal_id").notNull(),
	workItemId: uuid("work_item_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdByEmail: text("created_by_email"),
}, (table) => [
	index("goal_links_goal_idx").using("btree", table.goalId.asc().nullsLast().op("uuid_ops")),
	index("goal_links_work_item_idx").using("btree", table.workItemId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.goalId],
			foreignColumns: [goals.id],
			name: "goal_links_goal_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workItemId],
			foreignColumns: [growthWorkItems.id],
			name: "goal_links_work_item_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.goalId, table.workItemId], name: "goal_links_pkey"}),
	pgPolicy("Service role can manage goal_links", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("Authenticated users can write goal_links", { as: "permissive", for: "all", to: ["authenticated"] }),
	pgPolicy("Authenticated users can read goal_links", { as: "permissive", for: "select", to: ["authenticated"] }),
]);
