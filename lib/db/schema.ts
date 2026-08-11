/**
 * Drizzle schema — generated, not hand-written.
 *
 * Regenerate from the live database with `npm run db:pull`, which rewrites
 * `drizzle/schema.ts` and `drizzle/relations.ts`. This file only re-exports
 * them so regenerating never clobbers anything written by hand.
 *
 * The live database is the source of truth, not `supabase/migrations` — 19
 * tables used by the app were never in a migration file.
 *
 * KNOWN drizzle-kit BUG: it emits `.default(')` instead of `.default('')` for
 * columns whose default is an empty string, which does not parse. After every
 * `db:pull`, re-apply:
 *
 *   perl -pi -e "s/\.default\('\)/.default('')/g" drizzle/schema.ts
 *
 * Affects outreach_sequence_steps.body_template, social_yolo_posts.hook and
 * social_yolo_posts.cta.
 */

export * from "../../drizzle/schema";
export * from "../../drizzle/relations";
