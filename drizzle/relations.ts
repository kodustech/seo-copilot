import { relations } from "drizzle-orm/relations";
import { goalRecurrences, goals, scheduledJobs, jobRuns, linkedinCommenters, linkedinCommenterTriggers, xReplyCandidates, xReplyDrafts, crmCompanies, crmActivities, researchTables, researchRows, task, keywords, articles, crmComments, socialMentions, outreachProspects, outreachSequences, outreachAutoEnrollRules, outreachEnrollments, outreachReplyThreads, outreachReplyMessages, researchPeopleSnapshots, researchRuns, outreachMailboxes, researchPeople, crmContacts, kanbanColumns, growthWorkItems, outreachSendTasks, outreachSequenceSteps, xTargetAccounts, researchEvidence, personas, personaChannels, personaActivities, personaActivityMetrics, personaLearnings, goalLinks } from "./schema";

export const goalsRelations = relations(goals, ({one, many}) => ({
	goalRecurrence: one(goalRecurrences, {
		fields: [goals.recurrenceId],
		references: [goalRecurrences.id]
	}),
	goalLinks: many(goalLinks),
}));

export const goalRecurrencesRelations = relations(goalRecurrences, ({many}) => ({
	goals: many(goals),
}));

export const jobRunsRelations = relations(jobRuns, ({one}) => ({
	scheduledJob: one(scheduledJobs, {
		fields: [jobRuns.jobId],
		references: [scheduledJobs.id]
	}),
}));

export const scheduledJobsRelations = relations(scheduledJobs, ({many}) => ({
	jobRuns: many(jobRuns),
}));

export const linkedinCommenterTriggersRelations = relations(linkedinCommenterTriggers, ({one}) => ({
	linkedinCommenter: one(linkedinCommenters, {
		fields: [linkedinCommenterTriggers.commenterId],
		references: [linkedinCommenters.id]
	}),
}));

export const linkedinCommentersRelations = relations(linkedinCommenters, ({one, many}) => ({
	linkedinCommenterTriggers: many(linkedinCommenterTriggers),
	researchTable: one(researchTables, {
		fields: [linkedinCommenters.researchTableId],
		references: [researchTables.id]
	}),
}));

export const xReplyDraftsRelations = relations(xReplyDrafts, ({one}) => ({
	xReplyCandidate: one(xReplyCandidates, {
		fields: [xReplyDrafts.candidateId],
		references: [xReplyCandidates.id]
	}),
}));

export const xReplyCandidatesRelations = relations(xReplyCandidates, ({one, many}) => ({
	xReplyDrafts: many(xReplyDrafts),
	xTargetAccount: one(xTargetAccounts, {
		fields: [xReplyCandidates.targetAccountId],
		references: [xTargetAccounts.id]
	}),
}));

export const crmActivitiesRelations = relations(crmActivities, ({one}) => ({
	crmCompany: one(crmCompanies, {
		fields: [crmActivities.companyId],
		references: [crmCompanies.id]
	}),
}));

export const crmCompaniesRelations = relations(crmCompanies, ({many}) => ({
	crmActivities: many(crmActivities),
	crmComments: many(crmComments),
	outreachEnrollments: many(outreachEnrollments),
	crmContacts: many(crmContacts),
}));

export const researchRowsRelations = relations(researchRows, ({one, many}) => ({
	researchTable: one(researchTables, {
		fields: [researchRows.tableId],
		references: [researchTables.id]
	}),
	researchPeopleSnapshots: many(researchPeopleSnapshots),
	researchPeople: many(researchPeople),
	researchEvidences: many(researchEvidence),
}));

export const researchTablesRelations = relations(researchTables, ({many}) => ({
	researchRows: many(researchRows),
	researchRuns: many(researchRuns),
	linkedinCommenters: many(linkedinCommenters),
}));

export const keywordsRelations = relations(keywords, ({one, many}) => ({
	task: one(task, {
		fields: [keywords.taskId],
		references: [task.id]
	}),
	articles: many(articles),
}));

