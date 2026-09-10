// Drill Mode (#6800), the pure half: a step catalogue (card, operator action, expected result,
// optional DOM pre-fill check), the verdict to card-move mapping, and each move's note. No
// React or IPC, so DrillMode.tsx/drillApi.ts can be tested without mounting anything. Every
// step ends with a human Pass; an auto-check only pre-fills the verdict, never moves a card.

/** Which built-app fact a DOM probe can vouch for before the operator looks (drillChecks.ts). */
export type AutoCheckKind =
  | "chips-mounted"
  | "chips-lead-in"
  | "jump-arrow-mounted"
  | "composer-no-overlap"
  | "wake-header-pending"
  | "cli-banner-shown"
  | "ask-answered";

/** A step the panel can drive itself on the operator's press (drillApi.ts): post the #6317
 *  right-arrow into the focused pane, or seed the #6533 ask in the stage. The headless runners
 *  cannot stage either (no Workspace, no live pane, no orchestrator mid-ask); the real app can. */
export type DriveKind = "post-key" | "seed-ask";

export const DRIVE_LABELS = {
  "post-key": "Press the key for me",
  "seed-ask": "Seed the ask",
} as const satisfies Record<DriveKind, string>;

export type DrillStep = {
  card: number;
  title: string;
  /** What the operator does, verbatim — one action, in the drill project, never a real one. */
  action: string;
  /** What they should see when the card's fix is real. */
  expected: string;
  autoCheck: AutoCheckKind | null;
  drive: DriveKind | null;
};

/** The step order follows the drill's own life: create the stage, wake it, then the chat surface
 *  it lights up, then the surfaces that need an app restart or a credential to prove. */
export const DRILL_STEPS: readonly DrillStep[] = [
  {
    card: 6067,
    title: "Genesis sheet takes a dropped brief",
    action: "Click Start a project (sidebar +). Drag a .md file from Finder onto the sheet.",
    expected: "The sheet switches to From a brief on its own and shows the dropped file's name. The window does not navigate away.",
    autoCheck: null,
    drive: null,
  },
  {
    card: 6070,
    title: "Genesis flow lands on the new project",
    action: "In the sheet, name the project with the drill- prefix (it stays disposable) and click Create.",
    expected: "The sheet closes at once, the app lands on the new project's workspace, and the wake reports as a toast, not a wait.",
    autoCheck: null,
    drive: null,
  },
  {
    card: 6201,
    title: "Wake header says kickoff pending",
    action: "With the drill project's session idle, press Wake on its sidebar row, then open its Chat tab.",
    expected: "The chat header reads 'kickoff pending — waiting for idle' during the gate, then the outcome for a few seconds. Exactly one prompt is sent.",
    autoCheck: "wake-header-pending",
    drive: null,
  },
  {
    card: 6317,
    title: "A key in a live terminal pane does not abort the app",
    action: "Open the drill project's Workspace lens and click into its terminal pane. Press the right arrow yourself, or press the button below: it posts one through AppKit into the focused pane.",
    expected: "The app stays up. app-panics.log gains nothing, or names a caught Objective-C exception instead of a crash; the auto-check quotes what it wrote.",
    autoCheck: null,
    drive: "post-key",
  },
  {
    card: 5993,
    title: "Suggestion chips above the composer",
    action: "In the drill project's Chat, ask the orchestrator something that ends in a yes/no question back to you (e.g. 'ask me whether to proceed, then say the word').",
    expected: "When the turn goes idle on that ask, a chip row appears above the composer with yes / no chips. If it does not, app-trace.log names the reason.",
    autoCheck: "chips-mounted",
    drive: null,
  },
  {
    card: 6702,
    title: "Chips carry the sentence they answer",
    action: "Hover the yes chip from the previous step.",
    expected: "The tooltip shows the question you are confirming, and the row leads with the trimmed question instead of the word 'suggested'.",
    autoCheck: "chips-lead-in",
    drive: null,
  },
  {
    card: 6533,
    title: "A real AskUserQuestion answers from the Chat card",
    action: "Press Seed the ask below (a haiku session in the drill project calls AskUserQuestion). In the drill project's Chat, wait for the Drill card and click Continue, then Check now.",
    expected: "The card renders Continue and Stop as buttons. Clicking Continue types the answer into the session's pane: the card turns to answered and the session prints ASK-DRILL-ADVANCED.",
    autoCheck: "ask-answered",
    drive: "seed-ask",
  },
  {
    card: 6697,
    title: "Transcript stays put while you read",
    action: "Ask the orchestrator for a long reply. While it streams, scroll up into the transcript and stay there.",
    expected: "The view does not yank to the bottom on new lines. A jump-to-latest arrow appears, with a dot once more has landed below.",
    autoCheck: "jump-arrow-mounted",
    drive: null,
  },
  {
    card: 6701,
    title: "Composer bar: gauge and Aa do not overlap",
    action: "In Chat, narrow the right pane to its minimum width and look at the composer's bottom row.",
    expected: "The context percentage and the Aa text-size control sit apart; neither draws over the other.",
    autoCheck: "composer-no-overlap",
    drive: null,
  },
  {
    card: 6499,
    title: "Right panel remembers its tab",
    action: "Switch the right panel to Chat. Quit the app, relaunch it, and open the same project.",
    expected: "The panel opens on Chat, not Files.",
    autoCheck: null,
    drive: null,
  },
  {
    card: 6483,
    title: "Accounts under a downgraded CLI shows the banner",
    action: "In a terminal: npm i -g trantor@0.18.46. Open Settings, Accounts, and press Log in or Remove on a provider. Then npm i -g trantor@0.18.47 and reopen Settings.",
    expected: "With 0.18.46 installed a banner reads that the trantor CLI is older than this app needs, and no action silently does nothing. With 0.18.47 back the banner is gone and Log in and Remove work.",
    autoCheck: "cli-banner-shown",
    drive: null,
  },
  {
    card: 6487,
    title: "Accounts: remove and restore a provider",
    action: "Settings → Accounts. Remove a provider you can log back into, confirm the sheet, then Log in again.",
    expected: "The row stays after Remove (state not logged in), the sheet closes, and Log in brings the row back to connected.",
    autoCheck: null,
    drive: null,
  },
  {
    card: 6392,
    title: "Onboarding reopens with every step",
    action: "Settings → Show onboarding again. Walk it with Continue.",
    expected: "All four steps show, satisfied ones marked done, and Done closes the wizard without changing anything.",
    autoCheck: null,
    drive: null,
  },
];

