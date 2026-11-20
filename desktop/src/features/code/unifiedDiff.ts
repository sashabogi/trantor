export const unifiedDiffTokenRules: [RegExp, string][] = [
  [/^@@/, "meta.diff.header"],
  [/^(?:diff |index |new file |deleted file |old mode |new mode |similarity |rename from |rename to |copy from |copy to |--- |\+\+\+ )/, "meta.diff.file"],
  [/^-/, "markup.deleted"],
  [/^\+/, "markup.inserted"],
  [/^\\/, "comment"],
];

export function unifiedDiffToken(line: string): string {
  return unifiedDiffTokenRules.find(([pattern]) => pattern.test(line))?.[1] ?? "";
}
