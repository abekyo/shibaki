// Manage the loop's 3-axis budget (try count / time / estimated cost).
// On any breach, escalate immediately.

export interface BudgetConfig {
  maxTries: number;
  timeoutMs: number;
  maxCostUsd?: number; // unset = no limit (Phase 1)
}

export interface BudgetState {
  tries: number;
  startedAt: number;
  costUsd: number;
}

export type BudgetBreach = "tries" | "timeout" | "cost";

export function newBudget(cfg: BudgetConfig): BudgetState {
  return { tries: 0, startedAt: Date.now(), costUsd: 0 };
}

export function checkBudget(state: BudgetState, cfg: BudgetConfig): BudgetBreach | null {
  if (state.tries >= cfg.maxTries) return "tries";
  if (Date.now() - state.startedAt >= cfg.timeoutMs) return "timeout";
  if (cfg.maxCostUsd != null && state.costUsd >= cfg.maxCostUsd) return "cost";
  return null;
}

export function budgetSummary(state: BudgetState): { tries: number; elapsedSec: number; costUsd: number } {
  return {
    tries: state.tries,
    elapsedSec: Math.round((Date.now() - state.startedAt) / 1000),
    costUsd: Number(state.costUsd.toFixed(4)),
  };
}
