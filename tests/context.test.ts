import { expect, test, describe } from "bun:test";
import {
  parseDiffFiles,
  extractTestPaths,
  readFileBounded,
  collectContextFiles,
  parseRelativeImports,
  resolveImport,
} from "../src/agent/context.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseDiffFiles", () => {
  test("extracts files from +++ b/path lines", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1 +1 @@
-a
+b`;
    expect(parseDiffFiles(diff).sort()).toEqual(["src/bar.ts", "src/foo.ts"]);
  });

  test("excludes /dev/null (deletion)", () => {
    const diff = `--- a/src/deleted.ts
+++ /dev/null`;
    expect(parseDiffFiles(diff)).toEqual([]);
  });

  test("empty diff → empty array", () => {
    expect(parseDiffFiles("")).toEqual([]);
  });
});

describe("extractTestPaths", () => {
  test("bun test tests/foo.test.ts form", () => {
    expect(extractTestPaths("bun test tests/foo.test.ts")).toEqual(["tests/foo.test.ts"]);
  });
  test("multiple test files", () => {
    expect(extractTestPaths("bun test a.test.ts b.spec.js")).toEqual(["a.test.ts", "b.spec.js"]);
  });
  test("no test file specified", () => {
    expect(extractTestPaths("bun test")).toEqual([]);
  });
  test("supports tsx / spec extensions", () => {
    expect(extractTestPaths("vitest run foo.test.tsx bar.spec.js")).toEqual([
      "foo.test.tsx",
      "bar.spec.js",
    ]);
  });
});

describe("readFileBounded + collectContextFiles", () => {
  const tmp = join(tmpdir(), `shibaki-context-test-${Date.now()}`);

  test("file read + size-limit truncation", async () => {
    await mkdir(tmp, { recursive: true });
    const big = "x".repeat(50_000);
    await writeFile(join(tmp, "big.ts"), big);
    const snap = await readFileBounded("big.ts", tmp, 1000);
    expect(snap).not.toBeNull();
    expect(snap!.truncated).toBe(true);
    expect(snap!.content.length).toBeGreaterThan(1000); // truncation note appended
    expect(snap!.content.length).toBeLessThan(1200);
    expect(snap!.bytes).toBe(50_000);
    await rm(tmp, { recursive: true, force: true });
  });

  test("non-existent file → null", async () => {
    const snap = await readFileBounded("does-not-exist.ts", "/tmp", 1000);
    expect(snap).toBeNull();
  });

  test("collectContextFiles gathers both modified and test files", async () => {
    await mkdir(tmp, { recursive: true });
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "tests"), { recursive: true });
    await writeFile(join(tmp, "src/foo.ts"), "source content");
    await writeFile(join(tmp, "tests/foo.test.ts"), "test content");
    const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new`;
    const { modifiedFiles, testFiles } = await collectContextFiles({
      cwd: tmp,
      diff,
      verifyCmd: "bun test tests/foo.test.ts",
    });
    expect(modifiedFiles.map((f) => f.path)).toEqual(["src/foo.ts"]);
    expect(modifiedFiles[0].content).toBe("source content");
    expect(testFiles.map((f) => f.path)).toEqual(["tests/foo.test.ts"]);
    expect(testFiles[0].content).toBe("test content");
    await rm(tmp, { recursive: true, force: true });
  });

  test("if a test file is in modified, dedupe it on the test side", async () => {
    await mkdir(tmp, { recursive: true });
    await mkdir(join(tmp, "tests"), { recursive: true });
    await writeFile(join(tmp, "tests/foo.test.ts"), "c");
    const diff = `+++ b/tests/foo.test.ts`;
    const { modifiedFiles, testFiles } = await collectContextFiles({
      cwd: tmp,
      diff,
      verifyCmd: "bun test tests/foo.test.ts",
    });
    expect(modifiedFiles.length).toBe(1);
    expect(testFiles.length).toBe(0);
    await rm(tmp, { recursive: true, force: true });
  });
});

