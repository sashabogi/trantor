// Real data the Settings pages share: pinned projects, the active project's hub, the signed identity (#13994).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { hubForProject, knownProjects } from "../../../shared/api/client";

export type SettingsData = { projects: string[]; hubBase: string; me: string };

export function useSettingsData(project: string): SettingsData {
  const [projects, setProjects] = useState<string[]>([]);
  const [hubBase, setHubBase] = useState("");
  const [me, setMe] = useState("");
  useEffect(() => {
    let alive = true;
    knownProjects().then(ps => { if (alive) setProjects(ps); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    let alive = true;
    const target = project || projects[0] || "";
    if (!target) return () => { alive = false; };
    hubForProject(target).then(url => {
      if (!alive) return;
      setHubBase(url);
      invoke<string>("identity_name", { base: url }).then(n => { if (alive) setMe(n); }).catch(() => {});
    }).catch(() => {});
    return () => { alive = false; };
  }, [project, projects]);
  return { projects, hubBase, me };
}
