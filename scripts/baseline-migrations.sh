#!/usr/bin/env bash
# One-off: tell Supabase which migrations are already applied in production.
#
# Every migration in this repo was applied by hand through the SQL editor, so
# supabase_migrations.schema_migrations never learned about them and `db push`
# tries to replay the whole history on each run. `migration repair` writes the
# bookkeeping rows without executing any SQL.
#
# Run once, from a machine linked to the project:
#   supabase link --project-ref <ref>
#   ./scripts/baseline-migrations.sh
#
# Then `supabase db push` applies only what is genuinely new, and the
# db-migrate workflow starts working on merge.
set -euo pipefail

VERSIONS=$(ls supabase/migrations/*.sql | xargs -n1 basename | sed 's/_.*//')

echo "Marking $(echo "$VERSIONS" | wc -l | tr -d ' ') migrations as applied (no SQL runs):"
for v in $VERSIONS; do
  echo "  $v"
  supabase migration repair --status applied "$v"
done

echo
echo "Done. Verify with:  supabase migration list"
