import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withLock } from "./lock.js";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      // Never block on an interactive credential prompt: the server runs headless under an agent.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`);
  }
}

async function originUrl(dir: string): Promise<string | undefined> {
  if (!existsSync(path.join(dir, ".git"))) return undefined;
  return git(["remote", "get-url", "origin"], dir).catch(() => undefined);
}

/**
 * Makes `dir` a shallow checkout of `branch` from `repo` and returns the checked-out commit. The checkout is treated
 * as a read-only mirror: local changes are discarded, and a checkout pointing at a different remote is re-cloned.
 */
export async function syncCheckout(repo: string, branch: string, dir: string): Promise<string> {
  return withLock(`${dir}.lock`, async () => {
    if ((await originUrl(dir)) !== repo) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      await git(["clone", "--quiet", "--depth", "1", "--single-branch", "--branch", branch, repo, dir]);
    } else {
      // Fetching into FETCH_HEAD (rather than a tracking ref) also handles the tracked branch being changed in config.
      await git(["fetch", "--quiet", "--depth", "1", "--force", "origin", branch], dir);
      await git(["reset", "--quiet", "--hard", "FETCH_HEAD"], dir);
      await git(["clean", "-fdxq"], dir);
    }
    return git(["rev-parse", "HEAD"], dir);
  });
}

/** Returns the commit of an existing checkout, or undefined when there is none. */
export async function currentCommit(dir: string): Promise<string | undefined> {
  if (!existsSync(path.join(dir, ".git"))) return undefined;
  return git(["rev-parse", "HEAD"], dir).catch(() => undefined);
}
