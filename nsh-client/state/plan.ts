import type { Plan } from "@agentclientprotocol/sdk";

/** Zed's Plan::stats and plan_summary_label, for the ordinary v1 plan. */
export function planStats(plan: Plan) {
  let pending = 0;
  let completed = 0;
  let current: Plan["entries"][number] | undefined;
  for (const entry of plan.entries) {
    if (entry.status === "completed") completed += 1;
    else {
      pending += 1;
      if (entry.status === "in_progress") current ??= entry;
    }
  }
  return { pending, completed, current };
}

export function planSummary(plan: Plan): string {
  const { pending, completed } = planStats(plan);
  if (pending === 0) return "All Done";
  return completed === 0 ? `${plan.entries.length} Tasks` : `${completed}/${plan.entries.length}`;
}
