// PAIR A PHONE (#12115): one button, one invite, one QR. The invite is single use and lives ten
// minutes; the countdown says when it died. A hub that predates the approver role answers with a
// narrower scope — that refusal is shown plainly, with an owner-role retry instead of a QR that
// would silently pair the phone into near-nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { toDataURL } from "qrcode";
import { Check, Copy, Smartphone } from "lucide-react";
import { pairInviteApi, PairRoleUnsupportedError, type PairInvite, type PairPhoneApi, type PairRole } from "./pairInvite";

type PairPhoneProps = { hubBase: string; api?: PairPhoneApi; renderQr?: (link: string) => Promise<string> };

type Phase = { s: "idle" } | { s: "minting" } | { s: "ready"; invite: PairInvite; qr: string } | { s: "error"; message: string; roleBlocked?: PairRole };

export function PairPhone({ hubBase, api = pairInviteApi(hubBase), renderQr = (link: string) => toDataURL(link, { width: 220, margin: 1 }) }: PairPhoneProps) {
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);

  const mint = useCallback(async (role: PairRole) => {
    setPhase({ s: "minting" });
    try {
      const invite = await api.mint(role);
      const qr = await renderQr(invite.link);
      setPhase({ s: "ready", invite, qr });
    } catch (e) {
      if (e instanceof PairRoleUnsupportedError) setPhase({ s: "error", message: e.message, roleBlocked: e.requested });
      else setPhase({ s: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [api, renderQr]);

  if (!hubBase) {
    return (
      <div className="tr-card mt-3 flex items-center gap-4 p-4">
        <Smartphone size={18} className="shrink-0 text-[var(--color-tr-muted)]" />
        <div className="min-w-0 flex-1 text-[13px] text-[var(--color-tr-muted)]">
          No hub configured yet — pair a phone once a hub answers.
        </div>
      </div>
    );
  }

  const copy = async () => {
    if (phase.s !== "ready") return;
    try {
      await navigator.clipboard.writeText(phase.invite.link);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard refused — the link stays selectable in the text box */ }
  };

  return (
    <div className="tr-card mt-3 flex items-center gap-4 p-4">
      <Smartphone size={18} className="shrink-0 text-[var(--color-tr-muted)]" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">Pair a phone</div>
        <div className="mt-0.5 text-[12px] text-[var(--color-tr-muted)]">
          Single-use invite for the companion app on {hubBase.replace(/^https?:\/\//, "")} — the approver role, every project, ten minutes.
        </div>
        {phase.s === "error" && (
          <div className="mt-2 text-[12px] text-[var(--color-tr-fail)]">
            {phase.message}
            {phase.roleBlocked && (
              <button type="button" onClick={() => void mint("owner")} className="tr-input ml-2 shrink-0">Pair as owner instead</button>
            )}
          </div>
        )}
        {phase.s === "ready" && <ReadyView invite={phase.invite} qr={phase.qr} copied={copied} onCopy={copy} />}
      </div>
      {phase.s !== "ready" && (
        <button type="button" onClick={() => void mint("approver")} disabled={phase.s === "minting"}
                className="tr-input shrink-0 disabled:opacity-60">
          {phase.s === "minting" ? "Minting…" : "Pair a phone"}
        </button>
      )}
    </div>
  );
}

function ReadyView({ invite, qr, copied, onCopy }: { invite: PairInvite; qr: string; copied: boolean; onCopy: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, invite.expiresAt - Date.now()));
  useEffect(() => {
    const t = window.setInterval(() => setLeft(Math.max(0, invite.expiresAt - Date.now())), 1000);
    return () => window.clearInterval(t);
  }, [invite.expiresAt]);
  const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
  return (
    <div className="mt-2.5 flex items-start gap-4">
      <img src={qr} width={110} height={110} alt="Pairing QR code" className="shrink-0 rounded-lg bg-white p-1.5" />
      <div className="min-w-0 flex-1">
        <input readOnly value={invite.link} onFocus={e => e.currentTarget.select()}
               className="tr-input w-full text-[11px]" aria-label="Pairing link" />
        <div className="mt-1.5 flex items-center gap-2">
          <button type="button" onClick={onCopy} className="tr-input shrink-0">
            {copied ? (<><Check size={12} className="mr-1 inline" />Copied</>) : (<><Copy size={12} className="mr-1 inline" />Copy link</>)}
          </button>
          <span className="text-[11px] text-[var(--color-tr-muted)]">
            {left > 0 ? `Expires in ${mm}:${String(ss).padStart(2, "0")}` : "Expired — mint another."}
          </span>
        </div>
      </div>
    </div>
  );
}