/** The cards this drill must cover (the contract's list) — asserted by the test, so a step that
 *  falls out of the catalogue by accident fails loudly. */
export const REQUIRED_CARDS: readonly number[] = [5993, 6702, 6697, 6701, 6392, 6487, 6483, 6499, 6201, 6067, 6070, 6317, 6533];

export type AutoCheckResult = { ok: boolean; why: string };

export type Verdict = "pass" | "fail";

/** Pass closes the card, Fail bounces it to doing — the board's own states, no drill lane. */
export function statusFor(verdict: Verdict): "done" | "doing" {
  return verdict === "pass" ? "done" : "doing";
}

/** A real project is never a stage. `trantor new` names the disposable one with this prefix and
 *  the genesis step tells the operator to keep it; anything else is refused before any step runs. */
export const DRILL_PROJECT_PREFIX = "drill-";

export function isDisposableProject(name: string): boolean {
  return name.startsWith(DRILL_PROJECT_PREFIX) && name.length > DRILL_PROJECT_PREFIX.length;
}

/** `drill-20260907-2104` — sortable, readable in a sidebar, and a valid `trantor new` name. */
export function disposableProjectName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DRILL_PROJECT_PREFIX}${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** The card-log line a drill move carries. It names the drill, the verdict, who looked, the
 *  stage, the evidence path, and what the auto-check said — a reader of the board's ·N log
 *  can tell a drill close from a seat's close. */
export function noteFor(input: {
  verdict: Verdict;
  me: string;
  project: string;
  screenshot: string | null;
  autoCheck: AutoCheckResult | null;
  operatorNote: string;
}): string {
  const head = `drill-mode ${input.verdict === "pass" ? "PASS" : "FAIL"} by ${input.me} on ${input.project}`;
  const parts = [head];
  if (input.screenshot) parts.push(`screenshot ${input.screenshot}`);
  if (input.autoCheck) parts.push(`auto-check ${input.autoCheck.ok ? "ok" : "no"}: ${input.autoCheck.why}`);
  else parts.push("auto-check none (human only)");
  const trimmed = input.operatorNote.trim();
  if (trimmed) parts.push(trimmed);
  return parts.join(" · ").slice(0, 2000);
}

export type StepOutcome = { card: number; verdict: Verdict; screenshot: string | null };

/** The summary line the last screen shows and the bus report copies. */
export function summarize(outcomes: readonly StepOutcome[], total: number): string {
  const passed = outcomes.filter(o => o.verdict === "pass").length;
  const failed = outcomes.filter(o => o.verdict === "fail").length;
  const skipped = total - outcomes.length;
  return `${passed} passed · ${failed} failed · ${skipped} skipped of ${total}`;
}
