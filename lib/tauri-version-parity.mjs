import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function majorMinor(version, source) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(version);
  if (!match) throw new Error(`${source}: cannot read resolved version ${JSON.stringify(version)}`);
  return `${match[1]}.${match[2]}`;
}

function cargoLockVersions(lockfile) {
  const versions = new Map();
  for (const block of lockfile.split("[[package]]").slice(1)) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    if (!name || !version) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

function npmLockVersion(lockfile, packageName) {
  const importer = lockfile.importers?.["."];
  for (const section of ["dependencies", "devDependencies"]) {
    const version = importer?.[section]?.[packageName]?.version;
    if (version) return version.split("(")[0];
  }
  throw new Error(`desktop/pnpm-lock.yaml: no resolved version for ${packageName}`);
}

export function checkTauriVersionParity(desktopDir) {
  const manifest = readFileSync(join(desktopDir, "src-tauri", "Cargo.toml"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  const cargoLock = cargoLockVersions(readFileSync(join(desktopDir, "src-tauri", "Cargo.lock"), "utf8"));
  const pnpmLock = parse(readFileSync(join(desktopDir, "pnpm-lock.yaml"), "utf8"));
  const npmPackages = { ...packageJson.devDependencies, ...packageJson.dependencies };
  const crateNames = [...manifest.matchAll(/^(tauri|tauri-plugin-[a-z0-9-]+)\s*=/gm)].map(match => match[1]);
  const pairs = [];

  for (const crateName of new Set(crateNames)) {
    const npmPackage = crateName === "tauri" ? "@tauri-apps/api" : `@tauri-apps/${crateName.slice("tauri-".length)}`;
    if (!npmPackages[npmPackage]) continue;
    const resolvedCargo = [...(cargoLock.get(crateName) || [])];
    if (resolvedCargo.length !== 1) {
      throw new Error(`desktop/src-tauri/Cargo.lock: expected one resolved ${crateName}, found ${resolvedCargo.length}`);
    }
    const cargoVersion = resolvedCargo[0];
    const npmVersion = npmLockVersion(pnpmLock, npmPackage);
    pairs.push({
      crateName,
      npmPackage,
      cargoVersion,
      npmVersion,
      matches: majorMinor(cargoVersion, "desktop/src-tauri/Cargo.lock") === majorMinor(npmVersion, "desktop/pnpm-lock.yaml"),
    });
  }
  return pairs;
}
