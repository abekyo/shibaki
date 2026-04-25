#!/usr/bin/env bun
import { HELP_TEXT, SHORT_HELP_TEXT } from "../src/cli/help.ts";
import { cmdRun } from "../src/cli/run.ts";
import { cmdAuditPublish } from "../src/cli/audit.ts";
import { cmdDemo } from "../src/cli/demo.ts";
import { cmdDoctor } from "../src/cli/doctor.ts";
import { levenshtein } from "../src/cli/args.ts";

async function main(): Promise<number> {
  const [, , sub, ...rest] = process.argv;

  // 引数なしの場合: 自動で doctor を走らせて env 状況 + 次の action を表示
  // (「ダウンロードしてすぐ何をすればいいか分かる」UX)
  if (!sub) {
    const code = await cmdDoctor([]);
    process.stdout.write("\n----\n");
    process.stdout.write("\nFor full command list: shibaki --help\n");
    return code;
  }

  // help は 2 段構成: default は SHORT (~20 行 reference)、--help-long で物語版。
  // `shibaki run --help` 等の subcommand 側は run-detailed の HELP_TEXT を出す
  // (subcommand 内 handler が担当)。
  if (sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(SHORT_HELP_TEXT);
    return 0;
  }
  if (sub === "--help-long" || sub === "help-long") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  switch (sub) {
    case "run":
      return await cmdRun(rest);
    case "demo":
      return await cmdDemo(rest);
    case "doctor":
      return await cmdDoctor(rest);
    case "audit-publish":
      return await cmdAuditPublish(rest);
    // version は --version / -v / version subcommand のいずれでも受ける
    // (gh / docker / cargo の慣習に合わせる)
    case "version":
    case "--version":
    case "-v":
      process.stdout.write("shibaki 0.1.0\n");
      return 0;
    default: {
      const known = ["run", "demo", "doctor", "audit-publish", "version"];
      const close = known.find((k) => levenshtein(sub, k) <= 2);
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      if (close) {
        process.stderr.write(`did you mean ${close}?\n`);
      } else {
        process.stderr.write(`available: ${known.join(" / ")}\n`);
      }
      process.stderr.write(`for the full reference: shibaki --help\n`);
      return 2;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`✗ unexpected error: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
