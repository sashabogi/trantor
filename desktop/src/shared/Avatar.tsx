// Brand avatars — the REAL marks, not letters. Sasha: "give all of the LLMs their appropriate
// logos… instead of just having these little letters."
//
// Icons come from simple-icons (bundled SVG paths — the CSP forbids remote assets). Two brands are
// missing from that set by the brands' own trademark policy (OpenAI/codex, Zhipu/glm); they keep a
// styled monogram in their brand color until official assets are dropped in.
//
// Resolution order: an explicit `llm` prop wins (the bus now carries llm+model per peer); else the
// name's brand token; else host-looking names resolve to Claude — an orchestrator session named
// after the laptop is still Claude doing the work, which was exactly the complaint. Anything else
// (projects, humans) stays a deterministic monogram.
import {
  siClaude, siDeepseek, siKimi, siMoonshotai, siGooglegemini, siOpenrouter, siOllama,
} from "simple-icons";

type Brand = { path?: string; hex: string; label: string; mono?: string };

const BRANDS: Record<string, Brand> = {
  claude:     { path: siClaude.path, hex: "#D97757", label: "Claude" },
  anthropic:  { path: siClaude.path, hex: "#D97757", label: "Claude" },
  deepseek:   { path: siDeepseek.path, hex: "#5786FE", label: "DeepSeek" },
  kimi:       { path: siKimi.path, hex: "#8b8bf5", label: "Kimi" },
  moonshot:   { path: siMoonshotai.path, hex: "#8b8bf5", label: "Moonshot" },
  gemini:     { path: siGooglegemini.path, hex: "#8E75B2", label: "Gemini" },
  openrouter: { path: siOpenrouter.path, hex: "#94A3B8", label: "OpenRouter" },
  ollama:     { path: siOllama.path, hex: "#c8c8d0", label: "Ollama" },
  // trademark-restricted in simple-icons — branded monograms until official assets are provided
  codex:      { hex: "#74AA9C", label: "Codex", mono: "co" },
  openai:     { hex: "#74AA9C", label: "OpenAI", mono: "oa" },
  glm:        { hex: "#4268FA", label: "GLM", mono: "Z" },
  zai:        { hex: "#4268FA", label: "Z.ai", mono: "Z" },
  opencode:   { hex: "#9a9aa3", label: "opencode", mono: "oc" },
};

const HOSTISH = /^(macbook|imac|mac[-.]|.*\.local$)|@/i;

/** The brand for a session/name: "deepseek:crm-platform" → deepseek; "MacBook-Pro-M1:x" → claude. */
export function brandFor(name: string, llm?: string): Brand | null {
  const key = (llm || name.split(":")[0] || "").toLowerCase().trim();
  if (BRANDS[key]) return BRANDS[key];
  if (HOSTISH.test(name.split(":")[0] ?? "")) return BRANDS.claude;
  return null;
}

export function hueOf(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ name, llm, size = 52 }: { name: string; llm?: string; size?: number }) {
  const brand = brandFor(name, llm);
  if (brand) {
    return (
      <span className="flex shrink-0 items-center justify-center rounded-full"
            title={brand.label}
            style={{ width: size, height: size, background: `${brand.hex}26` }}>
        {brand.path ? (
          <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} aria-label={brand.label}>
            <path d={brand.path} fill={brand.hex} />
          </svg>
        ) : (
          <span className="font-semibold" style={{ color: brand.hex, fontSize: size * 0.34 }}>{brand.mono}</span>
        )}
      </span>
    );
  }
  const h = hueOf(name);
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full font-semibold"
          style={{
            width: size, height: size, fontSize: size * 0.36,
            background: `hsl(${h} 32% 26%)`, color: `hsl(${h} 55% 72%)`,
          }}>
      {name.slice(0, 2)}
    </span>
  );
}

/** Display name for a sender: the LLM first, the machine second — "claude · MacBook-Pro-M1". */
export function displayName(session: string, llm?: string): string {
  const head = session.split(":")[0] ?? session;
  const brand = brandFor(session, llm);
  if (brand && HOSTISH.test(head)) return `${brand.label.toLowerCase()} · ${head}`;
  return head;
}
