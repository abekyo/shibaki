import { expect, test, describe } from "bun:test";
import { collectProjectContext } from "../src/agent/projectContext.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const newTmp = () => join(tmpdir(), `shibaki-pc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

describe("collectProjectContext", () => {
  test("collects CLAUDE.md / README / package.json / src tree", async () => {
    const tmp = newTmp();
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "tests"), { recursive: true });
    await writeFile(join(tmp, "CLAUDE.md"), "# Project Rules\n- @ts-ignore 禁止\n");
    await writeFile(join(tmp, "README.md"), "# My Project\nTOC...");
    await writeFile(join(tmp, "package.json"), JSON.stringify({
      name: "x", version: "1.0.0", scripts: { test: "bun test" }, dependencies: { "@anthropic-ai/sdk": "^0.32.0" }
    }));
    await writeFile(join(tmp, "src/index.ts"), "");
    await writeFile(join(tmp, "src/util.ts"), "");
    await writeFile(join(tmp, "tests/x.test.ts"), "");

    const pc = await collectProjectContext(tmp);
    expect(pc.conventionDocs).toHaveLength(1);
    expect(pc.conventionDocs[0].path).toBe("CLAUDE.md");
    expect(pc.conventionDocs[0].content).toContain("@ts-ignore 禁止");
    expect(pc.readmeHead).toContain("My Project");
    expect(pc.packageJson).toContain("@anthropic-ai/sdk");
    expect(pc.packageJson).toContain("scripts");
    expect(pc.sourceTree).toContain("src/");
    expect(pc.sourceTree).toContain("index.ts");
    expect(pc.sourceTree).toContain("tests/");

    await rm(tmp, { recursive: true, force: true });
  });

  test("collects all when CLAUDE.md / AGENTS.md / CONTRIBUTING.md are all present", async () => {
    const tmp = newTmp();
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, "CLAUDE.md"), "claude rules");
    await writeFile(join(tmp, "AGENTS.md"), "agent rules");
    await writeFile(join(tmp, "CONTRIBUTING.md"), "contrib rules");

    const pc = await collectProjectContext(tmp);
    expect(pc.conventionDocs).toHaveLength(3);
    const names = pc.conventionDocs.map((d) => d.path);
    expect(names).toContain("CLAUDE.md");
    expect(names).toContain("AGENTS.md");
    expect(names).toContain("CONTRIBUTING.md");

    await rm(tmp, { recursive: true, force: true });
  });

  test("does not break on an empty directory with no files", async () => {
    const tmp = newTmp();
    await mkdir(tmp, { recursive: true });
    const pc = await collectProjectContext(tmp);
    expect(pc.conventionDocs).toEqual([]);
    expect(pc.readmeHead).toBe("");
    expect(pc.packageJson).toBe("");
    expect(pc.sourceTree).toBe("");
    await rm(tmp, { recursive: true, force: true });
  });

  test("large CLAUDE.md is truncated", async () => {
    const tmp = newTmp();
    await mkdir(tmp, { recursive: true });
    const big = "x".repeat(20_000);
    await writeFile(join(tmp, "CLAUDE.md"), big);
    const pc = await collectProjectContext(tmp);
    expect(pc.conventionDocs[0].content.length).toBeLessThan(20_000);
    expect(pc.conventionDocs[0].content).toContain("truncated");
    await rm(tmp, { recursive: true, force: true });
  });

  test("extracts only dependencies / scripts from package.json (excludes license etc.)", async () => {
    const tmp = newTmp();
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, "package.json"), JSON.stringify({
      name: "x",
      version: "1.0.0",
      license: "MIT",
      author: "someone",
      scripts: { test: "bun test" },
      dependencies: { foo: "1.0.0" },
    }));
    const pc = await collectProjectContext(tmp);
    expect(pc.packageJson).toContain("foo");
    expect(pc.packageJson).toContain("test");
    expect(pc.packageJson).not.toContain("MIT");
    expect(pc.packageJson).not.toContain("someone");
    await rm(tmp, { recursive: true, force: true });
  });

  test("node_modules / hidden directories are not shown in tree", async () => {
    const tmp = newTmp();
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "src/.hidden"), { recursive: true });
    await mkdir(join(tmp, "src/node_modules"), { recursive: true });
    await writeFile(join(tmp, "src/main.ts"), "");
    await writeFile(join(tmp, "src/.hidden/secret.ts"), "");
    await writeFile(join(tmp, "src/node_modules/dep.ts"), "");
    const pc = await collectProjectContext(tmp);
    expect(pc.sourceTree).toContain("main.ts");
    expect(pc.sourceTree).not.toContain(".hidden");
    expect(pc.sourceTree).not.toContain("node_modules");
    await rm(tmp, { recursive: true, force: true });
  });
});
