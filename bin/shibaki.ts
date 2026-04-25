#!/usr/bin/env bun
import { HELP_TEXT, SHORT_HELP_TEXT } from "../src/cli/help.ts";
import { cmdRun } from "../src/cli/run.ts";
import { cmdAuditPublish } from "../src/cli/audit.ts";
import { cmdDemo } from "../src/cli/demo.ts";
import { cmdDoctor } from "../src/cli/doctor.ts";
import { levenshtein } from "../src/cli/args.ts";

async function main(): Promise<number> {
  const [, , sub, ...rest] = process.argv;

  // No arguments: automatically run doctor to show env status + next action
  // ("download and immediately know what to do" UX)
  if (!sub) {
    const code = await cmdDoctor([]);
    process.stdout.write("\n----\n");
    process.stdout.write("\nFor full command list: shibaki --help\n");
    return code;
  }

  // help is two-tiered: default is SHORT (~20-line reference), --help-long for the narrative version.
  // Subcommand-side `shibaki run --help` etc. emit the run-detailed HELP_TEXT
  // (handled inside the subcommand handler).
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
    // Accept version via any of --version / -v / the version subcommand
    // (matching the gh / docker / cargo convention)
    case "version":
    case "--version":
    case "-v":
      process.stdout.write("shibaki 0.2.1\n");
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
