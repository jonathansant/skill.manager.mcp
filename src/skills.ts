import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const SKILL_FILE = "SKILL.md";

const MAX_DEPTH = 6;
const MAX_LISTED_FILES = 200;
const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export interface Skill {
  profile: string;
  name: string;
  description: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** Skill directory relative to the profile's skills root. */
  relDir: string;
  frontmatter: Record<string, unknown>;
  /** SKILL.md content with the frontmatter stripped. */
  body: string;
}

export interface SkillError {
  file: string;
  message: string;
}

export interface ParsedSkill {
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Parses a SKILL.md file. The name falls back to the directory name; a description is required. */
export function parseSkillFile(content: string, dirName: string): ParsedSkill {
  const match = FRONTMATTER.exec(content);
  if (!match) throw new Error("missing YAML frontmatter (--- name/description --- block at the top)");
  const fm = parseYaml(match[1] ?? "");
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  const frontmatter = fm as Record<string, unknown>;
  const name = String(frontmatter.name ?? dirName).trim();
  if (!SKILL_NAME.test(name)) {
    throw new Error(`invalid skill name "${name}" (use lowercase letters, digits, - and _)`);
  }
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!description) throw new Error("frontmatter must include a non-empty description");
  return { name, description, frontmatter, body: content.slice(match[0].length).trim() };
}

/** Finds every directory under `root` that contains a SKILL.md. Nested SKILL.md files inside a skill are ignored. */
export async function discoverSkills(
  root: string,
  profile: string,
): Promise<{ skills: Skill[]; errors: SkillError[] }> {
  const skills: Skill[] = [];
  const errors: SkillError[] = [];
  const seen = new Map<string, string>();

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({ file: path.relative(root, dir) || ".", message: (err as Error).message });
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === SKILL_FILE)) {
      const file = path.join(dir, SKILL_FILE);
      const relFile = path.relative(root, file);
      try {
        const parsed = parseSkillFile(await readFile(file, "utf8"), path.basename(dir));
        const dup = seen.get(parsed.name);
        if (dup) throw new Error(`duplicate skill name "${parsed.name}" (also defined in ${dup})`);
        seen.set(parsed.name, relFile);
        skills.push({ profile, ...parsed, dir, relDir: path.relative(root, dir) || "." });
      } catch (err) {
        errors.push({ file: relFile, message: (err as Error).message });
      }
      return;
    }
    if (depth >= MAX_DEPTH) return;
    const subdirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of subdirs) await walk(path.join(dir, e.name), depth + 1);
  }

  await walk(root, 0);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors };
}

/** Lists files bundled with a skill (relative paths, SKILL.md excluded). */
export async function listSkillFiles(skill: Skill): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length > MAX_LISTED_FILES) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) files.push(path.relative(skill.dir, full).split(path.sep).join("/"));
    }
  }
  await walk(skill.dir);
  const listed = files.filter((f) => f !== SKILL_FILE);
  return { files: listed.slice(0, MAX_LISTED_FILES), truncated: listed.length > MAX_LISTED_FILES };
}

/** Resolves a path inside a skill directory, rejecting anything (including symlinks) that escapes it. */
export async function resolveSkillPath(skill: Skill, relPath: string): Promise<string> {
  const base = await realpath(skill.dir);
  const target = await realpath(path.resolve(base, relPath)).catch(() => {
    throw new Error(`file not found in skill "${skill.name}": ${relPath}`);
  });
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes the skill directory: ${relPath}`);
  }
  return target;
}
