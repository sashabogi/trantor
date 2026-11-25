#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(ROOT, ".agent-bus-out", `v2-style-rule-${process.pid}`);
const CONFIG = join(ROOT, "oxlint.config.ts");
let failed = 0;
const ok = (name, condition, detail = "") => {
  console.log(`${condition ? "  ✓" : "  ✗"} ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  if (!condition) failed++;
};
const lint = (relative, source) => {
  const file = join(OUT, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, source);
  const run = spawnSync("npx", ["oxlint", "--config", CONFIG, file], { cwd: ROOT, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
};

try {
  console.log("v2 primitive and design-token lint rule");
  const bad = lint("desktop/src/v2/screens/RawFixture.tsx", `export const Bad = () => <><input type="checkbox" /><input type="radio" /><select /></>;\n`);
  ok("a raw checkbox added to a v2 screen fails lint", bad.status === 1 && /raw checkbox/.test(bad.output), bad.output);
  ok("raw radio and select fail too", (bad.output.match(/raw (?:radio|select)/g) || []).length === 2, bad.output);

  const colors = [
    ["hex", `export const color = "#FFFFFF";\n`],
    ["rgb", `export const color = "rgb(0,0,0)";\n`],
    ["Tailwind palette", `export const color = "bg-red-500";\n`],
  ];
  for (const [name, source] of colors) {
    const result = lint(`desktop/src/v2/screens/${name.replace(" ", "")}Fixture.ts`, source);
    ok(`${name} colours fail`, result.status === 1 && /theme token/.test(result.output), result.output);
  }

  const sized = lint("desktop/src/v2/screens/SizeFixture.ts", `export const row = "px-2 text-[11.5px] rounded-[7px]";\n`);
  ok("a font size or radius off the 2.0 scale fails", sized.status === 1 && (sized.output.match(/2\.0 scale/g) || []).length >= 1, sized.output);
  const primitive = lint("desktop/src/v2/ui/SizeFixture.ts", `export const row = "hover:text-[12.5px]";\n`);
  ok("the scale holds inside v2/ui as well", primitive.status === 1 && /2\.0 scale/.test(primitive.output), primitive.output);
  const scaled = lint("desktop/src/v2/screens/ScaleFixture.ts", `export const row = "text-v2-body rounded-lg h-[19px] w-[36px]";\n`);
  ok("scale names and plain pixel sizes of boxes pass", scaled.status === 0, scaled.output);

  const clean = lint("desktop/src/v2/screens/CleanFixture.tsx", `export const Good = () => <><Checkbox /><Select /><div className="bg-[var(--v2-panel)]">var(--v2-text)</div></>;\n`);
  ok("shared primitives and tokens pass", clean.status === 0, clean.output);

  const chart = lint("desktop/src/v2/screens/Usage/DailyChart.tsx", `export const chartColor = "#8AA8FF";\n`);
  ok("the named Usage chart colour exception passes", chart.status === 0, chart.output);

  const outside = lint("desktop/src/classic/RawFixture.tsx", `export const Classic = () => <input type="checkbox" className="bg-white" />;\n`);
  ok("the rule does not leak outside the v2 shell", outside.status === 0, outside.output);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
