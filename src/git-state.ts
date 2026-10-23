import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

export interface DirtyFileState {
  path: string;
  status: string;
}

export interface GitEngineeringState {
  available: boolean;
  files: DirtyFileState[];
  patch: string;
  lockfilesAndGeneratedAssets: string[];
}

const GENERATED_OR_LOCKFILE_PATTERNS = [
  /(?:^|\/)package-lock\.json$/i,
  /(?:^|\/)pnpm-lock\.yaml$/i,
  /(?:^|\/)yarn\.lock$/i,
  /(?:^|\/)Cargo\.lock$/i,
  /(?:^|\/)poetry\.lock$/i,
  /(?:^|\/)bun\.lockb?$/i,
  /(?:^|\/)composer\.lock$/i,
  /(?:^|\/)flake\.lock$/i,
  /(?:^|\/)mise\.lock$/i,
  /\.min\.(?:js|css|mjs)$/i,
  /\.map$/i,
  /\.wasm$/i,
  /(?:^|\/)(?:dist|build|out|\.next|\.nuxt|\.turbo|\.parcel-cache)\//i,
];

export function isGeneratedOrLockfile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return GENERATED_OR_LOCKFILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const DIRTY_PATCH_CHARS = 16_000;
const UNTRACKED_FILE_CHARS = 4_000;

export function parseGitStatusPorcelainV1Z(output: string): DirtyFileState[] {
  const records = output.split("\0");
  const files: DirtyFileState[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    files.push({ path: filePath, status });
    // In porcelain v1 -z output, rename/copy records are followed by the source path.
    if (status.includes("R") || status.includes("C")) index++;
  }
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

function patchChunkPath(chunk: string): string | undefined {
  const diffMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
  if (diffMatch) return diffMatch[2];
  const untrackedMatch = chunk.match(/^\+\+\+ b\/(.+)$/m);
  return untrackedMatch?.[1];
}

function truncatePatch(text: string, files: DirtyFileState[]): string {
  if (!text && files.length === 0) return "";
  const inventory = files.map((file) => `${file.status} ${file.path}`).join("\n");
  const inventoryBlock = `## Changed-file inventory\n${inventory}\n`;
  if (inventoryBlock.length >= DIRTY_PATCH_CHARS) {
    const marker = "\n[Inventory truncated; see git status for the complete path list.]";
    return `${inventoryBlock.slice(0, DIRTY_PATCH_CHARS - marker.length)}${marker}`;
  }
  if (text.length + inventoryBlock.length <= DIRTY_PATCH_CHARS) return `${inventoryBlock}\n${text}`;

  const chunks = text.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim());
  const remaining = Math.max(0, DIRTY_PATCH_CHARS - inventoryBlock.length - 80);
  if (chunks.length === 0 || remaining === 0) {
    return `${inventoryBlock}\n[Patch bodies omitted: ${text.length} characters exceeded the shared budget.]`;
  }

  const labels = chunks.map((chunk) => `[Patch excerpt: ${patchChunkPath(chunk) ?? "combined patch section"}]`);
  const labelCharacters = labels.reduce((total, label) => total + label.length + 2, 0);
  if (labelCharacters >= remaining) {
    return `${inventoryBlock}\n[Patch bodies omitted: ${text.length} characters exceeded the shared budget.]`;
  }
  const markerReserve = chunks.length * 80;
  const bodyBudget = Math.floor(Math.max(0, remaining - labelCharacters - markerReserve) / chunks.length);
  const excerpts = chunks.map((chunk, index) => {
    const header = `${labels[index]}\n`;
    if (bodyBudget < 40) return header.trimEnd();
    if (chunk.length <= bodyBudget) return `${header}${chunk.trim()}`;
    const half = Math.floor(bodyBudget / 2);
    return `${header}${chunk.slice(0, half).trimEnd()}\n[... ${chunk.length - (half * 2)} characters omitted ...]\n${chunk.slice(-half).trimStart()}`;
  });
  return `${inventoryBlock}\n${excerpts.join("\n\n")}`;
}

async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_LIMIT,
    signal,
  });
  return result.stdout;
}

