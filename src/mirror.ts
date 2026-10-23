import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withLock } from "./lock.js";
import type { ExposedSkill } from "./registry.js";
import { SKILL_FILE } from "./skills.js";

/** Records which directories in the install dir this tool owns. Anything not listed is never touched. */
export const MANIFEST_FILE = ".skill-manager.json";
const LOCK_DIR = ".skill-manager.lock";

interface ManifestEntry {
  profile: string;
  name: string;
  hash: string;
}

interface Manifest {
  version: 1;
  skills: Record<string, ManifestEntry>;
}

export interface MirrorResult {
  installed: string[];
  updated: string[];
  removed: string[];
  skipped: { id: string; reason: string }[];
}

export interface MirrorOptions {
  /** Profiles this server instance serves. Skills from profiles outside this set are removed. */
  activeProfiles: string[];
  /**
   * Active profiles that currently have a checkout loaded. Skills of an active profile that hasn't loaded (e.g. first
   * start while offline) are left in place rather than removed.
   */
  loadedProfiles: string[];
}

/**
 * Copies skills into an agent's native skills directory (e.g. ~/.claude/skills) so the agent discovers them itself.
 * Each skill lands in `<installDir>/<id>`. Directories this tool didn't create are never modified, and skills that
 * disappear from the active profiles are removed.
 */
export async function mirrorSkills(skills: ExposedSkill[], installDir: string, opts: MirrorOptions): Promise<MirrorResult> {
  await mkdir(installDir, { recursive: true });
  return withLock(path.join(installDir, LOCK_DIR), async () => {
    const result: MirrorResult = { installed: [], updated: [], removed: [], skipped: [] };
    const prev = await readManifest(installDir);
    const next: Manifest = { version: 1, skills: {} };

    for (const skill of skills) {
      const target = path.join(installDir, skill.id);
      const owned = prev.skills[skill.id];
      if (!owned && existsSync(target)) {
        result.skipped.push({ id: skill.id, reason: `${target} already exists and is not managed by skill-manager` });
        continue;
      }
      try {
        const hash = await hashSkill(skill);
        if (owned?.hash === hash && existsSync(target)) {
          next.skills[skill.id] = owned;
          continue;
        }
        await installSkill(skill, target, installDir);
        next.skills[skill.id] = { profile: skill.profile, name: skill.name, hash };
        (owned ? result.updated : result.installed).push(skill.id);
      } catch (err) {
        if (owned && existsSync(target)) next.skills[skill.id] = owned;
        result.skipped.push({ id: skill.id, reason: (err as Error).message });
      }
    }

    const active = new Set(opts.activeProfiles);
    const loaded = new Set(opts.loadedProfiles);
    for (const [id, entry] of Object.entries(prev.skills)) {
      if (next.skills[id]) continue;
      if (active.has(entry.profile) && !loaded.has(entry.profile)) {
        next.skills[id] = entry;
        continue;
      }
      await rm(path.join(installDir, id), { recursive: true, force: true });
      result.removed.push(id);
    }

    await writeManifest(installDir, next);
    return result;
  });
}

async function installSkill(skill: ExposedSkill, target: string, installDir: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  // Stage under a dot-name in the same directory so the final swap is a rename and agents never see a half copy.
  const staging = path.join(installDir, `.staging-${skill.id}-${suffix}`);
  const trash = path.join(installDir, `.trash-${skill.id}-${suffix}`);
  try {
    await cp(skill.dir, staging, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
    if (skill.id !== skill.name) {
      // The agent identifies skills by frontmatter name, so a renamed (profile-qualified) skill must carry its new name.
      const file = path.join(staging, SKILL_FILE);
      await writeFile(file, renameSkill(await readFile(file, "utf8"), skill.id));
    }
    if (existsSync(target)) await rename(target, trash);
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(trash, { recursive: true, force: true });
  }
}

/** Replaces (or adds) the `name:` field in a SKILL.md frontmatter block, leaving everything else as written. */
export function renameSkill(content: string, name: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return content;
  const fm = match[1] ?? "";
  const renamed = /^name:.*$/m.test(fm) ? fm.replace(/^name:.*$/m, `name: ${name}`) : `name: ${name}\n${fm}`;
  return content.replace(fm, renamed);
}

async function hashSkill(skill: ExposedSkill): Promise<string> {
  const hash = createHash("sha256").update(`${skill.id}\0`);
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        hash.update(`${path.relative(skill.dir, full)}\0`);
        hash.update(await readFile(full).catch(() => Buffer.alloc(0)));
        hash.update("\0");
      }
    }
  }
  await walk(skill.dir);
  return hash.digest("hex");
}

async function readManifest(installDir: string): Promise<Manifest> {
  try {
    const data = JSON.parse(await readFile(path.join(installDir, MANIFEST_FILE), "utf8"));
    if (data?.version === 1 && data.skills && typeof data.skills === "object") return data as Manifest;
  } catch {
    // Missing or unreadable manifest: treat as nothing managed yet.
  }
  return { version: 1, skills: {} };
}

async function writeManifest(installDir: string, manifest: Manifest): Promise<void> {
  const file = path.join(installDir, MANIFEST_FILE);
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n");
  await rename(tmp, file);
}

/** Re-mirrors whenever asked, running one mirror at a time and collapsing requests that arrive mid-run into one. */
export function mirrorOnChange(
  getSkills: () => ExposedSkill[],
  getOptions: () => MirrorOptions,
  installDir: string,
  onResult: (result: MirrorResult) => void,
  onError: (err: Error) => void,
): () => void {
  let running = false;
  let pending = false;
  const run = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        try {
          onResult(await mirrorSkills(getSkills(), installDir, getOptions()));
        } catch (err) {
          onError(err as Error);
        }
      } while (pending);
    } finally {
      running = false;
    }
  };
  return () => void run();
}
