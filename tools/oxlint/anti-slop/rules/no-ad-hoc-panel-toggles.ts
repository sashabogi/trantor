import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const V2_ROOT = "desktop/src/v2/";
// #14512: the PanelToggle primitive owns the panel-toggle language. The app rail keeps its own
// expand control (design §C: navigation, not a panel), so its chevrons are exempt.
const ALLOWLIST = [
  "desktop/src/v2/ui/PanelToggle.tsx",
  "desktop/src/v2/shell/Rail.tsx",
] as const;
// lucide-react exports drawn as ad-hoc panel toggles: Panel* and the double Chevrons*.
const IMPORTED_NAME = /^(?:Panel[A-Z][A-Za-z0-9]*|Chevrons[A-Z][A-Za-z0-9]*)$/;
// JSX use of those icons; PanelToggle itself (and local wrappers named after it) is the primitive.
const JSX_NAME = /^(?:Panel(?:Left|Right|Top|Bottom)|Chevrons(?:Left|Right|Up|Down))/;

export const noAdHocPanelTogglesRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Panel toggles come from the v2/ui PanelToggle primitive, never ad-hoc lucide Panel/Chevrons icons." },
    messages: {
      adHocToggle: "Use the v2/ui PanelToggle primitive for panel toggles: {{name}} redraws the four-languages problem #14512 closed.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (!filename.includes(V2_ROOT) || ALLOWLIST.some(file => filename.endsWith(file))) return {};
    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        if (node.source.value !== "lucide-react") return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier" || spec.imported.type !== "Identifier") continue;
          if (IMPORTED_NAME.test(spec.imported.name)) {
            context.report({ node: spec, messageId: "adHocToggle", data: { name: spec.imported.name } });
          }
        }
      },
      JSXOpeningElement(node: ESTree.JSXOpeningElement) {
        if (node.name.type !== "JSXIdentifier") return;
        if (JSX_NAME.test(node.name.name)) {
          context.report({ node, messageId: "adHocToggle", data: { name: node.name.name } });
        }
      },
    };
  },
});
