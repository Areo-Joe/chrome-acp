import type { Cost, UsageUpdate } from "@agentclientprotocol/sdk";

export type ContextUsage = { used: number; size: number; cost: Cost | null };

/** AcpThread::update_session(v1) + update_usage: v1 never clears cost. */
export function applyUsage(previous: ContextUsage | null, update: UsageUpdate): ContextUsage {
  return { used: update.used, size: update.size, cost: update.cost ?? previous?.cost ?? null };
}

/** agent_ui::humanize_token_count, including the carry at rounding boundaries. */
export function humanizeTokens(count: number): string {
  const n = BigInt(count);
  if (n < 1000n) return n.toString();
  if (n < 10000n || (n >= 1000000n && n < 10000000n)) {
    const unit = n < 10000n ? 1000n : 1000000n;
    const tenths = (n + unit / 20n) / (unit / 10n);
    return `${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ""}${unit === 1000n ? "k" : "M"}`;
  }
  const unit = n < 1000000n ? 1000n : 1000000n;
  return `${(n + unit / 2n) / unit}${unit === 1000n ? "k" : "M"}`;
}

/** Rust's fixed f64 formatter rounds the exact binary value, ties to even.
 * JS toFixed uses a different tie rule and exponent notation for large amounts.
 */
export function fixedCost(amount: number, precision: number): string {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, amount);
  const high = bits.getUint32(0);
  const exponent = (high >>> 20) & 0x7ff;
  const mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(bits.getUint32(4));
  const significand = exponent === 0 ? mantissa : mantissa | (1n << 52n);
  const shift = exponent === 0 ? -1074 : exponent - 1023 - 52;
  let numerator = significand * 10n ** BigInt(precision);
  let denominator = 1n;
  if (shift >= 0) numerator <<= BigInt(shift);
  else denominator <<= BigInt(-shift);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n !== 0n)) rounded += 1n;
  const digits = rounded.toString().padStart(precision + 1, "0");
  return `${high >>> 31 ? "-" : ""}${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
}

export function usagePresentation(usage: ContextUsage) {
  // Zed divides f32 operands and rounds the f32 product before its u32 cast.
  const ratio = usage.size > 0 ? Math.fround(Math.fround(usage.used) / Math.fround(usage.size)) : 0;
  const percentage = Math.min(0xffffffff, Math.floor(Math.fround(ratio * 100) + 0.5));
  const cost = usage.cost;
  return {
    ratio, progress: Math.min(1, Math.max(0, ratio)), warning: ratio >= Math.fround(0.85),
    percentage: `${percentage}%`, used: humanizeTokens(usage.used), size: humanizeTokens(usage.size),
    cost: cost ? `${fixedCost(cost.amount, cost.amount > 0 && cost.amount < 0.01 ? 4 : 2)} ${cost.currency}` : null,
  };
}
