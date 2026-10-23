import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpDir(prefix = "skill-manager-test-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function skillMd(name: string, description: string, body = `Instructions for ${name}.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/** A bare "remote" repo plus a working clone used to push commits to it. */
export class SkillsRepo {
  readonly remote: string;
  readonly work: string;

  constructor(root: string, name: string) {
    this.remote = path.join(root, `${name}.git`);
    this.work = path.join(root, `${name}-work`);
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", this.remote);
    git(root, "clone", "--quiet", this.remote, this.work);
    git(this.work, "checkout", "--quiet", "-B", "main");
  }

  write(rel: string, content: string): this {
    const file = path.join(this.work, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return this;
  }

  remove(rel: string): this {
    git(this.work, "rm", "--quiet", "-r", rel);
    return this;
  }

  commit(message: string, branch = "main"): this {
    git(this.work, "checkout", "--quiet", "-B", branch);
    git(this.work, "add", "-A");
    git(this.work, "commit", "--quiet", "-m", message);
    git(this.work, "push", "--quiet", "--force", "origin", branch);
    return this;
  }
}
