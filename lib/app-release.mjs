// trantor — which GitHub release is the newest Trantor app. Mirrors newest_dmg_release in
// desktop/src-tauri/src/update.rs: change both or neither.

// "2.1.10" > "2.1.9": numeric per part, never a string compare.
export function versionNewer(latest, current) {
  const parse = (s) => String(s).trim().replace(/^v/, "").split(".").map(p => parseInt(p, 10) || 0);
  const [l, c] = [parse(latest), parse(current)];
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const a = l[i] ?? 0, b = c[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

// The highest-versioned release carrying a Trantor DMG, preferring this arch's build. GitHub's list
// is NOT in version order: it sorts tag names as text, so app-v2.1.10 came back after app-v2.1.2 and
// taking the first entry told a 2.1.9 install it was current (2026-11-26).
export function newestDmgRelease(releases, archTag) {
  const isDmg = a => /^Trantor[_-].*\.dmg$/.test(a?.name || "");
  let best = null;
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (rel?.draft) continue;
    const assets = (rel.assets || []).filter(isDmg);
    if (!assets.length) continue;
    const asset = assets.find(a => a.name.includes(`_${archTag}`)) || assets[0];
    const version = (asset.name.match(/[_-]([0-9]+(?:\.[0-9]+)*)[_-]/) || [])[1] || String(rel.tag_name || "").replace(/^app-v?|^v/, "");
    if (!best || versionNewer(version, best.version)) best = { tag: rel.tag_name, version, asset };
  }
  return best;
}
