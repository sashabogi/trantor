// #13474: a silent stall used to say only that it was silent. This names the likeliest cause from
// evidence the runner already holds; load and the clock are injected so tests never read the machine.
import { loadavg, cpus } from "node:os";

const AUTH_RE = /\b(401|403|unauthori[sz]ed|invalid api key|not logged in|authentication)\b/i;
const QUOTA_RE = /\b(429|rate.?limit|quota|insufficient (credit|balance)|usage limit|exhausted)\b/i;

/** One short phrase: high load, a provider signal seen in the turn text, else "unknown". */
export function stallCause({ text = "", load = loadavg()[0], cpuCount = cpus().length } = {}) {
  if (load > 4 * Math.max(1, cpuCount)) return `machine overloaded (1-min load ${load.toFixed(1)} on ${cpuCount} CPUs)`;
  if (AUTH_RE.test(text)) return "provider auth signal seen in the CLI output";
  if (QUOTA_RE.test(text)) return "provider quota or rate-limit signal seen in the CLI output";
  return "unknown";
}
