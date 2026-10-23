import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { skillMd, SkillsRepo, tmpDir } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function textOf(result: unknown): string {
  return ((result as CallToolResult).content[0] as { text: string }).text;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function connect(configPath: string, cacheDir: string, extraArgs: string[] = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(ROOT, "src/index.ts"), "--config", configPath, "--cache-dir", cacheDir, ...extraArgs],
    cwd: ROOT,
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("skill-manager MCP server", () => {
  const root = tmpDir();
  const cacheDir = path.join(root, "cache");
  const configPath = path.join(root, "config.yaml");
  let platform: SkillsRepo;
  let frontend: SkillsRepo;
  let client: Client;

  before(async () => {
    platform = new SkillsRepo(root, "platform")
      .write("skills/deploy/SKILL.md", skillMd("deploy", "Deploy a service to production", "Run the deploy."))
      .write("skills/deploy/scripts/deploy.sh", "echo deploying\n")
      .write("skills/review/SKILL.md", skillMd("review", "Review a pull request"))
      .write("README.md", "not a skill")
      .commit("initial");
    frontend = new SkillsRepo(root, "frontend")
      .write("SKILL-ignored.md", "x")
      .write("review/SKILL.md", skillMd("review", "Review frontend code"))
      .commit("initial")
      .write("storybook/SKILL.md", skillMd("storybook", "Write storybook stories"))
      .commit("dev only", "dev");

    writeFileSync(
      configPath,
      [
        "pollIntervalSeconds: 1",
        "profiles:",
        "  platform:",
        `    repo: ${platform.remote}`,
        "    path: skills",
        "  frontend:",
        `    repo: ${frontend.remote}`,
        "    branch: dev",
        "agents:",
        "  backend-agent:",
        "    profiles: [platform]",
        "  mirror-agent:",
        "    profiles: [platform]",
        "    installDir: ./native-skills",
        "",
      ].join("\n"),
    );
    client = await connect(configPath, cacheDir);
  });

  after(async () => {
    await client?.close();
  });

  test("exposes skills from all profiles in the use_skill catalog", async () => {
    const { tools } = await client.listTools();
    const useSkill = tools.find((t) => t.name === "use_skill")!;
    assert.match(useSkill.description!, /- deploy: Deploy a service to production/);
    assert.match(useSkill.description!, /- storybook: Write storybook stories/, "tracks the configured branch");
    // "review" exists in both profiles, so both get qualified ids.
    assert.match(useSkill.description!, /- platform-review:/);
    assert.match(useSkill.description!, /- frontend-review:/);
  });

  test("use_skill returns instructions and bundled files", async () => {
    const out = textOf(await client.callTool({ name: "use_skill", arguments: { skill: "deploy" } }));
    assert.match(out, /Run the deploy\./);
    assert.match(out, /- scripts\/deploy\.sh/);
    assert.match(out, /Base directory: /);
  });

  test("ambiguous names must be qualified", async () => {
    const res = await client.callTool({ name: "use_skill", arguments: { skill: "review" } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /several profiles/);
    const ok = await client.callTool({ name: "use_skill", arguments: { skill: "frontend/review" } });
    assert.match(textOf(ok), /Review frontend code|Instructions for review/);
  });

  test("read_skill_file reads bundled files and blocks traversal", async () => {
    const ok = await client.callTool({ name: "read_skill_file", arguments: { skill: "deploy", path: "scripts/deploy.sh" } });
    assert.equal(textOf(ok), "echo deploying\n");
    const bad = await client.callTool({ name: "read_skill_file", arguments: { skill: "deploy", path: "../review/SKILL.md" } });
    assert.equal(bad.isError, true);
  });

  test("skills are exposed as prompts and resources", async () => {
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === "deploy"));
    const prompt = await client.getPrompt({ name: "deploy", arguments: { task: "ship api" } });
    assert.match((prompt.messages[0]!.content as { text: string }).text, /Task: ship api[\s\S]*Run the deploy/);

    const { resources } = await client.listResources();
    const res = resources.find((r) => r.name === "deploy")!;
    assert.equal(res.uri, "skill://platform/deploy/SKILL.md");
    const read = await client.readResource({ uri: "skill://platform/deploy/scripts/deploy.sh" });
    assert.equal((read.contents[0] as { text: string }).text, "echo deploying\n");
  });

  test("merged changes are picked up by polling and announced via list_changed", async () => {
    const changed = new Promise<void>((resolve) =>
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()),
    );
    platform
      .write("skills/incident/SKILL.md", skillMd("incident", "Handle a production incident"))
      .remove("skills/review")
      .commit("add incident, remove review");

    await Promise.race([changed, new Promise((_, rej) => setTimeout(() => rej(new Error("no list_changed")), 15_000))]);
    const { tools } = await client.listTools();
    const desc = tools.find((t) => t.name === "use_skill")!.description!;
    assert.match(desc, /- incident: Handle a production incident/);
    // With platform's review gone, frontend's review is no longer ambiguous.
    assert.match(desc, /- review: Review frontend code/);
    assert.doesNotMatch(desc, /platform-review/);
  });

  test("a broken skill is reported without hiding the others", async () => {
    platform.write("skills/broken/SKILL.md", "no frontmatter").commit("broken skill");
    const out = textOf(await client.callTool({ name: "refresh_skills", arguments: {} }));
    assert.match(out, /! failed to load broken\/SKILL\.md: missing YAML frontmatter/);
    assert.match(out, /- deploy:/);
  });

  test("--agent limits the server to that agent's profiles", async () => {
    const scoped = await connect(configPath, cacheDir, ["--agent", "backend-agent"]);
    try {
      const { tools } = await scoped.listTools();
      const desc = tools.find((t) => t.name === "use_skill")!.description!;
      assert.match(desc, /- deploy:/);
      assert.doesNotMatch(desc, /storybook/);
    } finally {
      await scoped.close();
    }
  });

  test("installDir mirrors skills into a native skills directory and keeps it current", async () => {
    const native = path.join(root, "native-skills");
    const mirrored = await connect(configPath, cacheDir, ["--agent", "mirror-agent"]);
    try {
      await waitFor(() => existsSync(path.join(native, "deploy/SKILL.md")), "initial mirror");
      assert.equal(readFileSync(path.join(native, "deploy/scripts/deploy.sh"), "utf8"), "echo deploying\n");
      assert.equal(existsSync(path.join(native, "storybook")), false, "only the agent's profiles are mirrored");

      platform.write("skills/oncall/SKILL.md", skillMd("oncall", "Be on call")).remove("skills/incident").commit("oncall");
      await waitFor(
        () => existsSync(path.join(native, "oncall/SKILL.md")) && !existsSync(path.join(native, "incident")),
        "mirror of merged change",
      );
    } finally {
      await mirrored.close();
    }
  });

  test("sync mirrors once and exits", () => {
    const dest = path.join(root, "sync-dest");
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "sync", "--config", configPath, "--cache-dir", cacheDir, "-p", "frontend", "-i", dest],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.match(out, /installed review, storybook/);
    assert.ok(existsSync(path.join(dest, "storybook/SKILL.md")));
  });
});
