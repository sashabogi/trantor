import { useState } from "react";
import type { Navigate } from "../routes";
import { chooseProjectFolder } from "../projectsFolder";
import { openSettingsAt } from "../shell/settingsIntent";
import { Button } from "./Button";

export function CheckoutRecovery({ project, onNavigate, compact = false }: { project: string; onNavigate: Navigate; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const choose = async () => {
    setBusy(true); setMessage("");
    try {
      if (await chooseProjectFolder(project)) setMessage("Folder saved. You can retry now.");
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className={compact ? "flex min-w-0 flex-col items-start text-v2-small" : "flex flex-wrap items-center gap-1 text-v2-small"}>
      <Button variant="quiet" className={compact ? "max-w-full !px-0 !py-0 !text-v2-small" : ""} title={`Choose the folder for ${project}`} onClick={() => void choose()} disabledReason={busy ? "Choosing folder" : null}><span className="truncate">Choose the folder for {project}</span></Button>
      <Button variant="quiet" className={compact ? "!px-0 !py-0 !text-v2-small" : ""} onClick={() => { openSettingsAt("general"); onNavigate("settings"); }}>Projects folder setting</Button>
      {message && <span role="status">{message}</span>}
    </div>
  );
}
