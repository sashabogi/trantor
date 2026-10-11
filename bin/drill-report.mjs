import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { signedPost } from "../hooks/lib/api.mjs";

// A PASS assertion is evidence, not a verdict: every mapped step must finish cleanly.
export class DrillReport {
  constructor(map, path, { project, session }) {
    this.map = map;
    this.path = path;
    this.project = project;
    this.session = session;
    this.steps = {};
    this.closures = {};
    for (const { steps, autoClose, recipe } of Object.values(map)) {
      if (autoClose || !recipe) continue;
      for (const step of steps) this.steps[step] = {
        complete: true, checks: [{ status: "skip", assertion: recipe, evidence: "" }],
      };
    }
    this.write();
  }

  record(step, status, assertion, evidence = "") {
    (this.steps[step] ||= { complete: false, checks: [] }).checks.push({ status, assertion, evidence });
    this.write();
  }

  complete(step) {
    (this.steps[step] ||= { complete: false, checks: [] }).complete = true;
    this.write();
  }

  cardsFor(step) {
    return Object.keys(this.map).filter(id => this.map[id].steps.includes(step));
  }

  results() {
    return Object.fromEntries(Object.entries(this.map).map(([id, { steps }]) => {
      const evidence = steps.flatMap(step => {
        const row = this.steps[step];
        return row?.checks.length
          ? row.checks.map(check => `${step} ${check.status}: ${check.assertion}${check.evidence ? ` — ${check.evidence}` : ""}`)
          : [`${step} fail: not run`];
      });
      const complete = steps.every(step => {
        const row = this.steps[step];
        return row?.complete && row.checks.length > 0 && row.checks.every(check => check.status !== "fail");
      });
      const skipped = steps.some(step => this.steps[step]?.checks.some(check => check.status === "skip"));
      return [id, { status: complete ? skipped ? "skip" : "pass" : "fail", evidence, closure: this.closures[id] || "not attempted" }];
    }));
  }

  write() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.results(), null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, this.path);
  }

  exitCode() {
    // Manual recipes stay visible as SKIP; only missing/failed proof or a refused close is red.
    // "gone" is neither: the seam proved, the card just isn't on the board anymore (#11498).
    return Object.values(this.results()).some(result => result.status === "fail" || result.closure.startsWith("failed:")) ? 1 : 0;
  }

  async closePassed() {
    for (const [id, result] of Object.entries(this.results())) {
      if (!this.map[id].autoClose || result.status !== "pass" || this.closures[id]) continue;
      const response = await signedPost("/task/update", {
        id: Number(id), project: this.project, by: this.session, status: "done",
        note: `Drill: trantor drill PASS\n${result.evidence.join("\n")}`.slice(0, 2000),   // "Drill:" prefix: the hub's done gate (#6452) reads it as the drill line
      }, { project: this.project, session: this.session, timeoutMs: 15000 });
      // A 404 on /task/update is the hub saying the card isn't on the board — the fleet cap deletes
      // old cards (#11142), so a green drill can hold a stale map. That is not a failed seam: record
      // it as gone and stay green. Any other refusal (403 cross-project, 409 done-gate, 500) is a
      // real hub "no" and stays red (#11498). Never renumber the map to chase new card ids.
      this.closures[id] = response.ok && response.json?.task?.status === "done"
        && response.json.task.id === Number(id) && response.json.task.project === this.project
        ? "done"
        : response.status === 404 && response.json?.error === "no such task" ? "gone: card no longer on the board"
        : `failed: hub ${response.status} ${response.json?.error || "did not confirm done"}`;
      this.write();
    }
    // "gone" closures are not failures — the verdict must not red on a stale map.
    return Object.values(this.closures).every(value => !value.startsWith("failed:"));
  }
}
