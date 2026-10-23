import { readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { log } from "./log.js";
import type { ExposedSkill, SkillRegistry } from "./registry.js";
import { listSkillFiles, resolveSkillPath, SKILL_FILE } from "./skills.js";

/** How long list requests wait for the initial clone before answering with whatever has loaded. */
const READY_WAIT_MS = 20_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const URI_PREFIX = "skill://";

const INSTRUCTIONS = `This server provides skills: curated, versioned playbooks maintained by your team in git.
Before starting a task, check whether a skill matches it (the use_skill tool lists every available skill with a
description of when to use it). If one matches, call use_skill to load its instructions and follow them. Skills may
reference bundled files (scripts, templates, references); load those with read_skill_file when the instructions say to.
The skill set updates automatically when changes are merged, so do not cache skill content across tasks.`;

const UseSkillArgs = z.object({ skill: z.string().min(1) });
const ReadFileArgs = z.object({ skill: z.string().min(1), path: z.string().min(1) });
const ListArgs = z.object({ profile: z.string().optional() });

export function createServer(registry: SkillRegistry, version: string): Server {
  const server = new Server(
    { name: "skill-manager", version },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true },
      },
      instructions: INSTRUCTIONS,
    },
  );

  const waitReady = () => Promise.race([registry.ready, sleep(READY_WAIT_MS)]);

  registry.on("changed", () => {
    // Notifications only make sense once a client is attached; before that, the first list request sees fresh data.
    if (!server.transport) return;
    Promise.all([server.sendToolListChanged(), server.sendPromptListChanged(), server.sendResourceListChanged()]).catch(
      (err) => log(`failed to send list_changed notifications: ${(err as Error).message}`),
    );
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await waitReady();
    return { tools: buildTools(registry.skills()) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    try {
      switch (req.params.name) {
        case "use_skill":
          await waitReady();
          return text(await renderSkill(registry.resolve(UseSkillArgs.parse(args).skill), registry));
        case "read_skill_file": {
          await waitReady();
          const { skill, path } = ReadFileArgs.parse(args);
          return text(await readSkillFile(registry.resolve(skill), path));
        }
        case "list_skills":
          await waitReady();
          return text(renderList(registry, ListArgs.parse(args).profile));
        case "refresh_skills":
          await registry.refresh();
          return text(renderList(registry));
        default:
          return error(`unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      return error(err instanceof z.ZodError ? `invalid arguments: ${z.prettifyError(err)}` : (err as Error).message);
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    await waitReady();
    return {
      prompts: registry.skills().map((s) => ({
        name: s.id,
        description: s.description,
        arguments: [{ name: "task", description: "What you want to do with this skill", required: false }],
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    await waitReady();
    const skill = registry.resolve(req.params.name);
    const task = req.params.arguments?.task?.trim();
    const content = await renderSkill(skill, registry);
    return {
      description: skill.description,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the "${skill.id}" skill below.${task ? `\n\nTask: ${task}` : ""}\n\n${content}`,
          },
        },
      ],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    await waitReady();
    return {
      resources: registry.skills().map((s) => ({
        uri: skillUri(s, SKILL_FILE),
        name: s.id,
        title: `Skill: ${s.id}`,
        description: s.description,
        mimeType: "text/markdown",
      })),
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${URI_PREFIX}{profile}/{skill}/{+path}`,
        name: "skill-file",
        description: "A file bundled with a skill (SKILL.md, scripts, references, templates).",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    await waitReady();
    const { uri } = req.params;
    const m = /^skill:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri);
    if (!m) throw new Error(`unsupported resource URI: ${uri}`);
    const [profile, name, relPath] = [m[1]!, m[2]!, m[3]!].map(decodeURIComponent) as [string, string, string];
    const skill = registry.resolve(`${profile}/${name}`);
    const file = await resolveSkillPath(skill, relPath);
    return { contents: [{ uri, mimeType: mimeFor(file), text: await readFile(file, "utf8") }] };
  });

  return server;
}

function buildTools(skills: ExposedSkill[]): Tool[] {
  const catalog = skills.length
    ? skills.map((s) => `- ${s.id}: ${oneLine(s.description)}`).join("\n")
    : "(no skills are currently available)";
  return [
    {
      name: "use_skill",
      title: "Use skill",
      description:
        "Load the full instructions of a skill. Skills are team-maintained playbooks for specific tasks. When the " +
        "user's request matches a skill below, call this BEFORE starting the work and follow the returned " +
        `instructions.\n\nAvailable skills:\n${catalog}`,
      inputSchema: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description: "Skill name from the list",
            ...(skills.length ? { enum: skills.map((s) => s.id) } : {}),
          },
        },
        required: ["skill"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "read_skill_file",
      title: "Read skill file",
      description:
        "Read a file bundled with a skill (scripts, references, templates). Paths are relative to the skill " +
        "directory, as listed by use_skill.",
      inputSchema: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Skill name" },
          path: { type: "string", description: "File path relative to the skill directory, e.g. scripts/run.py" },
        },
        required: ["skill", "path"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "list_skills",
      title: "List skills",
      description: "List available skills with their source profile, git branch and commit, plus any skills that failed to load.",
      inputSchema: {
        type: "object",
        properties: { profile: { type: "string", description: "Only list skills from this profile" } },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "refresh_skills",
      title: "Refresh skills",
      description: "Pull the latest skills from git now instead of waiting for the next poll.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
  ];
}

async function renderSkill(skill: ExposedSkill, registry: SkillRegistry): Promise<string> {
  const source = registry.status().find((p) => p.name === skill.profile);
  const { files, truncated } = await listSkillFiles(skill);
  const lines = [
    `# Skill: ${skill.id}`,
    `Profile: ${skill.profile} (${source?.repo}@${source?.branch}, commit ${source?.commit?.slice(0, 10) ?? "unknown"})`,
    `Base directory: ${skill.dir}`,
  ];
  if (files.length) {
    lines.push(
      "Bundled files (read with read_skill_file, or use directly from the base directory):",
      ...files.map((f) => `- ${f}`),
    );
    if (truncated) lines.push("- … (more files not listed)");
  }
  lines.push("", "---", "", skill.body);
  return lines.join("\n");
}

async function readSkillFile(skill: ExposedSkill, relPath: string): Promise<string> {
  const file = await resolveSkillPath(skill, relPath);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`not a file: ${relPath}`);
  if (info.size > MAX_TEXT_BYTES) {
    return `${relPath} is ${info.size} bytes, too large to return inline. Absolute path: ${file}`;
  }
  const buf = await readFile(file);
  if (buf.subarray(0, 8192).includes(0)) {
    return `${relPath} is a binary file (${info.size} bytes). Absolute path: ${file}`;
  }
  return buf.toString("utf8");
}

function renderList(registry: SkillRegistry, profile?: string): string {
  const out: string[] = [];
  for (const p of registry.status()) {
    if (profile && p.name !== profile) continue;
    out.push(
      `## Profile ${p.name}`,
      `repo: ${p.repo}  branch: ${p.branch}  path: ${p.path}`,
      `commit: ${p.commit?.slice(0, 10) ?? "(not loaded)"}  last sync: ${p.lastSyncAt?.toISOString() ?? "never"}`,
    );
    if (p.lastSyncError) out.push(`last sync error: ${p.lastSyncError}`);
    const skills = registry.skills().filter((s) => s.profile === p.name);
    out.push(...(skills.length ? skills.map((s) => `- ${s.id}: ${oneLine(s.description)}`) : ["(no skills)"]));
    for (const e of p.errors) out.push(`! failed to load ${e.file}: ${e.message}`);
    out.push("");
  }
  return out.length ? out.join("\n").trim() : `unknown profile "${profile}"`;
}

function skillUri(skill: ExposedSkill, relPath: string): string {
  return `${URI_PREFIX}${encodeURIComponent(skill.profile)}/${encodeURIComponent(skill.name)}/${relPath}`;
}

function mimeFor(file: string): string {
  if (/\.(md|markdown)$/i.test(file)) return "text/markdown";
  if (/\.json$/i.test(file)) return "application/json";
  return "text/plain";
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function text(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }] };
}

function error(t: string): CallToolResult {
  return { content: [{ type: "text", text: t }], isError: true };
}
