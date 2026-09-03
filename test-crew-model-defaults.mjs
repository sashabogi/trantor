#!/usr/bin/env node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { drillEnv } from "./drill-env.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), "trantor-crew-models-"));
const fakebin = join(home, "fakebin");
let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

try {
  mkdirSync(fakebin, { recursive: true });
  const opencode = join(fakebin, "opencode");
  writeFileSync(opencode, `#!/bin/bash
case "$2" in
  qwen) echo qwen/qwen3-coder-plus ;;
  zai-coding-plan) echo zai-coding-plan/glm-5.3-flash ;;
  deepseek) echo deepseek/deepseek-v4-pro ;;
esac
`);
  chmodSync(opencode, 0o755);
  const python = join(fakebin, "python3");
  writeFileSync(python, `#!/bin/bash
case "$*" in
  *qwen/qwen3-coder-plus*)
    if [ -n "$ROUTE_BAD_PROVIDER" ]; then echo '{"qualified":"deepseek/deepseek-v4-flash"}'
    else echo '{"qualified":"qwen/qwen3-coder-plus"}'; fi ;;
  *zai-coding-plan/glm-5.3-flash*) echo '{"qualified":"zai-coding-plan/glm-5.3-flash"}' ;;
  *deepseek/deepseek-v4-pro*) echo '{"qualified":"deepseek/deepseek-v4-pro"}' ;;
  "*--provider badmid*") ;;
  *) exec /usr/bin/python3 "$@" ;;
esac
`);
  chmodSync(python, 0o755);

  const run = spawnSync("bash", [join(root, "bin/crew.sh"), "up", "qwen", "glm"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...drillEnv(),
      HOME: home,
      PATH: `${fakebin}:${process.env.PATH}`,
      CREW_DRY_RUN: "1",
      CREW_MUX: "tmux",
      RELAY_PROJECT: "model-default-test",
    },
  });
  const output = `${run.stdout}${run.stderr}`;
  console.log("# unpinned provider-seat model defaults");
  check("launcher exits cleanly", run.status === 0, output);
  check("unpinned qwen routes inside qwen", output.includes("qwen: live model qwen/qwen3-coder-plus"));
  check("qwen runner receives the resolved model", output.includes("CREW_MODEL=qwen/qwen3-coder-plus"));
  check("unpinned glm maps to the coding-plan provider", output.includes("glm: live model zai-coding-plan/glm-5.3-flash"));
  check("glm runner receives the resolved model", output.includes("CREW_MODEL=zai-coding-plan/glm-5.3-flash"));
  check("neither seat falls through to DeepSeek", !output.includes("CREW_MODEL=deepseek/"));

  const badRoute = spawnSync("bash", [join(root, "bin/crew.sh"), "up", "qwen"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...drillEnv(),
      HOME: home,
      PATH: `${fakebin}:${process.env.PATH}`,
      CREW_DRY_RUN: "1",
      CREW_MUX: "tmux",
      RELAY_PROJECT: "model-default-test",
      ROUTE_BAD_PROVIDER: "1",
    },
  });
  const badOutput = `${badRoute.stdout}${badRoute.stderr}`;
  check("cross-provider router output aborts launch", badRoute.status !== 0, badOutput);
  check("cross-provider fallback is explained", badOutput.includes("refusing cross-provider fallback"), badOutput);

  // A middle seat's model resolution can fail while the seats around it are perfectly launchable —
  // that must SKIP the one bad seat, not exit crew.sh from inside the loop and strand the seats that
  // already spawned earlier. #6110.
  const midFail = spawnSync("bash", [join(root, "bin/crew.sh"), "up", "qwen", "badmid", "glm"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...drillEnv(),
      HOME: home,
      PATH: `${fakebin}:${process.env.PATH}`,
      CREW_DRY_RUN: "1",
      CREW_MUX: "tmux",
      RELAY_PROJECT: "model-default-test",
    },
  });
  const midOutput = `${midFail.stdout}${midFail.stderr}`;
  console.log("# middle-seat resolution failure in a three-seat batch");
  check("first seat (qwen) still launches", midOutput.includes("qwen: live model qwen/qwen3-coder-plus") && midOutput.includes("qwen pane in"), midOutput);
  check("third seat (glm) still launches", midOutput.includes("glm: live model zai-coding-plan/glm-5.3-flash") && midOutput.includes("glm pane in"), midOutput);
  check("middle seat produced no pane / no model", !midOutput.includes("badmid pane in") && !midOutput.includes("CREW_MODEL=badmid"), midOutput);
  check("exit code is non-zero because a seat was skipped", midFail.status !== 0, midOutput);
  check("report names the skipped seat", /skip/i.test(midOutput) && midOutput.includes("badmid"), midOutput);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
