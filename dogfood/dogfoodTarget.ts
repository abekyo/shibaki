// Isolated file for Shibaki self-dogfood. Not imported by the Shibaki runtime itself.
// A target with intentional bugs for Shibaki to fix, used to observe its behavior.

export function clamp(value: number, min: number, max: number): number {
  // Intentional off-by-one: breaks at the min / max boundaries
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function isEven(n: number): boolean {
  // Intentional inversion bug: even-number check is flipped
  return n % 2 === 0;
}
