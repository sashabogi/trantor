// The Explorer's file actions that go beyond create, rename and delete of a file (#14106): move, folder
// rename and delete, the paths for Copy path, Reveal in Finder, and the bytes of an image.
import { invoke } from "@tauri-apps/api/core";

const scope = (seat?: string) => seat ?? null;

export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export async function movePath(project: string, from: string, to: string, seat?: string): Promise<void> {
  await invoke("move_path", { project, from, to, seat: scope(seat) });
}

export async function renameFolder(project: string, from: string, to: string, seat?: string): Promise<void> {
  await invoke("rename_folder", { project, from, to, seat: scope(seat) });
}

export async function countFolderFiles(project: string, path: string, seat?: string): Promise<number> {
  return invoke<number>("count_folder_files", { project, path, seat: scope(seat) });
}

/** Copies the folder to the Trash first; resolves to where the copy went. */
export async function deleteFolder(project: string, path: string, seat?: string): Promise<string> {
  return invoke<string>("delete_folder", { project, path, seat: scope(seat) });
}

export async function absolutePath(project: string, path: string, seat?: string): Promise<string> {
  return invoke<string>("absolute_path", { project, path, seat: scope(seat) });
}

export async function revealPath(project: string, path: string, seat?: string): Promise<void> {
  await invoke("reveal_path", { project, path, seat: scope(seat) });
}

/** `data` is base64, or null when the image is over the native size cap. */
export type ImageBody = { mime: string; bytes: number; data: string | null };

export async function readImage(project: string, path: string, seat?: string): Promise<ImageBody> {
  return JSON.parse(await invoke<string>("read_image", { project, path, seat: scope(seat) }));
}
