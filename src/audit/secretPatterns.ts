// Known secret pattern set. A minimal set drawn from the main patterns in gitleaks / truffleHog.
// Used only for release-time sweeps; do not feed into the critic loop.
//
// At this layer, prefer "if in doubt, flag it" without fearing false positives (strict-before-release is correct).
// In real operation, the README recommends running a dedicated tool like gitleaks alongside.

export interface SecretPattern {
  id: string;
  description: string;
  regex: RegExp;
  // To reduce false positives, allow this pattern in test files / docs
  allowInTestsAndDocs?: boolean;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  // ===== OpenAI =====
  {
    id: "openai_api_key",
    description: "OpenAI API key (sk-proj- prefix)",
    regex: /sk-proj-[A-Za-z0-9_\-]{40,}/g,
  },
  {
    id: "openai_legacy_key",
    description: "OpenAI legacy API key (sk- prefix, 40+ chars)",
    regex: /sk-[A-Za-z0-9]{40,}/g,
  },

  // ===== Anthropic =====
  {
    id: "anthropic_api_key",
    description: "Anthropic API key (sk-ant- prefix)",
    regex: /sk-ant-[A-Za-z0-9_\-]{20,}/g,
  },

  // ===== Google / Gemini =====
  {
    id: "google_api_key",
    description: "Google / Gemini API key (AIza prefix)",
    regex: /AIza[A-Za-z0-9_\-]{35}/g,
  },

  // ===== GitHub =====
  {
    id: "github_pat",
    description: "GitHub Personal Access Token (ghp_, github_pat_)",
    regex: /(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})/g,
  },
  {
    id: "github_oauth",
    description: "GitHub OAuth token (gho_)",
    regex: /gho_[A-Za-z0-9]{36}/g,
  },

  // ===== Slack =====
  {
    id: "slack_token",
    description: "Slack token (xoxb-, xoxp-, xoxa-)",
    regex: /xox[bpas]-[A-Za-z0-9\-]{10,}/g,
  },

  // ===== AWS =====
  {
    id: "aws_access_key",
    description: "AWS Access Key ID (AKIA prefix)",
    regex: /AKIA[0-9A-Z]{16}/g,
  },

  // ===== Stripe =====
  {
    id: "stripe_live_key",
    description: "Stripe live key (sk_live_)",
    regex: /sk_live_[A-Za-z0-9]{24,}/g,
  },

  // ===== generic =====
  {
    id: "private_key_block",
    description: "PEM private key block",
    regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: "jwt_token",
    description: "JWT token (long base64 with two dots)",
    regex: /eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,
  },
];

/** Tolerate false positives if the path is in tests or docs */
export function isTestOrDocsPath(path: string): boolean {
  return /(^|\/)(tests?|spec|docs?|examples?|fixtures?|samples?)\//.test(path)
    || /\.(test|spec)\.[jt]sx?$/.test(path)
    || /\.(md|mdx)$/.test(path)
    || /(^|\/)(README|CHANGELOG|LICENSE|SECURITY|CONTRIBUTING)/i.test(path);
}
