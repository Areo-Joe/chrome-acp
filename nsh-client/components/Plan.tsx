import { Scroll, Text, View } from "nsh";
import { Button, TextView } from "nsh/base";
import type { Thread } from "../state/thread";
import { planStats, planSummary } from "../state/plan";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

/** The ordinary v1 plan activity bar, following Zed's render_plan_summary/body. */
export function PlanView(props: { thread: Thread }) {
  const thread = props.thread;
  const entries = () => thread.plan()?.entries ?? [];
  const stats = () => planStats(thread.plan()!);
  return (
    <If when={thread.planVisible() && entries().length > 0}>
      <View testID="plan" class="mx-2 overflow-hidden rounded-t-md border border-border bg-muted/30">
        <View class={thread.planExpanded() ? "flex-row items-center border-b border-border" : "flex-row items-center"}>
          <Button testID="plan-toggle" accessibilityLabel={thread.planExpanded() ? "Collapse Plan" : "Expand Plan"}
            onPress={thread.togglePlan} class="min-w-0 flex-1 flex-row items-center gap-1 px-2 py-1.5">
            <View style={{ rotate: thread.planExpanded() ? "0deg" : "-90deg" }}>
              <Icon name="chevron-down" size={12} />
            </View>
            <If when={!thread.planExpanded() && stats().current} else={
              <>
                <Text class="flex-1 text-xs text-muted-foreground">Plan</Text>
                <Text testID="plan-summary" class="text-xs text-muted-foreground">{planSummary(thread.plan()!)}</Text>
              </>
            }>
              <Text class="text-xs text-muted-foreground">Current:</Text>
              <View class="min-w-0 flex-1 overflow-hidden" style={{ maxHeight: 18 }}>
                <TextView markdown={stats().current!.content} class="text-xs text-muted-foreground" styles={{ root: { numberOfLines: 1, lineHeight: 18 } }} />
              </View>
              <Text testID="plan-summary" class="text-xs text-muted-foreground">{`${stats().pending} left`}</Text>
            </If>
          </Button>
          <Button testID="dismiss-plan" accessibilityLabel="Clear Plan" onPress={thread.dismissPlan} class="p-2"
            tooltip={<Text class="rounded bg-muted px-2 py-1 text-xs text-foreground">Clear Plan</Text>}>
            <Icon name="x" size={12} />
          </Button>
        </View>
        <If when={thread.planExpanded()}>
          <Scroll testID="plan-entries" style={{ maxHeight: 160, flexShrink: 1 }}>
            <Each of={entries()} key="index">
              {(entry, index) => (
                <View testID={`plan-entry-${index()}`} class="flex-row items-center gap-1.5 overflow-hidden border-border bg-background px-2 py-1"
                  style={{ borderBottomWidth: index() < entries().length - 1 ? 1 : 0 }}
                  tooltip={<Text class="max-w-80 rounded bg-muted px-2 py-1 text-xs text-foreground">{entry().content}</Text>}>
                  <If when={entry().status === "in_progress"} else={
                    <If when={entry().status === "completed"} else={
                      <View testID={`plan-pending-${index()}`} class="border-muted-foreground" style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1, flexShrink: 0 }} />
                    }>
                      <Icon name="check" size={14} tone="success" />
                    </If>
                  }><Spinner size={12} accent duration={2000} /></If>
                  <TextView markdown={entry().content} class="min-w-0 flex-1 text-xs text-muted-foreground"
                    styles={{ root: { lineHeight: 18, textDecorationLine: entry().status === "completed" ? "line-through" : "none" } }} />
                </View>
              )}
            </Each>
          </Scroll>
        </If>
      </View>
    </If>
  );
}
