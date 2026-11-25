import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const V2_ROOT = "desktop/src/v2/";
const V2_UI = "desktop/src/v2/ui/";
const ALLOWLIST = [
  "desktop/src/v2/ui/identity.ts",
  "desktop/src/v2/ui/BottomPanel/xtermShell.ts",
  "desktop/src/v2/screens/Usage/DailyChart.tsx",
] as const;
const HEX = /#(?:[\da-fA-F]{8}|[\da-fA-F]{6}|[\da-fA-F]{4}|[\da-fA-F]{3})\b/;
const RGB = /\brgba?\(/;
const PALETTE = /^(?:bg|text|border|from|via|to|ring|outline|shadow|decoration|accent|caret|fill|stroke)-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950))(?:\/\d+)?$/;

// #14208: font sizes and radii come from the scale, in primitives too.
const OFF_SCALE = /(?:^|[\s:!])(?:text|rounded(?:-(?:tl|tr|bl|br|t|b|l|r|s|e))?)-\[\d+(?:\.\d+)?px\]/;

function rawControl(node: ESTree.JSXOpeningElement): string | null {
  if (node.name.type !== "JSXIdentifier") return null;
  if (node.name.name === "select") return "select";
  if (node.name.name !== "input") return null;
  for (const attribute of node.attributes) {
    if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "type") continue;
    if (attribute.value?.type === "Literal" && (attribute.value.value === "checkbox" || attribute.value.value === "radio")) {
      return attribute.value.value;
    }
  }
  return null;
}

function hasRawColor(value: string): boolean {
  if (HEX.test(value) || RGB.test(value)) return true;
  return value.split(/\s+/).some(token => PALETTE.test((token.split(":").pop() ?? "").replace(/^!/, "")));
}

export const noRawV2StylesRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require v2 control primitives and theme tokens outside the primitive and named colour exceptions." },
    messages: {
      rawControl: "Use a v2/ui control primitive instead of a raw {{control}}.",
      rawColor: "Use a --v2-* theme token instead of a raw hex, rgb colour, or Tailwind palette class.",
      offScale: "Use the 2.0 scale: text-v2-micro, -small, -body, -base, -title, -heading, -display, and rounded-sm, -md, -lg, -xl or -full.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (!filename.includes(V2_ROOT) || ALLOWLIST.some(file => filename.endsWith(file))) return {};
    const primitive = filename.includes(V2_UI);
    const checkColor = (node: ESTree.Node, value: string) => {
      if (!primitive && hasRawColor(value)) context.report({ node, messageId: "rawColor" });
      if (OFF_SCALE.test(value)) context.report({ node, messageId: "offScale" });
    };
    return {
      JSXOpeningElement(node) {
        if (primitive) return;
        const control = rawControl(node);
        if (control) context.report({ node, messageId: "rawControl", data: { control } });
      },
      Literal(node) {
        if (typeof node.value === "string") checkColor(node, node.value);
      },
      TemplateElement(node) {
        checkColor(node, node.value.raw);
      },
    };
  },
});
