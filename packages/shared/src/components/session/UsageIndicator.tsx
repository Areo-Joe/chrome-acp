import type { ACPClient } from "../../acp/client";
import { useTurnUsage, useUsage } from "../../hooks/useSessionConfig";
import { cn } from "../../lib/utils";

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatCost(amount: number, currency: string): string {
  const formatted = amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
  return `${formatted} ${currency}`;
}

/**
 * Context-window usage and cumulative cost.
 *
 * Reference: Zed's token usage indicator (`usage_update` notifications).
 * The cost is sticky: an update that omits it keeps the previous value.
 */
export function UsageIndicator({ client }: { client: ACPClient }) {
  const usage = useUsage(client);
  const turnUsage = useTurnUsage(client);
  if (!usage) return null;

  const ratio = usage.size > 0 ? usage.used / usage.size : 0;
  const percent = Math.min(100, Math.round(ratio * 100));

  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums",
        ratio >= 0.8 && "text-orange-500",
      )}
      title={[
        `Context: ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`,
        turnUsage &&
          `Last turn: ${turnUsage.inputTokens.toLocaleString()} in / ${turnUsage.outputTokens.toLocaleString()} out`,
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <span
        className={cn(
          "inline-block size-2 rounded-full",
          ratio >= 0.8 ? "bg-orange-500" : "bg-emerald-500",
        )}
      />
      <span>
        {formatTokens(usage.used)}/{formatTokens(usage.size)}
      </span>
      {usage.cost && (
        <span className="text-muted-foreground/80">
          {formatCost(usage.cost.amount, usage.cost.currency)}
        </span>
      )}
      <span className="sr-only">{percent}% context used</span>
    </span>
  );
}
