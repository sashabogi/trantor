import { asString } from "./decode.mjs";

export function machineLabel(config = {}) {
  const label = asString(config?.machineLabel);
  return label && /^[a-z0-9-]{1,24}$/.test(label) ? label : "";
}
