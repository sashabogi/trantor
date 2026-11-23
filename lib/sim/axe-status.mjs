export const AXE_VERSION = "2.1.1";

export function axeDoctorStatus(platform, present, version = "") {
  if (platform !== "darwin") return { kind: "note", message: "AXe version check applies on macOS hosts with iOS Simulator." };
  if (!present) return { kind: "warn", message: "AXe missing; install pinned v2.1.1 with the Trantor installer." };
  const found = String(version).trim().replace(/^v/, "");
  if (!found) return { kind: "warn", message: `AXe is present, but its version could not be read; Trantor pins v${AXE_VERSION}.` };
  if (found === AXE_VERSION) return { kind: "ok", message: `AXe v${found} installed (Trantor pin).` };
  return { kind: "warn", message: `AXe v${found} installed; Trantor pins v${AXE_VERSION}.` };
}
