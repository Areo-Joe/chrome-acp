import { View } from "nsh";
import { Icon } from "./Icon";

export function Spinner(props: { testID?: string; size?: number; accent?: boolean; duration?: number }) {
  const size = () => props.size ?? 14;
  return (
    <View
      testID={props.testID}
      style={{ pointerEvents: "none", width: size(), height: size(), flexShrink: 0,
        animationName: "spin", animationDuration: props.duration ?? 800,
        animationTimingFunction: "linear", animationIterationCount: "infinite" }}
    >
      <Icon name="loader-circle" size={size()} tone={props.accent ? "accent" : "muted"} />
    </View>
  );
}
