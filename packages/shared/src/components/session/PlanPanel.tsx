import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  ListChecks,
} from "lucide-react";
import type { PlanEntry } from "../../acp/types";
import { MessageResponse } from "../ai-elements/message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../../lib/utils";

/** A plan as displayed by the client. */
export interface PlanView {
  /** "legacy" for the plain `plan` update, otherwise the plan id. */
  id: string;
  entries?: PlanEntry[];
  markdown?: string;
  uri?: string;
}

function PlanEntryRow({ entry }: { entry: PlanEntry }) {
  const Icon =
    entry.status === "completed"
      ? CheckCircle2
      : entry.status === "in_progress"
        ? CircleDot
        : Circle;

  return (
    <li className="flex items-start gap-2 py-0.5">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          entry.status === "completed" && "text-emerald-500",
          entry.status === "in_progress" && "text-blue-500",
          entry.status === "pending" && "text-muted-foreground",
        )}
      />
      <span
        className={cn(
          "text-xs",
          entry.status === "completed" &&
            "text-muted-foreground line-through decoration-muted-foreground/40",
          entry.status === "in_progress" && "font-medium",
        )}
      >
        {entry.content}
      </span>
      {entry.priority === "high" && (
        <span className="ml-auto rounded bg-orange-500/10 px-1 text-[10px] text-orange-500">
          high
        </span>
      )}
    </li>
  );
}

/**
 * Plan card shown above the conversation.
 *
 * Reference: Zed keeps one legacy plan plus ID-addressed plans; every `plan` /
 * `plan_update` is a full replacement for that plan.
 */
export function PlanPanel({ plan }: { plan: PlanView | null }) {
  const [open, setOpen] = useState(true);
  if (!plan) return null;

  const entries = plan.entries ?? [];
  const completed = entries.filter((entry) => entry.status === "completed").length;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mx-2 mt-2 rounded-lg border bg-muted/30 px-3 py-2"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
        <ListChecks className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Plan</span>
        {entries.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {completed}/{entries.length}
          </span>
        )}
        {open ? (
          <ChevronUp className="ml-auto size-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="ml-auto size-4 text-muted-foreground" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {entries.length > 0 && (
          <ul className="mt-2">
            {entries.map((entry, index) => (
              <PlanEntryRow key={`${index}-${entry.content}`} entry={entry} />
            ))}
          </ul>
        )}
        {plan.markdown && (
          <div className="mt-2 text-xs">
            <MessageResponse>{plan.markdown}</MessageResponse>
          </div>
        )}
        {plan.uri && (
          <a
            className="mt-2 block truncate text-xs text-blue-500 underline"
            href={plan.uri}
            target="_blank"
            rel="noreferrer"
          >
            {plan.uri}
          </a>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
