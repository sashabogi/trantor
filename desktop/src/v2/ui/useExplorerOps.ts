// What the Explorer's extra row actions do (#14106). Every failure becomes the tree's one-line note.
import type { FileEntry } from "../../features/code/fileApi";
import { absolutePath, countFolderFiles, deleteFolder, joinPath, movePath, parentOf, renameFolder, revealPath } from "./explorerOps";

export type ExtraAction = "copy-path" | "copy-relative" | "reveal";

type Deps = { project: string; seat: string | undefined; run: (job: Promise<unknown>) => void; note: (text: string) => void };

export function folderDeleteQuestion(path: string, files: number): string {
  const inside = files === 0 ? "It is empty." : files === 1 ? "It holds 1 file." : `It holds ${files} files.`;
  return `Delete the folder ${path}? ${inside} A copy goes to the Trash first.`;
}

export function useExplorerOps({ project, seat, run, note }: Deps) {
  const copy = (job: Promise<string>) =>
    job.then(text => navigator.clipboard.writeText(text)).catch(e => note(e instanceof Error ? e.message : String(e)));
  return {
    extra: (entry: FileEntry, action: ExtraAction) => {
      if (action === "copy-path") copy(absolutePath(project, entry.path, seat));
      else if (action === "copy-relative") copy(Promise.resolve(entry.path));
      else run(revealPath(project, entry.path, seat));
    },
    move: (entry: FileEntry, dir: string) => {
      if (parentOf(entry.path) === dir || entry.path === dir) return;
      run(movePath(project, entry.path, joinPath(dir, entry.name), seat));
    },
    renameFolder: (entry: FileEntry, to: string) => run(renameFolder(project, entry.path, to, seat)),
    folderQuestion: (entry: FileEntry) => countFolderFiles(project, entry.path, seat).then(files => folderDeleteQuestion(entry.path, files)),
    deleteFolder: (entry: FileEntry) => run(deleteFolder(project, entry.path, seat)),
  };
}