export const taskRelations = relations(task, ({many}) => ({
	keywords: many(keywords),
	articles: many(articles),
}));

export const articlesRelations = relations(articles, ({one}) => ({
	task: one(task, {
		fields: [articles.taskId],
		references: [task.id]
	}),
	keyword: one(keywords, {
		fields: [articles.keywordId],
		references: [keywords.id]
	}),
}));

export const crmCommentsRelations = relations(crmComments, ({one}) => ({
	crmCompany: one(crmCompanies, {
		fields: [crmComments.companyId],
		references: [crmCompanies.id]
	}),
}));

export const outreachProspectsRelations = relations(outreachProspects, ({one, many}) => ({
	socialMention: one(socialMentions, {
		fields: [outreachProspects.sourceMentionId],
		references: [socialMentions.id]
	}),
	outreachEnrollments: many(outreachEnrollments),
}));

export const socialMentionsRelations = relations(socialMentions, ({many}) => ({
	outreachProspects: many(outreachProspects),
}));

export const outreachAutoEnrollRulesRelations = relations(outreachAutoEnrollRules, ({one}) => ({
	outreachSequence: one(outreachSequences, {
		fields: [outreachAutoEnrollRules.sequenceId],
		references: [outreachSequences.id]
	}),
}));

export const outreachSequencesRelations = relations(outreachSequences, ({one, many}) => ({
	outreachAutoEnrollRules: many(outreachAutoEnrollRules),
	outreachEnrollments: many(outreachEnrollments),
	outreachMailbox: one(outreachMailboxes, {
		fields: [outreachSequences.mailboxId],
		references: [outreachMailboxes.id]
	}),
	outreachReplyThreads: many(outreachReplyThreads),
	outreachSequenceSteps: many(outreachSequenceSteps),
}));

export const outreachEnrollmentsRelations = relations(outreachEnrollments, ({one, many}) => ({
	crmCompany: one(crmCompanies, {
		fields: [outreachEnrollments.crmCompanyId],
		references: [crmCompanies.id]
	}),
	outreachProspect: one(outreachProspects, {
		fields: [outreachEnrollments.outreachProspectId],
		references: [outreachProspects.id]
	}),
	outreachSequence: one(outreachSequences, {
		fields: [outreachEnrollments.sequenceId],
		references: [outreachSequences.id]
	}),
	outreachReplyThreads: many(outreachReplyThreads),
	outreachSendTasks: many(outreachSendTasks),
}));

export const outreachReplyMessagesRelations = relations(outreachReplyMessages, ({one}) => ({
	outreachReplyThread: one(outreachReplyThreads, {
		fields: [outreachReplyMessages.threadId],
		references: [outreachReplyThreads.id]
	}),
}));

export const outreachReplyThreadsRelations = relations(outreachReplyThreads, ({one, many}) => ({
	outreachReplyMessages: many(outreachReplyMessages),
	outreachEnrollment: one(outreachEnrollments, {
		fields: [outreachReplyThreads.enrollmentId],
		references: [outreachEnrollments.id]
	}),
	outreachMailbox: one(outreachMailboxes, {
		fields: [outreachReplyThreads.mailboxId],
		references: [outreachMailboxes.id]
	}),
	outreachSequence: one(outreachSequences, {
		fields: [outreachReplyThreads.sequenceId],
		references: [outreachSequences.id]
	}),
}));

export const researchPeopleSnapshotsRelations = relations(researchPeopleSnapshots, ({one}) => ({
	researchRow: one(researchRows, {
		fields: [researchPeopleSnapshots.rowId],
		references: [researchRows.id]
	}),
}));

export const researchRunsRelations = relations(researchRuns, ({one}) => ({
	researchTable: one(researchTables, {
		fields: [researchRuns.tableId],
		references: [researchTables.id]
	}),
}));

