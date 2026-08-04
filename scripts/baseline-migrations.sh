#!/usr/bin/env bash
# One-off: tell Supabase which migrations are already applied in production.
#
# Every migration in this repo was applied by hand through the SQL editor, so
# supabase_migrations.schema_migrations never learned about them and `db push`
# tries to replay the whole history on each run. `migration repair` writes the
# bookkeeping rows without executing any SQL.
#
# Run once, from a machine linked to the project:
#   npx --yes supabase@latest link --project-ref aqhpjlkxlpqfcypcyhdj
#   ./scripts/baseline-migrations.sh
#
# The ref is the subdomain of NEXT_PUBLIC_SUPABASE_URL — public, it ships in the
# browser bundle. The link step asks for the database password.
#
# Then `supabase db push` applies only what is genuinely new, and the
# db-migrate workflow starts working on merge.
set -euo pipefail

# The CLI is not a project dependency and may not be installed globally.
if command -v supabase >/dev/null 2>&1; then
  SUPABASE="supabase"
else
  SUPABASE="npx --yes supabase@latest"
fi

VERSIONS=$(ls supabase/migrations/*.sql | xargs -n1 basename | sed 's/_.*//')

echo "Marking $(echo "$VERSIONS" | wc -l | tr -d ' ') migrations as applied (no SQL runs):"
for v in $VERSIONS; do
  echo "  $v"
  $SUPABASE migration repair --status applied "$v"
done

echo
echo "Done. Verify with:  $SUPABASE migration list"
