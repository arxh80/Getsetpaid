// SCRATCH PLANT (Phase 10 Task 9, G24 proof). Never merged: the Semgrep step must go red on it.
export function plant(req: { query: { x: string } }): unknown {
  return eval(req.query.x);
}
