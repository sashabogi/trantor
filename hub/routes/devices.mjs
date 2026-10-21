export async function routeDevices({ req, res, q, P, auth, ctx }) {
  if (!((req.method === "POST" && (P === "/device/register" || P === "/device/unregister")) ||
    (req.method === "GET" && P === "/devices"))) return false;
  const { state, body, json, markDirty, canon, AUTH_MODE } = ctx;
  if (AUTH_MODE === "off" || !auth?.identity || !auth?.pubkey) {
    return json(res, 401, { error: "signed identity required" });
  }
  const pubkey = auth.pubkey;
  state.devices ||= [];

  if (req.method === "GET") {
    if (q.pubkey && q.pubkey !== pubkey) return json(res, 403, { error: "cannot read another signer's devices" });
    return json(res, 200, { devices: state.devices.filter(d => d.pubkey === pubkey) });
  }

  const b = await body(req);
  if (b.pubkey && b.pubkey !== pubkey) return json(res, 403, { error: "cannot manage another signer's devices" });
  const token = String(b.apnsToken || b.apns_token || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(token)) return json(res, 400, { error: "a hexadecimal apnsToken is required" });

  if (P === "/device/unregister") {
    const index = state.devices.findIndex(d => d.apns_token === token && d.pubkey === pubkey);
    if (index < 0) return json(res, 404, { error: "device not found" });
    const [device] = state.devices.splice(index, 1);
    markDirty();
    return json(res, 200, { ok: true, device });
  }

  const requestedEnv = String(b.env || "production").toLowerCase();
  const env = requestedEnv === "development" ? "sandbox" : requestedEnv;
  if (env !== "sandbox" && env !== "production") return json(res, 400, { error: "env must be sandbox or production" });
  const other = state.devices.find(d => d.apns_token === token && d.pubkey !== pubkey);
  if (other) return json(res, 409, { error: "apnsToken is registered to another identity" });
  const existing = state.devices.find(d => d.apns_token === token && d.pubkey === pubkey);
  const muted = Array.isArray(b.muted_projects) ? b.muted_projects : b.mutedProjects;
  const device = {
    pubkey,
    apns_token: token,
    env,
    bundle_id: String(b.bundleId || b.bundle_id || process.env.APNS_BUNDLE_ID || "ai.trantor.companion").slice(0, 200),
    name: String(b.name || auth.identity.name || "").slice(0, 120),
    created: existing?.created || Date.now(),
    last_ok: existing?.last_ok || 0,
    muted_projects: Array.isArray(muted)
      ? [...new Set(muted.map(p => canon(String(p).slice(0, 80))).filter(Boolean))].slice(0, 100)
      : (existing?.muted_projects || []),
  };
  if (existing) Object.assign(existing, device);
  else state.devices.push(device);
  markDirty();
  return json(res, 200, { ok: true, device: existing || device });
}
