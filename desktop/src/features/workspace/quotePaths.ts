// Shell-quoting for dropped paths (#5949). A drop writes the paths into the seat's terminal as
// if the human typed them, so each path must survive the shell whole: single-quoted, with an
// embedded single quote spelled the POSIX way (`it's` → `'it'\''s'`). Spaces, unicode, and every
// other metacharacter are safe inside single quotes — nothing else needs escaping.
export function quotePaths(paths: string[]): string {
  return paths.map(quotePath).join(" ");
}

function quotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
