#!/usr/bin/env bash
# Resumable: skips any mutant whose .summary already exists. Resets at the end.
cd "$(dirname "$0")/../../../.."
OUT=.superpowers/sdd/plan-the-whole-build-synthetic-thompson/mutation-results
for m in supabase/tests/mutations/*.sql; do
  n=$(basename "$m" .sql)
  [ -s "$OUT/$n.summary" ] && continue
  echo "$(date '+%F %T') START $n" >> "$OUT/progress.log"
  bash supabase/tests/mutations/run-mutation.sh "$m" "$OUT" all > /dev/null 2>&1
  echo "$(date '+%F %T') END $n exit=$?" >> "$OUT/progress.log"
done
npx supabase db reset --local > "$OUT/final-reset.log" 2>&1
echo "$(date '+%F %T') ALL DONE" >> "$OUT/progress.log"
