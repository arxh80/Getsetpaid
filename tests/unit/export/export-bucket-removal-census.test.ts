import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { appSourceFiles, lineOf, parse, parseProblems, relPath } from "../support/app-source";

// ===========================================================================
// Q228 -- WHO REMOVES AN OBJECT, AND FROM WHICH BUCKET.
// ===========================================================================
//
// A closure backup is now several objects: exportStorageKey(job) for part 1
// and exportStorageKey(job, n) for every later part. A code path that removes
// part 1's key and forgets the others leaves the rest of a person's backup in
// the `exports` bucket with nothing pointing at it -- or, worse, removes part
// 1 of a backup that is still kept. So every `.remove(` call in lib/** and
// app/** is on a roll, each with the reason it is safe:
//
//   * on the EXPORTS bucket, only two shapes are allowed:
//       - lib/export/parts.ts, removeClosureParts: every part of ONE FAILED
//         closure backup, by derived key, after the job is marked failed;
//       - lib/export/runner.ts, buildAndStore: the ONE just-uploaded key of an
//         ordinary single archive, removed when stamping it succeeded failed.
//         An ordinary job has no parts by CHECK (export_jobs_part_count_shape).
//   * the retention and erasure runners remove whatever bucket and key the
//     DATABASE named -- public.retention_object_manifest() and
//     public.erasure_purge_manifest() -- so a closure backup's parts are
//     theirs to name there, not here; and the census pins that those two
//     functions choose no key themselves.
//   * the documents and feedback pipelines remove an orphan from THEIR OWN
//     bucket, named by a literal.
//
// A new `.remove(` anywhere is red until it is classified here.
// ===========================================================================

interface RemovalCall {
  file: string;
  fn: string;
  line: number;
  text: string;
}

function enclosingFunctionName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) {
      return p.parent.name.getText();
    }
  }
  return "<module>";
}

