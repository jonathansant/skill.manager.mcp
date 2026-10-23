import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { discoverSkills, parseSkillFile, resolveSkillPath } from "../src/skills.js";
import { skillMd, tmpDir } from "./helpers.js";

test("parseSkillFile reads frontmatter and body", () => {
  const parsed = parseSkillFile(skillMd("deploy", "Deploy services", "Step 1"), "dir");
  assert.equal(parsed.name, "deploy");
  assert.equal(parsed.description, "Deploy services");
  assert.equal(parsed.body, "Step 1");
});

test("parseSkillFile falls back to the directory name and requires a description", () => {
  assert.equal(parseSkillFile("---\ndescription: x\n---\nbody", "from-dir").name, "from-dir");
  assert.throws(() => parseSkillFile("---\nname: a\n---\nbody", "a"), /description/);
  assert.throws(() => parseSkillFile("no frontmatter", "a"), /frontmatter/);
  assert.throws(() => parseSkillFile("---\nname: Bad Name\ndescription: x\n---\n", "a"), /invalid skill name/);
});

test("discoverSkills finds nested skills, reports errors and duplicates", async () => {
  const root = tmpDir();
  const put = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  put("a/SKILL.md", skillMd("alpha", "A"));
  put("a/nested/SKILL.md", skillMd("ignored", "nested inside a skill"));
  put("group/b/SKILL.md", skillMd("beta", "B"));
  put("group/dup/SKILL.md", skillMd("beta", "dup"));
  put("broken/SKILL.md", "nope");
  put(".hidden/SKILL.md", skillMd("hidden", "H"));

  const { skills, errors } = await discoverSkills(root, "p");
  assert.deepEqual(skills.map((s) => s.name), ["alpha", "beta"]);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.file.startsWith("broken")));
  assert.ok(errors.some((e) => /duplicate/.test(e.message)));
});

test("resolveSkillPath rejects traversal and escaping symlinks", async () => {
  const root = tmpDir();
  mkdirSync(path.join(root, "s"));
  writeFileSync(path.join(root, "s/SKILL.md"), skillMd("s", "S"));
  writeFileSync(path.join(root, "secret.txt"), "secret");
  symlinkSync(path.join(root, "secret.txt"), path.join(root, "s/link.txt"));
  const { skills } = await discoverSkills(root, "p");
  const skill = skills[0]!;
  assert.ok((await resolveSkillPath(skill, "SKILL.md")).endsWith("SKILL.md"));
  await assert.rejects(resolveSkillPath(skill, "../secret.txt"), /escapes/);
  await assert.rejects(resolveSkillPath(skill, "link.txt"), /escapes/);
  await assert.rejects(resolveSkillPath(skill, "missing.txt"), /not found/);
});
