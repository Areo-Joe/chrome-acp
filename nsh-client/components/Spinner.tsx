import { View } from "nsh";

export function Spinner(props: { testID?: string; size?: number; accent?: boolean; duration?: number }) {
  const size = () => props.size ?? 14;
  return (
    <View
      testID={props.testID}
      class={props.accent ? "border-blue-500" : "border-muted-foreground"}
      style={{ pointerEvents: "none", width: size(), height: size(), flexShrink: 0, borderWidth: 2, borderRadius: size() / 2,
        borderTopColor: "transparent", animationName: "spin", animationDuration: props.duration ?? 800,
        animationTimingFunction: "linear", animationIterationCount: "infinite" }}
    />
  );
}
