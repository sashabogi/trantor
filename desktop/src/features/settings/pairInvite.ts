// pairInvite.ts — the mint seam for "Pair a phone" (#12115). Same invite the CLI's
// `trantor pair` mints, but signed by the app's own owner identity through the Rust
// hub_request transport. Kept apart from the component so the test can inject a fake mint.
import { HubClient, type PairInviteResponse } from "../../shared/api/client";

export type PairRole = "approver" | "owner";
export type PairInvite = { link: string; token: string; hub: string; expiresAt: number };

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

export type PairPhoneApi = {
  mint: (role: PairRole) => Promise<PairInvite>;
};

export function pairInviteApi(hubBase: string): PairPhoneApi {
  const client = new HubClient(hubBase);
  return {
    async mint(role: PairRole): Promise<PairInvite> {
      const j: PairInviteResponse = await client.pairInvite(role);
      const echoed = String(j.scopes?.[0]?.role ?? "");
      if (echoed !== role) throw new PairRoleUnsupportedError(role, echoed);
      const hub = hubBase.replace(/\/+$/, "");
      return { link: enrollLink(hub, j.token), token: j.token, hub, expiresAt: j.expiresAt };
    },
  };
}
