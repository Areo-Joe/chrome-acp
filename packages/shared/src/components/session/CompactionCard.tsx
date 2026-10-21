import { CheckCircle2, Loader2, Minimize2, XCircle } from "lucide-react";
import type { ContentBlock } from "../../acp/types";
import { ContentBlockList } from "../ai-elements/content-blocks";
import { cn } from "../../lib/utils";

export interface CompactionView {
  id: string;
  status: string;
  summary: ContentBlock[];
  error?: string | null;
}

/**
 * Context-compaction timeline entry.
 *
 * Reference: ACP `compaction_update` / `compaction_summary_chunk` (Zed
 * `upsert_context_compaction_update_inner` / `append_context_compaction_summary`).
 */
export function CompactionCard({ view }: { view: CompactionView }) {
  const Icon =
    view.status === "completed"
      ? CheckCircle2
      : view.status === "failed" || view.status === "cancelled"
        ? XCircle
        : Loader2;

  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-2">
        <Minimize2 className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {view.status === "completed"
            ? "Context compacted"
            : view.status === "failed"
              ? "Context compaction failed"
              : view.status === "cancelled"
                ? "Context compaction cancelled"
                : "Compacting context…"}
        </span>
        <Icon
          className={cn(
            "ml-auto size-4",
            view.status === "completed" && "text-emerald-500",
            (view.status === "failed" || view.status === "cancelled") &&
              "text-red-500",
            view.status !== "completed" &&
              view.status !== "failed" &&
              view.status !== "cancelled" &&
              "animate-spin text-blue-500",
          )}
        />
      </div>
      {view.error && (
        <div className="mt-1 text-xs text-red-500">{view.error}</div>
      )}
      {view.summary.length > 0 && (
        <div className="mt-2 text-xs">
          <ContentBlockList blocks={view.summary} />
        </div>
      )}
    </div>
  );
}