async function readTrackedPatch(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    return await runGit(root, args, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    const tooLarge = error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    return `[Patch bodies omitted: ${tooLarge ? `git output exceeded ${GIT_OUTPUT_LIMIT} bytes` : "git diff unavailable"}.]`;
  }
}

async function readUntrackedPreviews(
  root: string,
  files: DirtyFileState[],
  signal?: AbortSignal,
): Promise<string> {
  const sections: string[] = [];
  let remaining = DIRTY_PATCH_CHARS;
  for (const file of files) {
    if (file.status !== "??" || isGeneratedOrLockfile(file.path) || remaining <= 0) continue;
    const absolute = path.resolve(root, file.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      signal?.throwIfAborted();
      // Symlinks can point outside the repository (credentials, home files);
      // never follow them. O_NOFOLLOW closes the race between lstat and open.
      const metadata = await lstat(absolute);
      if (!metadata.isFile()) continue;
      handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const size = (await handle.stat()).size;
      const header = `\ndiff --git a/${file.path} b/${file.path}\n--- /dev/null\n+++ b/${file.path}\n`;
      const limit = Math.min(UNTRACKED_FILE_CHARS, remaining);
      // Read only a bounded head and tail; large datasets never enter memory.
      const half = Math.floor(limit / 2);
      const readRange = async (position: number, length: number) => {
        const buffer = Buffer.alloc(Math.max(0, length));
        const { bytesRead } = await handle!.read(buffer, 0, buffer.length, position);
        return buffer.subarray(0, bytesRead);
      };
      const whole = size <= limit;
      const head = await readRange(0, whole ? size : half);
      const tail = whole ? Buffer.alloc(0) : await readRange(Math.max(half, size - half), half);
      if (head.includes(0) || tail.includes(0)) {
        const binary = `${header}[binary untracked file: ${size} bytes]\n`;
        sections.push(binary.slice(0, remaining));
        remaining -= binary.length;
        continue;
      }
      const preview = whole
        ? head.toString("utf8")
        : `${head.toString("utf8")}\n[... untracked content truncated ...]\n${tail.toString("utf8")}`;
      const section = `${header}${preview}\n`;
      sections.push(section.slice(0, remaining));
      remaining -= section.length;
    } catch (error) {
      if (signal?.aborted) throw error;
      // A file can disappear between status and snapshot; its status remains useful.
    } finally {
      await handle?.close();
    }
  }
  return sections.join("");
}

export async function getGitEngineeringState(cwd?: string, signal?: AbortSignal): Promise<GitEngineeringState> {
  if (!cwd) return { available: false, files: [], patch: "", lockfilesAndGeneratedAssets: [] };
  try {
    const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
    const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal);
    const files = parseGitStatusPorcelainV1Z(status);

    const codeFiles = files.filter((file) => !isGeneratedOrLockfile(file.path));
    const lockOrGeneratedFiles = files.filter((file) => isGeneratedOrLockfile(file.path)).map((file) => file.path);

    const trackedCodePaths = codeFiles.filter((file) => file.status !== "??").map((file) => file.path).slice(0, 250);
    const stagedArgs = ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=2"];
    const unstagedArgs = ["diff", "--no-ext-diff", "--no-color", "--unified=2"];
    if (trackedCodePaths.length > 0) {
      stagedArgs.push("--", ...trackedCodePaths);
      unstagedArgs.push("--", ...trackedCodePaths);
    } else {
      stagedArgs.push("--", ":(exclude,top)**");
      unstagedArgs.push("--", ":(exclude,top)**");
    }
    const [staged, unstaged, untracked] = await Promise.all([
      readTrackedPatch(root, stagedArgs, signal),
      readTrackedPatch(root, unstagedArgs, signal),
      readUntrackedPreviews(root, codeFiles, signal),
    ]);
    const sections = [
      staged ? `## Staged changes\n${staged}` : "",
      unstaged ? `## Unstaged changes\n${unstaged}` : "",
      untracked ? `## Untracked files${untracked}` : "",
    ].filter(Boolean);
    return {
      available: true,
      files,
      patch: truncatePatch(sections.join("\n\n"), codeFiles),
      lockfilesAndGeneratedAssets: lockOrGeneratedFiles,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { available: false, files: [], patch: "", lockfilesAndGeneratedAssets: [] };
  }
}
