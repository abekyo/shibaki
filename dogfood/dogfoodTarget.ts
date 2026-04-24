// Shibaki self-dogfood 用の隔離ファイル。Shibaki 自身の runtime では import しない。
// わざとバグを仕込んで Shibaki に直させ、挙動を観測するための標的。

export function clamp(value: number, min: number, max: number): number {
  // 意図的な off-by-one: min / max 境界で壊れる
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function isEven(n: number): boolean {
  // 意図的な反転バグ: 偶数判定が逆
  return n % 2 === 0;
}