export const outreachMailboxesRelations = relations(outreachMailboxes, ({many}) => ({
	outreachSequences: many(outreachSequences),
	outreachReplyThreads: many(outreachReplyThreads),
}));

export const researchPeopleRelations = relations(researchPeople, ({one}) => ({
	researchRow: one(researchRows, {
		fields: [researchPeople.rowId],
		references: [researchRows.id]
	}),
}));

export const crmContactsRelations = relations(crmContacts, ({one}) => ({
	crmCompany: one(crmCompanies, {
		fields: [crmContacts.companyId],
		references: [crmCompanies.id]
	}),
}));

export const growthWorkItemsRelations = relations(growthWorkItems, ({one, many}) => ({
	kanbanColumn: one(kanbanColumns, {
		fields: [growthWorkItems.columnId],
		references: [kanbanColumns.id]
	}),
	goalLinks: many(goalLinks),
}));

export const kanbanColumnsRelations = relations(kanbanColumns, ({many}) => ({
	growthWorkItems: many(growthWorkItems),
}));

export const outreachSendTasksRelations = relations(outreachSendTasks, ({one}) => ({
	outreachEnrollment: one(outreachEnrollments, {
		fields: [outreachSendTasks.enrollmentId],
		references: [outreachEnrollments.id]
	}),
	outreachSequenceStep: one(outreachSequenceSteps, {
		fields: [outreachSendTasks.stepId],
		references: [outreachSequenceSteps.id]
	}),
}));

export const outreachSequenceStepsRelations = relations(outreachSequenceSteps, ({one, many}) => ({
	outreachSendTasks: many(outreachSendTasks),
	outreachSequence: one(outreachSequences, {
		fields: [outreachSequenceSteps.sequenceId],
		references: [outreachSequences.id]
	}),
}));

export const xTargetAccountsRelations = relations(xTargetAccounts, ({many}) => ({
	xReplyCandidates: many(xReplyCandidates),
}));

export const researchEvidenceRelations = relations(researchEvidence, ({one}) => ({
	researchRow: one(researchRows, {
		fields: [researchEvidence.rowId],
		references: [researchRows.id]
	}),
}));

export const personaChannelsRelations = relations(personaChannels, ({one, many}) => ({
	persona: one(personas, {
		fields: [personaChannels.personaId],
		references: [personas.id]
	}),
	personaActivities: many(personaActivities),
}));

export const personasRelations = relations(personas, ({many}) => ({
	personaChannels: many(personaChannels),
	personaActivities: many(personaActivities),
	personaLearnings: many(personaLearnings),
}));

export const personaActivitiesRelations = relations(personaActivities, ({one, many}) => ({
	persona: one(personas, {
		fields: [personaActivities.personaId],
		references: [personas.id]
	}),
	personaChannel: one(personaChannels, {
		fields: [personaActivities.channelId],
		references: [personaChannels.id]
	}),
	personaActivity: one(personaActivities, {
		fields: [personaActivities.parentActivityId],
		references: [personaActivities.id],
		relationName: "personaActivities_parentActivityId_personaActivities_id"
	}),
	personaActivities: many(personaActivities, {
		relationName: "personaActivities_parentActivityId_personaActivities_id"
	}),
	personaActivityMetrics: many(personaActivityMetrics),
}));

export const personaActivityMetricsRelations = relations(personaActivityMetrics, ({one}) => ({
	personaActivity: one(personaActivities, {
		fields: [personaActivityMetrics.activityId],
		references: [personaActivities.id]
	}),
}));

export const personaLearningsRelations = relations(personaLearnings, ({one}) => ({
	persona: one(personas, {
		fields: [personaLearnings.personaId],
		references: [personas.id]
	}),
}));

export const goalLinksRelations = relations(goalLinks, ({one}) => ({
	goal: one(goals, {
		fields: [goalLinks.goalId],
		references: [goals.id]
	}),
	growthWorkItem: one(growthWorkItems, {
		fields: [goalLinks.workItemId],
		references: [growthWorkItems.id]
	}),
}));