export function removalCalls(file: string, text: string): RemovalCall[] {
  const sf = parse(file, text);
  const out: RemovalCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "remove"
    ) {
      out.push({ file, fn: enclosingFunctionName(node), line: lineOf(sf, node), text: node.getText() });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function functionText(file: string, name: string): string {
  const text = readFileSync(`${process.cwd()}/${file}`, "utf8");
  const sf = parse(file, text);
  let found = "";
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText();
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The roll: file -> enclosing function -> why it may remove what it removes. */
const ROLL: { file: string; fn: string; count: number; why: string; bucket: "exports" | "database" | "own" }[] = [
  {
    file: "lib/export/parts.ts",
    fn: "removeClosureParts",
    count: 1,
    bucket: "exports",
    why: "every part of one FAILED closure backup, by derived key, in chunks of 100",
  },
  {
    file: "lib/export/runner.ts",
    fn: "buildAndStore",
    count: 1,
    bucket: "exports",
    why: "the one key an ordinary archive just uploaded, when stamping it succeeded failed -- an ordinary job has no parts",
  },
  {
    file: "lib/retention/runner.ts",
    fn: "removeObjects",
    count: 1,
    bucket: "database",
    why: "the bucket and key public.retention_object_manifest() named",
  },
  {
    file: "lib/erasure/runner.ts",
    fn: "purgeBytes",
    count: 1,
    bucket: "database",
    why: "the bucket and key public.erasure_purge_manifest() named",
  },
  {
    file: "lib/crm/documents.ts",
    fn: "uploadDocumentAction",
    count: 1,
    bucket: "own",
    why: "the documents pipeline's own orphan, after a refused metadata insert",
  },
  {
    file: "lib/feedback/actions.ts",
    fn: "submitFeedbackAction",
    count: 1,
    bucket: "own",
    why: "the feedback pipeline's own orphan screenshot, after a refused insert",
  },
];

describe("every .remove( in lib/** and app/** is on the roll (Q228)", () => {
  const files = appSourceFiles()
    .map((full) => ({ full, rel: relPath(full) }))
    .filter(({ rel }) => rel.startsWith("lib/") || rel.startsWith("app/"));
  const scanned = files.map(({ full, rel }) => {
    const text = readFileSync(full, "utf8");
    return { rel, problems: parseProblems(parse(rel, text)), calls: removalCalls(rel, text) };
  });
  const calls = scanned.flatMap((s) => s.calls);

  it("DENOMINATOR: the walk saw lib and app, parsed every file, and found the known removals", () => {
    expect(scanned.length).toBeGreaterThan(300);
    expect(scanned.filter((s) => s.problems.length > 0).map((s) => s.rel)).toEqual([]);
    for (const entry of ROLL) {
      expect(
        calls.filter((c) => c.file === entry.file).map((c) => c.fn),
        `${entry.file}: the census no longer sees ${entry.fn}'s removal`,
      ).toContain(entry.fn);
    }
  });

  it("and nothing else", () => {
    const unrolled = calls.filter(
      (c) => !ROLL.some((r) => r.file === c.file && r.fn === c.fn),
    );
    expect(
      unrolled.map((c) => `${c.file}:${c.line} ${c.fn}: ${c.text}`),
      "a new .remove( call is not on the roll. If it can reach the exports bucket it must remove EVERY part of a closure backup (removeClosureParts) or be a key the database named; classify it here with the reason",
    ).toEqual([]);
    for (const r of ROLL) {
      expect(
        calls.filter((c) => c.file === r.file && c.fn === r.fn).length,
        `${r.file} ${r.fn}: ${r.why}`,
      ).toBe(r.count);
    }
  });

  it("the runner's one exports removal is the just-uploaded key of the stamp failure", () => {
    const body = functionText("lib/export/runner.ts", "buildAndStore");
    expect(body).toMatch(/const key = exportStorageKey\(job\.id\);/);
    expect(body).toMatch(/if \(stampError\) \{[\s\S]*?bucket\.remove\(\[key\]\)/);
    // ...and buildAndStore is only ever reached for an ordinary job.
    const runner = readFileSync(`${process.cwd()}/lib/export/runner.ts`, "utf8");
    expect(runner).toMatch(/if \(closure\.closure_backup\) \{[\s\S]*?buildNextClosurePart[\s\S]*?\} else \{[\s\S]*?buildAndStore\(/);
  });

  it("removeClosureParts removes derived keys only, and only after reading the job's own part rows", () => {
    const body = functionText("lib/export/parts.ts", "removeClosureParts");
    expect(body).toMatch(/exportStorageKey\(jobId, k\)/);
    expect(body).toMatch(/\.from\(EXPORT_BUCKET\)/);
    expect(body).toMatch(/\.from\("export_job_parts"\)[\s\S]*?\.eq\("job_id", jobId\)/);
  });

  it("the retention runner removes only keys the database named, in its removeObjects(manifest) shape", () => {
    const body = functionText("lib/retention/runner.ts", "removeObjects");
    expect(body).toMatch(/^async function removeObjects\(manifest: ManifestRow\[\]\)/);
    expect(body).toMatch(/for \(const row of manifest\)/);
    expect(body).toMatch(/keys\.push\(row\.object_key\)/);
    expect(body).toMatch(/storage\.from\(bucket\)\.remove\(keys\)/);
    expect(body).not.toMatch(/exportStorageKey|`exports\//);
  });

  it("the erasure runner removes only keys the database named", () => {
    const body = functionText("lib/erasure/runner.ts", "purgeBytes");
    expect(body).toMatch(/rpc\("erasure_purge_manifest"/);
    expect(body).toMatch(/keys\.push\(row\.object_key\)/);
    expect(body).not.toMatch(/exportStorageKey|`exports\//);
  });

  it("the two pipelines remove from their own bucket, by literal", () => {
    const docs = calls.find((c) => c.file === "lib/crm/documents.ts");
    expect(docs?.text).toMatch(/\.from\("documents"\)\.remove\(/);
    const feedback = calls.find((c) => c.file === "lib/feedback/actions.ts");
    expect(feedback?.text).toMatch(/\.from\(BUCKET\)\.remove\(/);
    expect(readFileSync(`${process.cwd()}/lib/feedback/actions.ts`, "utf8")).toMatch(
      /const BUCKET = "feedback-screenshots";/,
    );
  });
});

describe("the removal detector", () => {
  it("finds a removal and names its enclosing function", () => {
    const found = removalCalls(
      "lib/x/a.ts",
      `async function purge(b: any) { await b.storage.from("exports").remove(["k"]); }\nconst g = async () => x.remove([1]);`,
    );
    expect(found.map((c) => c.fn)).toEqual(["purge", "g"]);
  });

  it("ignores a comment and a string", () => {
    expect(removalCalls("lib/x/a.ts", `// bucket.remove([k])\nconst s = "bucket.remove([k])";`)).toEqual([]);
  });
});

