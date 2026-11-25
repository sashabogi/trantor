// What a 2.0 screen owner imports from the foundations, one line each (#v2-F).
export type { ScreenProps, Screen, LensScreen, Navigate } from "./routes"; // the props every screen receives, and where it can navigate
export { useShellMode, MODE_CONFIG, type Mode } from "./shell/shellMode"; // the mode on screen (Orchestrator or Developer) and what each one changes
export { Avatar, type AvatarProps } from "./ui/Avatar"; // seat monogram in its seat colour, optional presence dot
export { ProjectTile, type ProjectTileProps } from "./ui/ProjectTile"; // project monogram tile with its gradient, optional corner dot
export { Chip, type ChipProps, type ChipTone } from "./ui/Chip"; // small status label: neutral, ok, warn, bad, info
export { Button, type ButtonProps, type ButtonVariant } from "./ui/Button"; // text button: primary, ghost, quiet, danger; disabledReason explains itself
export { IconButton, type IconButtonProps } from "./ui/IconButton"; // icon-only button; label and title are required
export { Ring, type RingProps } from "./ui/Ring"; // context-used ring with the percent inside, amber from 75
export { Seg, type SegProps, type SegOption } from "./ui/Seg"; // segmented control (mode switch, view toggles)
export { Section, type SectionProps } from "./ui/Section"; // titled panel card with optional sub line and actions
export { Kbd } from "./ui/Kbd"; // keyboard hint, e.g. ⌘K
export { Composer2, type Composer2Props, type Choice } from "./ui/Composer2"; // the 2.0 message composer; its chips open menus built from Choice lists
export { monogram, seatLabel, seatAgent, seatPalette, projectGradient, modelHue, PRESENCE_COLOR, PRESENCE_LABEL, type Presence } from "./ui/identity"; // naming and colour helpers behind the primitives
export { ProjectFrame, LensTabs, type ProjectFrameProps } from "./shell/ProjectFrame"; // project header plus lens tabs, already wrapped around in-project screens
export { NotWired } from "./shell/ClassicLenses"; // the honest "not wired yet" state with the artboard's label
