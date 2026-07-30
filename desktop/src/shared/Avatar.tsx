// Brand avatars — the REAL marks, not letters. Sasha: "give all of the LLMs their appropriate
// logos… instead of just having these little letters."
//
// Source: @lobehub/icons-static-svg — the AI-brand icon collection, bundled at build time (the
// CSP forbids remote assets). One source for every mark, including the two simple-icons cannot
// carry (OpenAI honors takedowns there; Zhipu was never contributed): Codex has its own official
// mark, GLM ships as Z.ai. Each SVG is viewBox 24 with currentColor fill, so the brand color is
// just CSS `color` on the wrapper.
//
// Resolution order: an explicit `llm` prop wins (the bus carries llm+model per peer); else the
// name's brand token; else host-looking names resolve to Claude — an orchestrator session named
// after the laptop is still Claude doing the work, which was exactly the complaint. Anything else
// (projects, humans) stays a deterministic monogram.
import claudeSvg from "@lobehub/icons-static-svg/icons/claude.svg?raw";
import deepseekSvg from "@lobehub/icons-static-svg/icons/deepseek.svg?raw";
import kimiSvg from "@lobehub/icons-static-svg/icons/kimi.svg?raw";
import moonshotSvg from "@lobehub/icons-static-svg/icons/moonshot.svg?raw";
import geminiSvg from "@lobehub/icons-static-svg/icons/gemini.svg?raw";
import openrouterSvg from "@lobehub/icons-static-svg/icons/openrouter.svg?raw";
import ollamaSvg from "@lobehub/icons-static-svg/icons/ollama.svg?raw";
import codexSvg from "@lobehub/icons-static-svg/icons/codex.svg?raw";
import openaiSvg from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import zaiSvg from "@lobehub/icons-static-svg/icons/zai.svg?raw";

type Brand = { svg: string; hex: string; label: string };

const BRANDS: Record<string, Brand> = {
  claude:     { svg: claudeSvg, hex: "#D97757", label: "Claude" },
  anthropic:  { svg: claudeSvg, hex: "#D97757", label: "Claude" },
  codex:      { svg: codexSvg, hex: "#e8e8ee", label: "Codex" },
  openai:     { svg: openaiSvg, hex: "#e8e8ee", label: "OpenAI" },
  deepseek:   { svg: deepseekSvg, hex: "#5786FE", label: "DeepSeek" },
  kimi:       { svg: kimiSvg, hex: "#8b8bf5", label: "Kimi" },
  moonshot:   { svg: moonshotSvg, hex: "#8b8bf5", label: "Moonshot" },
  glm:        { svg: zaiSvg, hex: "#5ea0f5", label: "GLM (Z.ai)" },
  zai:        { svg: zaiSvg, hex: "#5ea0f5", label: "Z.ai" },
  gemini:     { svg: geminiSvg, hex: "#8E75B2", label: "Gemini" },
  openrouter: { svg: openrouterSvg, hex: "#94A3B8", label: "OpenRouter" },
  ollama:     { svg: ollamaSvg, hex: "#c8c8d0", label: "Ollama" },
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
            style={{ width: size, height: size, background: `${brand.hex}22` }}>
        <span aria-label={brand.label}
              style={{ color: brand.hex, fontSize: size * 0.55, lineHeight: 0 }}
              dangerouslySetInnerHTML={{ __html: brand.svg }} />
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
  if (brand && HOSTISH.test(head)) return `${brand.label.toLowerCase().split(" ")[0]} · ${head}`;
  return head;
}
