import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const fakePg = new URL("./fake-pg.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "pg") return { url: fakePg, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
