// Shibaki self-dogfood 用の隔離ファイル (target 2)。Shibaki runtime では import しない。
// 2 つの関数に別方向の off-by-one を仕込み、partial fix を誘発しやすくする。

export function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

export function fibonacci(n: number): number {
  if (n < 2) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}
