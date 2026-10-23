import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { mirrorSkills, renameSkill } from "../src/mirror.js";
import type { ExposedSkill } from "../src/registry.js";
import { discoverSkills } from "../src/skills.js";
import { skillMd, tmpDir } from "./helpers.js";

function put(root: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

async function load(root: string, profile: string, ids: Record<string, string> = {}): Promise<ExposedSkill[]> {
  const { skills } = await discoverSkills(root, profile);
  return skills.map((s) => ({ ...s, id: ids[s.name] ?? s.name }));
}

const opts = (...profiles: string[]) => ({ activeProfiles: profiles, loadedProfiles: profiles });

test("installs, skips unchanged, updates and removes managed skills", async () => {
  const src = tmpDir();
  const dest = tmpDir();
  put(src, "deploy/SKILL.md", skillMd("deploy", "Deploy"));
  put(src, "deploy/scripts/run.sh", "v1");
  put(src, "review/SKILL.md", skillMd("review", "Review"));

  let r = await mirrorSkills(await load(src, "p"), dest, opts("p"));
  assert.deepEqual(r.installed, ["deploy", "review"]);
  assert.equal(readFileSync(path.join(dest, "deploy/scripts/run.sh"), "utf8"), "v1");

  r = await mirrorSkills(await load(src, "p"), dest, opts("p"));
  assert.deepEqual([r.installed, r.updated, r.removed], [[], [], []]);

  put(src, "deploy/scripts/run.sh", "v2");
  rmSync(path.join(src, "review"), { recursive: true });
  r = await mirrorSkills(await load(src, "p"), dest, opts("p"));
  assert.deepEqual(r.updated, ["deploy"]);
  assert.deepEqual(r.removed, ["review"]);
  assert.equal(readFileSync(path.join(dest, "deploy/scripts/run.sh"), "utf8"), "v2");
  assert.equal(existsSync(path.join(dest, "review")), false);
  assert.deepEqual(
    readdirSync(dest).filter((f) => f.startsWith(".") && f !== ".skill-manager.json"),
    [],
    "no staging, trash or lock directories are left behind",
  );
});

test("never overwrites or removes skills it does not manage", async () => {
  const src = tmpDir();
  const dest = tmpDir();
  put(src, "mine/SKILL.md", skillMd("mine", "From git"));
  put(dest, "mine/SKILL.md", skillMd("mine", "Hand written"));
  put(dest, "other/SKILL.md", skillMd("other", "Hand written"));

  const r = await mirrorSkills(await load(src, "p"), dest, opts("p"));
  assert.equal(r.skipped[0]?.id, "mine");
  assert.match(readFileSync(path.join(dest, "mine/SKILL.md"), "utf8"), /Hand written/);

  await mirrorSkills([], dest, opts("p"));
  assert.ok(existsSync(path.join(dest, "other/SKILL.md")));
  assert.ok(existsSync(path.join(dest, "mine/SKILL.md")));
});

test("profile-qualified ids are installed under the new name", async () => {
  const src = tmpDir();
  const dest = tmpDir();
  put(src, "review/SKILL.md", skillMd("review", "Review"));
  await mirrorSkills(await load(src, "platform", { review: "platform-review" }), dest, opts("platform"));
  const md = readFileSync(path.join(dest, "platform-review/SKILL.md"), "utf8");
  assert.match(md, /^---\nname: platform-review\ndescription: Review\n---/);
});

test("keeps skills of an active profile that has not loaded yet, drops inactive profiles", async () => {
  const src = tmpDir();
  const dest = tmpDir();
  put(src, "a/SKILL.md", skillMd("a", "A"));
  await mirrorSkills(await load(src, "p"), dest, opts("p"));

  let r = await mirrorSkills([], dest, { activeProfiles: ["p"], loadedProfiles: [] });
  assert.deepEqual(r.removed, []);
  assert.ok(existsSync(path.join(dest, "a")));

  r = await mirrorSkills([], dest, opts("q"));
  assert.deepEqual(r.removed, ["a"]);
});

test("renameSkill replaces or inserts the name field", () => {
  assert.equal(renameSkill("---\nname: a\ndescription: d\n---\nbody", "b"), "---\nname: b\ndescription: d\n---\nbody");
  assert.equal(renameSkill("---\ndescription: d\n---\nbody", "b"), "---\nname: b\ndescription: d\n---\nbody");
});