describe("parseRelativeImports", () => {
  test("extracts only relative-path imports", () => {
    const src = `
      import { a } from "./foo";
      import b from "../bar";
      import c from "react";
      import d from "node:fs";
      import e from "@scope/pkg";
    `;
    expect(parseRelativeImports(src).sort()).toEqual(["../bar", "./foo"]);
  });

  test("handles require / dynamic import / side-effect import", () => {
    const src = `
      const x = require("./req");
      const y = await import("./dyn");
      import "./side";
      import "react-dom/client";
    `;
    expect(parseRelativeImports(src).sort()).toEqual(["./dyn", "./req", "./side"]);
  });

  test("covers re-export from", () => {
    const src = `export * from "./reexport"; export { a } from "../other";`;
    expect(parseRelativeImports(src).sort()).toEqual(["../other", "./reexport"]);
  });

  test("handles type-only imports", () => {
    const src = `import type { T } from "./types";`;
    expect(parseRelativeImports(src)).toEqual(["./types"]);
  });

  test("dedupes duplicates", () => {
    const src = `import { a } from "./foo"; import { b } from "./foo";`;
    expect(parseRelativeImports(src)).toEqual(["./foo"]);
  });

  test("empty string / external-only → empty array", () => {
    expect(parseRelativeImports("")).toEqual([]);
    expect(parseRelativeImports(`import x from "react";`)).toEqual([]);
  });
});

describe("resolveImport", () => {
  const tmp = join(tmpdir(), `shibaki-resolve-test-${Date.now()}`);

  test("resolves omitted .ts extension", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src/foo.ts"), "x");
    await writeFile(join(tmp, "src/bar.ts"), "x");
    const r = await resolveImport("src/foo.ts", "./bar", tmp);
    expect(r).toBe("src/bar.ts");
    await rm(tmp, { recursive: true, force: true });
  });

  test("resolves directory + index.ts", async () => {
    await mkdir(join(tmp, "src/utils"), { recursive: true });
    await writeFile(join(tmp, "src/foo.ts"), "x");
    await writeFile(join(tmp, "src/utils/index.ts"), "x");
    const r = await resolveImport("src/foo.ts", "./utils", tmp);
    expect(r).toBe("src/utils/index.ts");
    await rm(tmp, { recursive: true, force: true });
  });

  test("parent directory reference", async () => {
    await mkdir(join(tmp, "src/sub"), { recursive: true });
    await writeFile(join(tmp, "src/parent.ts"), "x");
    await writeFile(join(tmp, "src/sub/child.ts"), "x");
    const r = await resolveImport("src/sub/child.ts", "../parent", tmp);
    expect(r).toBe("src/parent.ts");
    await rm(tmp, { recursive: true, force: true });
  });

  test("NodeNext-style import with trailing .ts", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src/foo.ts"), "x");
    await writeFile(join(tmp, "src/bar.ts"), "x");
    const r = await resolveImport("src/foo.ts", "./bar.ts", tmp);
    expect(r).toBe("src/bar.ts");
    await rm(tmp, { recursive: true, force: true });
  });

  test("unresolvable → null", async () => {
    await mkdir(tmp, { recursive: true });
    const r = await resolveImport("src/foo.ts", "./does-not-exist", tmp);
    expect(r).toBeNull();
    await rm(tmp, { recursive: true, force: true });
  });

  test("escaping outside cwd via ../ is rejected with null", async () => {
    // Even if the file actually exists, it returns null because it's outside cwd
    const r1 = await resolveImport("src/foo.ts", "../../../etc/passwd", tmp);
    expect(r1).toBeNull();
    const r2 = await resolveImport("src/foo.ts", "../../outside", tmp);
    expect(r2).toBeNull();
  });

  test("resolution into node_modules is rejected with null", async () => {
    await mkdir(join(tmp, "node_modules/some-lib"), { recursive: true });
    await writeFile(join(tmp, "node_modules/some-lib/index.ts"), "x");
    await mkdir(join(tmp, "src"), { recursive: true });
    const r = await resolveImport("src/foo.ts", "../node_modules/some-lib", tmp);
    expect(r).toBeNull();
    await rm(tmp, { recursive: true, force: true });
  });

  test("absolute-path references are rejected with null", async () => {
    const r = await resolveImport("src/foo.ts", "/etc/passwd", tmp);
    expect(r).toBeNull();
  });
});

