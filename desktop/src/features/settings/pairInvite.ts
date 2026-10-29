// pairInvite.ts — the mint seam for "Pair a phone" (#12115). Same invite the CLI's
// `trantor pair` mints, but signed by the app's own owner identity through the Rust
// hub_request transport. Kept apart from the component so the test can inject a fake mint.
import { HubClient, type PairInviteResponse } from "../../shared/api/client";

export type PairRole = "approver" | "owner";
export type PairInvite = { link: string; token: string; hub: string; hubPublic: boolean; expiresAt: number };

/** The hub predates the approver role (#12113) and stored something narrower than asked. */
export class PairRoleUnsupportedError extends Error {
  readonly requested: PairRole;
  constructor(requested: PairRole, echoed: string) {
    super(`This hub does not know the "${requested}" role yet — it stored "${echoed}", which would pair the phone near-read-only.`);
    this.requested = requested;
  }
}

export function enrollLink(hub: string, token: string): string {
  return `trantor://enroll?hub=${encodeURIComponent(hub.replace(/\/+$/, ""))}&token=${token}`;
}

export function phoneHubAddress(hub: string): void {
  const url = new URL(hub);
  if (!/^https?:$/.test(url.protocol) || ["localhost", "localhost.", "[::1]", "0.0.0.0", "[::]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)) {
    throw new Error(`Your phone cannot reach ${hub}: this address only works on this Mac. Use Tailscale on the Mac and iPhone and configure the hub with the Mac's Tailscale address (then use trantor pair --tailnet), or configure a public hub URL.`);
  }
}

export type PairPhoneApi = {
  mint: (role: PairRole) => Promise<PairInvite>;
};

export function pairInviteApi(hubBase: string): PairPhoneApi {
  const client = new HubClient(hubBase);
  return {
    async mint(role: PairRole): Promise<PairInvite> {
      const health = await client.health();
      const pub = String(health.publicUrl || "").trim().replace(/\/+$/, "");
      const hub = pub || hubBase.replace(/\/+$/, "");
      const hubPublic = !!pub;
      phoneHubAddress(hub);
      const j: PairInviteResponse = await client.pairInvite(role);
      const echoed = String(j.scopes?.[0]?.role ?? "");
      if (echoed !== role) throw new PairRoleUnsupportedError(role, echoed);
      return { link: enrollLink(hub, j.token), token: j.token, hub, hubPublic, expiresAt: j.expiresAt };
    },
  };
}
