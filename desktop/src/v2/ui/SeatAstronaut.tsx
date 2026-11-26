// #14365: the seat astronaut. One line-art character, the visor wears the vendor, the antenna wears the
// state, the hands show what it is doing. Ported from the approved docs/design/v2/SeatAstronauts.dc.html;
// the keyframes live in theme.css (transform and opacity only) and stop under prefers-reduced-motion.
import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { brandFor } from "../../shared/Avatar";
import { dictGet } from "../../shared/dict";
import { STATE_WORD, type SeatState } from "./identity";
import { useOwnMachineId } from "./useMachineId";

export type AstroState = "working" | "needs" | "waiting" | "ready" | "sleeping";

/** Idle and offline seats both sleep. */
export function astroState(state: SeatState): AstroState {
  return state === "idle" || state === "offline" ? "sleeping" : state;
}

const hiddenListeners = new Set<() => void>();
const onVisibility = () => hiddenListeners.forEach(l => l());
function subscribeHidden(cb: () => void) {
  if (hiddenListeners.size === 0) document.addEventListener("visibilitychange", onVisibility);
  hiddenListeners.add(cb);
  return () => {
    hiddenListeners.delete(cb);
    if (hiddenListeners.size === 0) document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** True while the window is hidden: the astronaut pauses its animations then. */
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribeHidden, () => document.hidden, () => false);
}

/** The visor colour per brand label (the vendor tints the app ships, Qwen lifted for contrast); Codex is a gradient. */
const VISOR = {
  Claude: "#D97757",
  Codex: "gradient",
  "GLM (Z.ai)": "#5ea0f5",
  "Z.ai": "#5ea0f5",
  Kimi: "#8b8bf5",
  Moonshot: "#8b8bf5",
  DeepSeek: "#5786FE",
  Qwen: "#7A5CF0",
} as const satisfies Record<string, string>;

type MarkPaths = { viewBox: string; paths: string[]; evenodd: boolean };
const markCache = new Map<string, MarkPaths>();
/** The path data of a brand's bundled SVG, so the mark can sit on the visor in white. */
function markOf(svg: string): MarkPaths {
  const hit = markCache.get(svg);
  if (hit) return hit;
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 24 24";
  const paths = [...svg.matchAll(/<path[^>]*?\sd="([^"]+)"/g)].map(m => m[1]);
  const made = { viewBox, paths, evenodd: /fill-rule="evenodd"/.test(svg) };
  markCache.set(svg, made);
  return made;
}

