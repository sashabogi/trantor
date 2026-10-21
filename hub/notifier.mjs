import http2 from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const APNS_HOSTS = {
  sandbox: "api.sandbox.push.apple.com",
  production: "api.push.apple.com",
};
const JWT_REUSE_MS = 50 * 60 * 1000;
const text = (value, max = 300) => String(value || "").slice(0, max);

function apnsTransport({ host, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://${host}`);
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      session.destroy();
      reject(error);
    };
    session.on("error", fail);
    const req = session.request({ ...headers, ":method": "POST", ":path": path });
    let status = 0;
    let responseBody = "";
    req.setEncoding("utf8");
    req.on("response", headers => { status = Number(headers[":status"] || 0); });
    req.on("data", chunk => { responseBody += chunk; });
    req.on("error", fail);
    req.setTimeout(10000, () => fail(new Error("APNs request timed out")));
    req.on("end", () => {
      if (settled) return;
      settled = true;
      session.close();
      resolve({ status, body: responseBody });
    });
    req.end(body);
  });
}

function clearFor(event) {
  // Whatever ends the item clears the phone's alert: decided, resolved, expired or withdrawn.
  const match = /^(hold|verify\.gate|proposal)\.(?:decided|resolved|closed|expired|withdrawn)$/.exec(event.type || "");
  if (!match) return null;
  const kind = match[1] === "verify.gate" ? "gate" : match[1];
  const id = Number(kind === "hold" ? event.holdId : kind === "gate" ? event.gateId : event.proposalId);
  if (!id) return null;
  return { kind, id, project: text(event.project, 80), silent: true };
}

function alertFor(event, state) {
  const base = { project: text(event.project, 80), silent: false, direct: false, category: "" };
  if (event.type === "hold.opened" && Number(event.holdId)) {
    return { ...base, kind: "hold", id: Number(event.holdId), category: "HOLD",
      title: `File hold #${Number(event.holdId)}`, body: text(event.file || event.reason) };
  }
  if (event.type === "verify.gate.opened" && Number(event.gateId)) {
    return { ...base, kind: "gate", id: Number(event.gateId), category: "GATE",
      title: `Verify gate #${Number(event.gateId)}`, body: text(event.claim) };
  }
  if (event.type === "proposal.filed" && Number(event.proposalId)) {
    return { ...base, kind: "proposal", id: Number(event.proposalId), category: "PROPOSAL",
      title: `Proposal #${Number(event.proposalId)}`, body: text(event.scope) };
  }
  if (event.type === "message" && Number(event.msgId)) {
    return { ...base, kind: "message", id: Number(event.msgId), direct: true,
      title: `Message from ${text(event.by, 120)}`, body: text(event.text) };
  }
  if (event.type === "presence.offline" && state.peers?.[event.by]?.kind === "agent" && Number(event.id)) {
    return { ...base, kind: "presence", id: Number(event.id),
      title: `${text(event.by, 120)} offline`, body: text(event.project ? `Crew seat offline in ${event.project}` : "Crew seat offline") };
  }
  return null;
}

export function createNotifier({ state, markDirty, canRead, transport = apnsTransport,
  env = process.env, now = Date.now, log = line => process.stderr.write(`[trantor] ${line}\n`) }) {
  const keyId = String(env.APNS_KEY_ID || "");
  const teamId = String(env.APNS_TEAM_ID || "");
  let keyText = String(env.APNS_PRIVATE_KEY || env.APNS_KEY || "").replace(/\\n/g, "\n");
  if (!keyText && env.APNS_KEY_PATH) {
    try { keyText = readFileSync(String(env.APNS_KEY_PATH), "utf8"); }
    catch { log("push disabled: APNS_KEY_PATH unreadable"); }
  }
  const defaultBundleId = String(env.APNS_BUNDLE_ID || "ai.trantor.companion");
  let privateKey = null;
  if (keyId && teamId && keyText) {
    try { privateKey = createPrivateKey(keyText); }
    catch { log("push disabled: invalid APNs key"); }
  } else {
    log("push disabled: no APNs key");
  }
  let cachedJwt = "";
  let cachedJwtAt = 0;

  function jwt() {
    const time = now();
    if (cachedJwt && time >= cachedJwtAt && time - cachedJwtAt < JWT_REUSE_MS) return cachedJwt;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(time / 1000) })).toString("base64url");
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    cachedJwt = `${header}.${claims}.${signature}`;
    cachedJwtAt = time;
    return cachedJwt;
  }

  function dropDevice(device) {
    const index = state.devices.findIndex(d => d.pubkey === device.pubkey && d.apns_token === device.apns_token);
    if (index < 0) return;
    state.devices.splice(index, 1);
    markDirty();
  }

  async function send(device, delivery) {
    const aps = delivery.silent
      ? { "content-available": 1 }
      : { alert: { title: delivery.title, body: delivery.body }, sound: "default" };
    if (delivery.category) aps.category = delivery.category;
    const payload = JSON.stringify({ aps, kind: delivery.kind, id: delivery.id, project: delivery.project });
    // kind in the id: hold #5 and gate #5 are different alerts
    const collapseId = `${delivery.kind}-${delivery.id}`;
    try {
      const result = await transport({
        host: APNS_HOSTS[device.env] || APNS_HOSTS.production,
        path: `/3/device/${device.apns_token}`,
        headers: {
          authorization: `bearer ${jwt()}`,
          "apns-topic": device.bundle_id || defaultBundleId,
          "apns-push-type": delivery.silent ? "background" : "alert",
          "apns-priority": delivery.silent ? "5" : "10",
          "apns-collapse-id": collapseId,
        },
        body: payload,
      });
      let reason = "";
      try { reason = JSON.parse(result.body || "{}").reason || ""; } catch {}
      if (result.status === 410 || reason === "BadDeviceToken") {
        dropDevice(device);
        return;
      }
      if (result.status !== 200) {
        log(`push failed (${Number(result.status || 0)}): ${reason || "APNs error"}`);
        return;
      }
      const current = state.devices.find(d => d.pubkey === device.pubkey && d.apns_token === device.apns_token);
      if (current) {
        current.last_ok = now();
        markDirty();
      }
    } catch (error) {
      log(`push failed: ${text(error?.message || error)}`);
    }
  }

  async function notify(event) {
    if (!privateKey) return;
    const delivery = clearFor(event) || alertFor(event, state);
    if (!delivery) return;
    const deliveries = [];
    for (const device of [...(state.devices || [])]) {
      const identity = state.identities?.[device.pubkey];
      if (!identity || identity.revoked || !canRead({ identity }, delivery.project)) continue;
      if ((device.muted_projects || []).includes(delivery.project)) continue;
      if (delivery.direct && String(identity.name || "") !== String(event.toSession || "")) continue;
      deliveries.push(send(device, delivery));
    }
    await Promise.all(deliveries);
  }

  return { notify };
}
