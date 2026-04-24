import { expect, test, describe } from "bun:test";
import { parseDiffFiles, extractTestPaths, readFileBounded, collectContextFiles } from "../src/agent/context.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseDiffFiles", () => {
  test("+++ b/path 行からファイルを抽出", () => {
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

  test("/dev/null (削除) は除外", () => {
    const diff = `--- a/src/deleted.ts
+++ /dev/null`;
    expect(parseDiffFiles(diff)).toEqual([]);
  });

  test("空 diff は空配列", () => {
    expect(parseDiffFiles("")).toEqual([]);
  });
});

describe("extractTestPaths", () => {
  test("bun test tests/foo.test.ts 形式", () => {
    expect(extractTestPaths("bun test tests/foo.test.ts")).toEqual(["tests/foo.test.ts"]);
  });
  test("複数 test ファイル", () => {
    expect(extractTestPaths("bun test a.test.ts b.spec.js")).toEqual(["a.test.ts", "b.spec.js"]);
  });
  test("test ファイル指定なし", () => {
    expect(extractTestPaths("bun test")).toEqual([]);
  });
  test("tsx / spec 拡張子対応", () => {
    expect(extractTestPaths("vitest run foo.test.tsx bar.spec.js")).toEqual([
      "foo.test.tsx",
      "bar.spec.js",
    ]);
  });
});

describe("readFileBounded + collectContextFiles", () => {
  const tmp = join(tmpdir(), `shibaki-context-test-${Date.now()}`);

  test("ファイル読み込み + サイズ上限切り詰め", async () => {
    await mkdir(tmp, { recursive: true });
    const big = "x".repeat(50_000);
    await writeFile(join(tmp, "big.ts"), big);
    const snap = await readFileBounded("big.ts", tmp, 1000);
    expect(snap).not.toBeNull();
    expect(snap!.truncated).toBe(true);
    expect(snap!.content.length).toBeGreaterThan(1000); // truncation note 付く
    expect(snap!.content.length).toBeLessThan(1200);
    expect(snap!.bytes).toBe(50_000);
    await rm(tmp, { recursive: true, force: true });
  });

  test("存在しないファイルは null", async () => {
    const snap = await readFileBounded("does-not-exist.ts", "/tmp", 1000);
    expect(snap).toBeNull();
  });

  test("collectContextFiles は modified + test 両方回収", async () => {
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

  test("test ファイルが modified に含まれる場合は test 側から重複排除", async () => {
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
