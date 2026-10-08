import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function personaName(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value || "")) throw new Error("persona must contain only letters, digits, underscores or hyphens");
  return value;
}

export function runnerPersona(env, agent) {
  return personaName(env.CREW_PERSONA || agent);
}

export function allocatePersona({ dir, project, agent, model = "", name, occupied = [], dry = false }) {
  personaName(agent);
  const folder = join(dir, "personas", encodeURIComponent(project));
  if (!dry) mkdirSync(folder, { recursive: true });
  for (let n = 1; ; n++) {
    const persona = personaName(name || (n === 1 ? agent : `${agent}-${n}`));
    if (occupied.includes(persona)) {
      if (name) throw new Error(`persona ${persona} is already active`);
      continue;
    }
    const file = join(folder, `${persona}.json`);
    const seat = { persona, agent, model };
    if (dry) return seat;
    try {
      writeFileSync(file, JSON.stringify(seat), { flag: "wx", mode: 0o600 });
      return seat;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!name) continue;
      const prior = JSON.parse(readFileSync(file, "utf8"));
      if (prior.agent !== agent) throw new Error(`persona ${persona} runs ${prior.agent}; use swap to change its agent`);
      return { ...prior, model };
    }
  }
}

export function updatePersona({ dir, project, persona, agent, model = "" }) {
  const folder = join(dir, "personas", encodeURIComponent(project));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${personaName(persona)}.json`), JSON.stringify({ persona, agent, model }), { mode: 0o600 });
}