describe("collectContextFiles + 1-hop import expansion (Phase 1)", () => {
  const tmp = join(tmpdir(), `shibaki-expand-test-${Date.now()}`);

  test("auto-includes relative files imported by modified files", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(
      join(tmp, "src/foo.ts"),
      `import { helper } from "./util";\nexport function foo() { return helper(); }`,
    );
    await writeFile(join(tmp, "src/util.ts"), `export function helper() { return 1; }`);
    const diff = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new`;
    const { modifiedFiles, dependencyFiles } = await collectContextFiles({
      cwd: tmp,
      diff,
      verifyCmd: "bun test",
    });
    expect(modifiedFiles.map((f) => f.path)).toEqual(["src/foo.ts"]);
    expect(dependencyFiles.map((f) => f.path)).toEqual(["src/util.ts"]);
    expect(dependencyFiles[0].content).toContain("helper");
    await rm(tmp, { recursive: true, force: true });
  });

  test("expandImports=false disables it", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src/foo.ts"), `import "./util";`);
    await writeFile(join(tmp, "src/util.ts"), `export {};`);
    const diff = `+++ b/src/foo.ts`;
    const { dependencyFiles } = await collectContextFiles({
      cwd: tmp,
      diff,
      verifyCmd: "bun test",
      expandImports: false,
    });
    expect(dependencyFiles).toEqual([]);
    await rm(tmp, { recursive: true, force: true });
  });

  test("dependencies already in modifiedFiles / testFiles are excluded from dependencyFiles", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "tests"), { recursive: true });
    // foo imports a and b. a is also in modified (duplicate).
    await writeFile(join(tmp, "src/foo.ts"), `import "./a"; import "./b";`);
    await writeFile(join(tmp, "src/a.ts"), `export {};`);
    await writeFile(join(tmp, "src/b.ts"), `export {};`);
    const diff = `+++ b/src/foo.ts\n+++ b/src/a.ts`;
    const { modifiedFiles, dependencyFiles } = await collectContextFiles({
      cwd: tmp,
      diff,
      verifyCmd: "bun test",
    });
    expect(modifiedFiles.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/foo.ts"]);
    // a is in modified so it's excluded from deps; only b remains
    expect(dependencyFiles.map((f) => f.path)).toEqual(["src/b.ts"]);
    await rm(tmp, { recursive: true, force: true });
  });

  test("ignores external module imports (does not read node_modules)", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src/foo.ts"), `import { x } from "react"; import "node:fs";`);
    const diff = `+++ b/src/foo.ts`;
    const { dependencyFiles } = await collectContextFiles({
      cwd: tmp,
      diff,
      verifyCmd: "bun test",
    });
    expect(dependencyFiles).toEqual([]);
    await rm(tmp, { recursive: true, force: true });
  });

  test("maxDependencyFiles caps the number of dependency files", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(
      join(tmp, "src/foo.ts"),
      `import "./d1"; import "./d2"; import "./d3"; import "./d4";`,
    );
    for (const n of ["d1", "d2", "d3", "d4"]) {
      await writeFile(join(tmp, `src/${n}.ts`), `export {};`);
    }
    const diff = `+++ b/src/foo.ts`;
    const { dependencyFiles } = await collectContextFiles({
      cwd: tmp,
      diff,
      verifyCmd: "bun test",
      maxDependencyFiles: 2,
    });
    expect(dependencyFiles.length).toBe(2);
    await rm(tmp, { recursive: true, force: true });
  });

  test("unresolvable imports are silently skipped (no exception)", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });
    await writeFile(join(tmp, "src/foo.ts"), `import "./nope";`);
    const diff = `+++ b/src/foo.ts`;
    const { dependencyFiles } = await collectContextFiles({
      cwd: tmp,
      diff,
      verifyCmd: "bun test",
    });
    expect(dependencyFiles).toEqual([]);
    await rm(tmp, { recursive: true, force: true });
  });
});
