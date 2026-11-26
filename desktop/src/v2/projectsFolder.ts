import { invoke } from "@tauri-apps/api/core";

export type ProjectsRoot = { path: string; source: "setting" | "TRANTOR_DEV_ROOT" | "default" };
export const PROJECT_FOLDERS_CHANGED = "trantor-project-folders-changed";
export const projectsRoot = () => invoke<ProjectsRoot>("projects_root_get");

// The dialog plugin's native open command; both controls use the same single-directory picker.
export function chooseFolder(title: string): Promise<string | null> {
  return invoke<string | null>("plugin:dialog|open", { options: { directory: true, multiple: false, title } });
}

export async function setProjectsRoot(path: string | null): Promise<ProjectsRoot> {
  const root = await invoke<ProjectsRoot>("projects_root_set", { path });
  window.dispatchEvent(new Event(PROJECT_FOLDERS_CHANGED));
  return root;
}

export async function chooseProjectFolder(project: string): Promise<boolean> {
  const path = await chooseFolder(`Choose the folder for ${project}`);
  if (!path) return false;
  await invoke("project_folder_set", { project, path });
  window.dispatchEvent(new Event(PROJECT_FOLDERS_CHANGED));
  return true;
}