type Vendor = { visor: string; gradient: boolean; mark: MarkPaths | null; mono: string };
function vendorOf(vendor: string, machineId: string | undefined): Vendor {
  const brand = brandFor(vendor, undefined, machineId);
  if (!brand) return { visor: "var(--v2-track)", gradient: false, mark: null, mono: vendor.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?" };
  const tint = dictGet(VISOR, brand.label) ?? "var(--v2-track)";
  return { visor: tint, gradient: tint === "gradient", mark: markOf(brand.svg), mono: "" };
}

type Vars = CSSProperties & Record<`--${string}`, string>;

const STATE_VAR = {
  working: "var(--v2-accent)", needs: "var(--v2-warn)", waiting: "var(--v2-proposal)", ready: "var(--v2-ok)", sleeping: "var(--v2-faint)",
} as const satisfies Record<AstroState, string>;

function Mark({ v, x, y, s, fs }: { v: Vendor; x: number; y: number; s: number; fs: number }) {
  if (!v.mark) {
    return <text className="mk mono-t" x={x + s / 2} y={y + s / 2} textAnchor="middle" dominantBaseline="central" fontSize={fs}>{v.mono}</text>;
  }
  return (
    <svg className="mk" x={x} y={y} width={s} height={s} viewBox={v.mark.viewBox} fillRule={v.mark.evenodd ? "evenodd" : undefined}>
      {v.mark.paths.map(d => <path key={d} d={d} />)}
    </svg>
  );
}

const CODE_ROWS: readonly (readonly [number, number])[] = [[31, 9], [36, 14], [41, 6], [46, 11], [51, 8], [56, 13]];

function FullScene({ pose, v, uid }: { pose: AstroState; v: Vendor; uid: string }) {
  const body = (
    <>
      <path className="ln" d="M26 100 C26 80 34 67 48 67 C62 67 70 80 70 100" />
      <rect className="ln" x="36" y="59" width="24" height="9" rx="4.5" />
      <rect className="ln thin" x="41" y="76" width="14" height="8" rx="2.5" />
      <circle className="dot" cx="45" cy="80" r="1.4" />
      <path className="st thin" d="M49 80 h3" />
    </>
  );
  const head = (
    <g className="head">
      <path className="st ant" d="M57 17 L61.5 7" />
      <rect className="ln" x="17" y="30" width="9" height="16" rx="4.5" />
      <rect className="ln" x="70" y="30" width="9" height="16" rx="4.5" />
      <ellipse className="ln" cx="48" cy="38" rx="27" ry="24" />
      <rect className="vb" x="28" y="26" width="40" height="25" rx="12.5" />
      <rect className="vf" x="28" y="26" width="40" height="25" rx="12.5" />
      {pose === "working" && (
        <>
          <clipPath id={`${uid}cl`}><rect x="28" y="26" width="40" height="25" rx="12.5" /></clipPath>
          <g clipPath={`url(#${uid}cl)`}>
            <g className="code">
              {CODE_ROWS.flatMap(([yy, w]) => [0, 30].map(off => (
                <path key={`${yy}-${off}`} d={`M33 ${yy + off} h${w} M${33 + w + 3} ${yy + off} h${Math.max(3, 14 - w)}`} />
              )))}
            </g>
          </g>
        </>
      )}
      <Mark v={v} x={40} y={30.5} s={16} fs={12} />
      <path className="glint" d="M33.5 34 Q34.5 30.2 38.5 29.6" />
      <rect className="vs" x="28" y="26" width="40" height="25" rx="12.5" />
      <circle className="ball" cx="61.8" cy="6" r="3.6" />
    </g>
  );
  const idle = <><path className="st" d="M33 72 C29 80 30 87 33 91" /><circle className="ln" cx="33.5" cy="91" r="4.6" /></>;
  let front: ReactNode;
  let fx: ReactNode = null;
  if (pose === "working") {
    front = (
      <>
        <rect className="ln" x="22" y="83" width="52" height="12" rx="3.5" />
        {[0, 1, 2, 3, 4, 5].map(i => <rect key={`k${i}`} className="key" x={27 + i * 7} y="86.5" width="5" height="3" rx="1" />)}
        {[0, 1, 2, 3, 4, 5].map(i => <rect key={`l${i}`} className={`ky k${i}`} x={27 + i * 7} y="86.5" width="5" height="3" rx="1" />)}
        <rect className="key" x="37" y="91" width="22" height="2" rx="1" />
        <rect className="ky k6" x="37" y="91" width="22" height="2" rx="1" />
        <path className="st" d="M33 72 C28 78 30 84 36 84.5" />
        <path className="st" d="M63 72 C68 78 66 84 60 84.5" />
        <g className="hl"><circle className="ln" cx="37" cy="84" r="4.6" /></g>
        <g className="hr"><circle className="ln" cx="59" cy="84" r="4.6" /></g>
      </>
    );
  } else if (pose === "waiting") {
    front = (
      <>
        {idle}
        <path className="st" d="M63 72 C68 75 69 77 67 79" />
        <g className="tap">
          <rect className="ln" x="66" y="61" width="5.4" height="13" rx="2.7" />
          <circle className="ln" cx="67.5" cy="78" r="5.4" />
        </g>
      </>
    );
    fx = <><path className="st rip r1" d="M62.5 57 A7.5 7.5 0 0 1 76 57" /><path className="st rip r2" d="M59 53.5 A11.5 11.5 0 0 1 79.5 53.5" /></>;
  } else if (pose === "needs") {
    front = (
      <>
        {idle}
        <g className="wave">
          <path className="st" d="M63 71 C76 67 82 53 83 37" />
          <circle className="ln" cx="88.4" cy="33.5" r="2.5" />
          <circle className="ln" cx="83" cy="31" r="5.8" />
        </g>
      </>
    );
  } else if (pose === "ready") {
    front = (
      <>
        {idle}
        <path className="st" d="M63 72 C67 76 66 80 63 81" />
        <g className="thumb">
          <rect className="ln" x="63.6" y="57" width="6.4" height="16" rx="3.2" />
          <rect className="ln" x="59" y="69.5" width="15.5" height="12.5" rx="4.5" />
          <path className="st thin" d="M60 74 h6.5 M60 77.6 h6.5" />
        </g>
      </>
    );
    fx = <path className="spark" d="M18 12 Q19 17 24 18 Q19 19 18 24 Q17 19 12 18 Q17 17 18 12Z" />;
  } else {
    front = (
      <>
        {idle}
        <path className="st" d="M63 72 C67 80 66 87 63 91" />
        <circle className="ln" cx="62.5" cy="91" r="4.6" />
      </>
    );
    fx = <><text className="zz z1" x="64" y="18">z</text><text className="zz z2" x="72" y="10">z</text></>;
  }
  return <g className="fig">{body}{head}{front}{fx}</g>;
}

function CompactScene({ pose, v }: { pose: AstroState; v: Vendor }) {
  return (
    <>
      <g className="head">
        <path className="st ant" d="M19.6 9 L21.6 4.4" />
        <rect className="ln" x="3.4" y="14" width="5" height="8.5" rx="2.5" />
        <rect className="ln" x="23.6" y="14" width="5" height="8.5" rx="2.5" />
        <ellipse className="ln" cx="16" cy="18.2" rx="10.8" ry="9.8" />
        <rect className="vb" x="8.4" y="13.2" width="15.2" height="10.4" rx="5.2" />
        <rect className="vf" x="8.4" y="13.2" width="15.2" height="10.4" rx="5.2" />
        <Mark v={v} x={12.2} y={14.4} s={7.6} fs={6} />
        <rect className="vs" x="8.4" y="13.2" width="15.2" height="10.4" rx="5.2" />
        <circle className="ball" cx="22" cy="3.6" r="2.5" />
        {pose === "working" && (
          <>
            {[0, 1, 2].map(i => <rect key={`k${i}`} className="key" x={9.2 + i * 4.8} y="29.2" width="4" height="2.6" rx="1.3" />)}
            {[0, 1, 2].map(i => <rect key={`l${i}`} className={`ky k${i}`} x={9.2 + i * 4.8} y="29.2" width="4" height="2.6" rx="1.3" />)}
          </>
        )}
      </g>
      {pose === "waiting" && <><path className="st rip r1" d="M29.2 15 A3.4 3.4 0 0 1 29.2 21.8" /><path className="st rip r2" d="M30.6 12.6 A5.8 5.8 0 0 1 30.6 24.2" /></>}
      {pose === "ready" && <path className="spark" d="M5 1.5 Q5.5 4.5 8.5 5 Q5.5 5.5 5 8.5 Q4.5 5.5 1.5 5 Q4.5 4.5 5 1.5Z" />}
      {pose === "sleeping" && <text className="zz z1" x="3" y="9">z</text>}
    </>
  );
}

function Layer({ pose, variant, v, fade }: { pose: AstroState; variant: "compact" | "full"; v: Vendor; fade: "in" | "out" | null }) {
  const uid = useId().replace(/[^a-z0-9]/gi, "");
  const compact = variant === "compact";
  const style: Vars = { "--v": v.gradient ? `url(#${uid}cv)` : v.visor };
  return (
    <span className={`v2-sa ${compact ? "c" : ""} ${pose} ${fade ? `fade-${fade}` : ""}`} style={style}
      data-layer={fade === "out" ? "leaving" : "current"} aria-hidden="true">
      <svg className="sa-sv" viewBox={compact ? "0 0 32 32" : "0 0 96 96"}>
        {v.gradient && (
          <defs>
            <linearGradient id={`${uid}cv`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#B1A7FF" /><stop offset=".5" stopColor="#7A9DFF" /><stop offset="1" stopColor="#3941FF" />
            </linearGradient>
          </defs>
        )}
        {compact ? <CompactScene pose={pose} v={v} /> : <FullScene pose={pose} v={v} uid={uid} />}
      </svg>
    </span>
  );
}

/** The vendor-coloured astronaut for one seat. `compact` is helmet, visor and antenna with one cue per state
 *  (24px tabs and tile headers); `full` adds the body, hands and keyboard scenes (48px and up). */
export function SeatAstronaut({ vendor, state, size = 24, variant = "compact", name, surface = "var(--v2-chrome)" }: {
  /** The seat's brand identity, as brandFor reads it: "codex", "glm-5:trantor", "orchestrator". */
  vendor: string;
  state: SeatState;
  size?: number;
  variant?: "compact" | "full";
  /** What the label says first: "codex-8"; defaults to the vendor. */
  name?: string;
  /** The colour behind the character, so its outlines fill to match (the tab, the card or the tile). */
  surface?: string;
}) {
  const machineId = useOwnMachineId();
  const v = vendorOf(vendor, machineId);
  const pose = astroState(state);
  const hidden = useDocumentHidden();
  // Cross-fade 180ms: the pose we left stays for one fade, keyed apart so the new pose's one-shot cues replay.
  const [seen, setSeen] = useState(pose);
  const [prev, setPrev] = useState<AstroState | null>(null);
  if (seen !== pose) { setSeen(pose); setPrev(seen); }
  useEffect(() => {
    if (prev === null) return;
    const t = setTimeout(() => setPrev(null), 180);
    return () => clearTimeout(t);
  }, [prev]);
  const style: Vars = { "--s": `${size}px`, "--st": STATE_VAR[pose], "--surf": surface };
  return (
    <span className="v2-sa-box" role="img" aria-label={`${name ?? vendor}, ${STATE_WORD[state]}`} data-state={state} data-variant={variant}
      data-paused={hidden || undefined}
      style={style}>
      {prev !== null && <Layer key={`out-${prev}`} pose={prev} variant={variant} v={v} fade="out" />}
      <Layer key={pose} pose={pose} variant={variant} v={v} fade={prev !== null ? "in" : null} />
    </span>
  );
}
