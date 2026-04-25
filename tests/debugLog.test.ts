// debugLog の出力先と filename 形式の契約テスト。
// 過去の cwd-relative .shibaki/ 散らばり問題を防ぐため ~/.shibaki/logs/ に集約。
import { expect, test, describe } from "bun:test";
import { rm, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDebugLog } from "../src/loop/debugLog.ts";

describe("openDebugLog — 出力場所", () => {
  test("~/.shibaki/logs/ 配下に書き出される (cwd には書かない)", async () => {
    const cwd = "/tmp/some-fake-project";
    const logger = await openDebugLog(cwd);
    try {
      // path は ~/.shibaki/logs/ 配下
      const expectedDir = join(homedir(), ".shibaki", "logs");
      expect(logger.path.startsWith(expectedDir + "/") || logger.path.startsWith(expectedDir + "\\")).toBe(true);
      // cwd の中には作っていない
      expect(logger.path).not.toContain(cwd);
      // ファイル実在
      const s = await stat(logger.path);
      expect(s.isFile()).toBe(true);
    } finally {
      await rm(logger.path, { force: true });
    }
  });

  test("filename に project basename を含む (複数 repo の log を grep しやすく)", async () => {
    const logger = await openDebugLog("/tmp/myproject-foo");
    try {
      // basename = "myproject-foo" が filename にあるはず
      expect(logger.path).toContain("myproject-foo");
    } finally {
      await rm(logger.path, { force: true });
    }
  });

  test("最初の record に cwd が記録される (basename 衝突時の区別子)", async () => {
    const cwd = "/tmp/foo/bar/projectX";
    const logger = await openDebugLog(cwd);
    try {
      const content = await readFile(logger.path, "utf8");
      const firstLine = content.split("\n")[0];
      const obj = JSON.parse(firstLine);
      expect(obj.kind).toBe("session_meta");
      expect(obj.cwd).toBe(cwd);
    } finally {
      await rm(logger.path, { force: true });
    }
  });

  test("filename 不正文字はサニタイズ", async () => {
    const cwd = "/tmp/with spaces and / slashes";
    const logger = await openDebugLog(cwd);
    try {
      // basename = "with spaces and " (trailing slash の前) → space などサニタイズで _ に
      // path には空白 / スラッシュは入らない (basename 由来部分について)
      const fname = logger.path.split("/").pop()!;
      expect(fname).not.toMatch(/[ ]/);
    } finally {
      await rm(logger.path, { force: true });
    }
  });
});
