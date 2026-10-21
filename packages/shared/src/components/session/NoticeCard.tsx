import { AlertTriangle, Info, X, XCircle } from "lucide-react";
import type { Notice } from "../../acp/types";
import { cn } from "../../lib/utils";

/**
 * Fire-and-forget notice from the agent (`notice` session update).
 *
 * Reference: ACP "session notices" RFD. Clients that advertise
 * `session.notices` receive these live events; they are intentionally not
 * part of the persisted transcript.
 */
export function NoticeCard({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss?: () => void;
}) {
  const Icon =
    notice.severity === "error"
      ? XCircle
      : notice.severity === "warning"
        ? AlertTriangle
        : Info;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        notice.severity === "error" &&
          "border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400",
        notice.severity === "warning" &&
          "border-orange-500/30 bg-orange-500/5 text-orange-600 dark:text-orange-400",
        notice.severity !== "error" &&
          notice.severity !== "warning" &&
          "border-blue-500/30 bg-blue-500/5 text-blue-600 dark:text-blue-400",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{notice.title}</div>
        {notice.description && (
          <div className="whitespace-pre-wrap text-xs opacity-90">
            {notice.description}
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
          aria-label="Dismiss notice"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
