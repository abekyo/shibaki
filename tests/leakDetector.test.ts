import { expect, test, describe } from "bun:test";
import { auditDirectory } from "../src/audit/leakDetector.ts";
import { SECRET_PATTERNS, isTestOrDocsPath } from "../src/audit/secretPatterns.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const newTmp = () => join(tmpdir(), `shibaki-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function setupRepo(tmp: string): Promise<void> {
  await mkdir(tmp, { recursive: true });
  git(tmp, "init", "-q", "-b", "main");
  git(tmp, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-q", "-m", "init");
}

describe("SECRET_PATTERNS regex", () => {
  test("OpenAI sk-proj key を検出", () => {
    const p = SECRET_PATTERNS.find((x) => x.id === "openai_api_key")!;
    expect("sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".match(p.regex)).not.toBeNull();
  });
  test("Anthropic sk-ant key を検出", () => {
    const p = SECRET_PATTERNS.find((x) => x.id === "anthropic_api_key")!;
    expect("sk-ant-bbbbbbbbbbbbbbbbbbbb".match(p.regex)).not.toBeNull();
  });
  test("Google AIza key を検出", () => {
    const p = SECRET_PATTERNS.find((x) => x.id === "google_api_key")!;
    expect("AIzaCccccccccccccccccccccccccccccccccccc".match(p.regex)).not.toBeNull();
  });
  test("GitHub PAT (ghp_) を検出", () => {
    const p = SECRET_PATTERNS.find((x) => x.id === "github_pat")!;
    expect("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".match(p.regex)).not.toBeNull();
  });
  test("AWS AKIA を検出", () => {
    const p = SECRET_PATTERNS.find((x) => x.id === "aws_access_key")!;
    expect("AKIAIOSFODNN7EXAMPLE".match(p.regex)).not.toBeNull();
  });
});

describe("isTestOrDocsPath", () => {
  test("tests/ / docs/ はマッチ", () => {
    expect(isTestOrDocsPath("tests/foo.ts")).toBe(true);
    expect(isTestOrDocsPath("docs/x.md")).toBe(true);
    expect(isTestOrDocsPath("examples/y.ts")).toBe(true);
  });
  test(".test.ts / .spec.js もマッチ", () => {
    expect(isTestOrDocsPath("src/foo.test.ts")).toBe(true);
    expect(isTestOrDocsPath("src/bar.spec.js")).toBe(true);
  });
  test("README / SECURITY / CHANGELOG もマッチ", () => {
    expect(isTestOrDocsPath("README.md")).toBe(true);
    expect(isTestOrDocsPath("SECURITY.md")).toBe(true);
  });
  test("普通の src/ ファイルはマッチしない", () => {
    expect(isTestOrDocsPath("src/foo.ts")).toBe(false);
    expect(isTestOrDocsPath("bin/cli.ts")).toBe(false);
  });
});

describe("auditDirectory — secret detection", () => {
  test("clean repo は ok=true", async () => {
    const tmp = newTmp();
    await setupRepo(tmp);
    await writeFile(join(tmp, "README.md"), "# clean\nNo secrets here.\n");
    git(tmp, "add", ".");
    git(tmp, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "add readme");
    const r = await auditDirectory({ cwd: tmp });
    expect(r.ok).toBe(true);
    expect(r.leaks).toEqual([]);
    await rm(tmp, { recursive: true, force: true });
  });

  test("OpenAI key を含むソースを検出", async () => {
    const tmp = newTmp();
    await setupRepo(tmp);
    await writeFile(
      join(tmp, "leak.ts"),
      'export const KEY = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\n',
    );
    git(tmp, "add", ".");
    git(tmp, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "leak");
    const r = await auditDirectory({ cwd: tmp });
    expect(r.ok).toBe(false);
    expect(r.leaks.some((l) => l.kind === "secret" && l.patternId === "openai_api_key")).toBe(true);
    await rm(tmp, { recursive: true, force: true });
  });

  test("custom 禁止語を検出", async () => {
    const tmp = newTmp();
    await setupRepo(tmp);
    await mkdir(join(tmp, ".shibaki"), { recursive: true });
    await writeFile(join(tmp, ".shibaki/sensitive-strings.txt"), "InternalProductX\n# comment\nJaneDoe\n");
    await writeFile(join(tmp, "doc.md"), "InternalProductX is great\n");
    git(tmp, "add", ".");
    git(tmp, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "test");
    const r = await auditDirectory({ cwd: tmp });
    expect(r.ok).toBe(false);
    expect(r.leaks.some((l) => l.kind === "custom_string" && l.excerpt.includes("InternalProductX"))).toBe(true);
    await rm(tmp, { recursive: true, force: true });
  });

  test("commit message の禁止語を検出", async () => {
    const tmp = newTmp();
    await setupRepo(tmp);
    await mkdir(join(tmp, ".shibaki"), { recursive: true });
    await writeFile(join(tmp, ".shibaki/sensitive-strings.txt"), "ProjectX\n");
    await writeFile(join(tmp, "x.md"), "no leak in file\n");
    git(tmp, "add", ".");
    git(
      tmp,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "fix bug from ProjectX",
    );
    const r = await auditDirectory({ cwd: tmp });
    expect(r.ok).toBe(false);
    expect(r.leaks.some((l) => l.patternId === "git_msg_custom")).toBe(true);
    await rm(tmp, { recursive: true, force: true });
  });

  test("commit author の禁止語を検出", async () => {
    const tmp = newTmp();
    await setupRepo(tmp);
    await mkdir(join(tmp, ".shibaki"), { recursive: true });
    await writeFile(join(tmp, ".shibaki/sensitive-strings.txt"), "leaky_user\n");
    await writeFile(join(tmp, "x.md"), "ok\n");
    git(tmp, "add", ".");
    git(
      tmp,
      "-c",
      "user.name=leaky_user",
      "-c",
      "user.email=leak@example.com",
      "commit",
      "-q",
      "-m",
      "msg ok",
    );
    const r = await auditDirectory({ cwd: tmp });
    expect(r.ok).toBe(false);
    expect(r.leaks.some((l) => l.patternId === "git_author_custom")).toBe(true);
    await rm(tmp, { recursive: true, force: true });
  });

  test("test ファイル内の dummy key (sk-ant-xxx) は除外", async () => {
    const tmp = newTmp();
    await setupRepo(tmp);
    await mkdir(join(tmp, "tests"), { recursive: true });
    await writeFile(join(tmp, "tests/foo.test.ts"), `expect("sk-ant-fake-test-key-aaaaaaaaaaaa").toBe("x");\n`);
    git(tmp, "add", ".");
    git(tmp, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "test add");
    const r = await auditDirectory({ cwd: tmp });
    // looksLikeDummy で除外されるはず
    expect(r.leaks.filter((l) => l.kind === "secret").length).toBe(0);
    await rm(tmp, { recursive: true, force: true });
  });
});
