// THE HINTS THE ERASURE RUNNER CAN BE HANDED, DERIVED FROM THE MIGRATIONS.
//
// Fix round 2, review finding N5. `failure-sentence.test.ts` said, in the
// comment stating the first of the two properties it exists to hold, that
// "the hints are asserted against the list of hints in the migrations, so a
// guard added later with no sentence lands as a red test" -- and the list was
// a hand-written array of eight strings that nothing read a migration for. A
// guard added later landed as NOTHING, which is `census-audit.md`'s bug class
// (a derived subject set with a fragile matching surface) inside the test
// written to close the last instance of it. It was already short: three hints
// `private.erase_organisation()` raises are reachable from an ACCOUNT erasure
// through step 8b, and `reference_survived_the_purge` -- the literal twin of
// `reference_survived_the_delete`, whose sentence is "This needs a person to
// look at it" -- was falling through to "It will be retried", which is the
// precise wrong sentence finding I4 was raised about.
//
// SO THE ROLL IS DERIVED. `public.run_erasure_job()` is the one thing
// `lib/erasure/runner.ts` calls, so every `raise ... hint = '<x>'` inside its
// transaction can reach `recordFailure()`. This walks that function's LATEST
// definition (the migrations, in filename order, through the shared
// `latestFunctionDefinition()` lexer) and then every `private.`/`public.`
// function it calls, transitively, collecting each literal hint. A guard
// added to any of them -- or to a new function one of them starts calling --
// lands in `HINTS` on the next run and reds the test if it has no sentence.
//
// TWO LIMITS, STATED RATHER THAN DISCOVERED:
//   * a function created outside the migrations, or under a name this walker
//     cannot resolve, is skipped -- `latestFunctionDefinition()` THROWS in
//     the ambiguous cases it knows about, and those throws are swallowed here
//     because most of the skipped names are not functions at all (they are
//     `public.<table>` references inside SQL). The roll is therefore a floor.
//   * a hint built at run time rather than written as a literal would be
//     invisible. There is none; every `using ... hint =` in the erasure chain
//     is a single-quoted constant, which is itself worth keeping true.

import { latestFunctionDefinition, readMigrations } from "../support/sql-definitions";

/** Where the runner enters the database. Everything below it is derived. */
export const RUNNER_ENTRY_POINT = "public.run_erasure_job";

const HINT = /\bhint\s*=\s*'([a-z0-9_]+)'/g;
const CALL = /\b(private|public)\.([a-z_][a-z0-9_]*)\s*\(/g;

export interface DerivedHints {
  readonly hints: readonly string[];
  /** Every function whose body was read, for the test to assert it is not one. */
  readonly functions: readonly string[];
}

export function deriveErasureHints(entry: string = RUNNER_ENTRY_POINT): DerivedHints {
  const migrations = readMigrations();
  const seen = new Set<string>();
  const hints = new Set<string>();
  const read: string[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);

    let body: string;
    try {
      body = latestFunctionDefinition(name, migrations).body;
    } catch {
      // Not a function defined in the migrations (usually a table name), or
      // one this walker deliberately refuses to answer for. See the header.
      continue;
    }
    read.push(name);

    for (const match of body.matchAll(HINT)) hints.add(match[1]);
    for (const match of body.matchAll(CALL)) queue.push(`${match[1]}.${match[2]}`);
  }

  return {
    hints: [...hints].sort(),
    functions: read.sort(),
  };
}
