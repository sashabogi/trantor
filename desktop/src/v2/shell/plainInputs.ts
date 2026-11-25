// macOS text substitution capitalises and "corrects" what is typed into an input. Names, paths,
// globs and code must stay as typed, so every single-line input opts out in one place (#14104 drill).
const OFF: [string, string][] = [["autocorrect", "off"], ["autocapitalize", "off"], ["spellcheck", "false"]];

function plain(input: HTMLInputElement) {
  for (const [name, value] of OFF) if (!input.hasAttribute(name)) input.setAttribute(name, value);
}

function sweep(node: Node) {
  if (node instanceof HTMLInputElement) plain(node);
  else if (node instanceof Element) node.querySelectorAll("input").forEach(plain);
}

/** Opts every input under `root` out, now and as they mount. Textareas keep the help: they hold prose. */
export function keepInputsPlain(root: Element): () => void {
  sweep(root);
  const observer = new MutationObserver(records => { for (const record of records) record.addedNodes.forEach(sweep); });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
