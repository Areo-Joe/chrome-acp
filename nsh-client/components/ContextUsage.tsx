import { Canvas, colorScheme, effect, platform, signal, Text, View } from "nsh";
import { Button, Tooltip } from "nsh/base";
import type { Thread } from "../state/thread";
import { usagePresentation } from "../state/usage";

/** Zed's external ACP thread uses a single context ring and Context/Cost tooltip. */
export function ContextUsageView(props: { thread: Thread }) {
  const pinned = signal(false);
  const hovered = signal(false);
  effect(() => { if (!props.thread.usage()) { pinned.set(false); hovered.set(false); } });
  const presentation = () => usagePresentation(props.thread.usage()!);
  return <If when={props.thread.usage()}>
    <View class="shrink-0" tooltip={<Tooltip open={pinned() || hovered()} onOpenChange={({ open }) => hovered.set(open)}
        class="min-w-40 rounded-md border border-border bg-background p-2 shadow-md">
        <Text testID="context-title" class="text-xs text-muted-foreground">Context</Text>
        <View class="flex-row items-center gap-1">
          <Text testID="context-percentage" class="text-sm text-foreground">{presentation().percentage}</Text>
          <Text class="mx-1 text-sm text-muted-foreground">•</Text>
          <Text testID="context-used" class="text-sm text-foreground">{presentation().used}</Text>
          <Text class="text-sm text-muted-foreground">/</Text>
          <Text testID="context-size" class="text-sm text-muted-foreground">{presentation().size}</Text>
        </View>
        <If when={presentation().cost !== null}>
          <View class="mt-1.5 gap-0.5 border-t border-border pt-1.5">
            <Text class="text-xs text-muted-foreground">Cost</Text>
            <Text testID="context-cost" class="text-sm text-foreground">{presentation().cost}</Text>
          </View>
        </If>
      </Tooltip>}>
      <Button testID="context-usage" accessibilityLabel={`Context: ${presentation().percentage}, ${presentation().used} / ${presentation().size}`}
        onPress={() => { if (!platform.desktop) pinned.set(!pinned()); }} class="items-center justify-center p-1">
        <Canvas testID={presentation().warning ? "context-ring-warning" : "context-ring"} style={{ width: 16, height: 16 }}
          draw={(cx) => {
            const dark = colorScheme() === "dark";
            cx.lineWidth = 2;
            cx.lineCap = "butt";
            cx.strokeStyle = dark ? "#404040" : "#e5e5e5";
            cx.beginPath(); cx.arc(8, 8, 6, 0, Math.PI * 2); cx.stroke();
            if (presentation().progress > 0) {
              cx.strokeStyle = presentation().warning ? (dark ? "#fbbf24" : "#d97706") : (dark ? "#a3a3a3" : "#737373");
              cx.beginPath(); cx.arc(8, 8, 6, -Math.PI / 2, -Math.PI / 2 + presentation().progress * Math.PI * 2); cx.stroke();
            }
          }} />
      </Button>
    </View>
  </If>;
}
