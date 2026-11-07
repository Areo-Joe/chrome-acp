import { colorScheme, Image } from "nsh";
import arrowUp from "../icons/arrow-up.svg";
import check from "../icons/check.svg";
import chevronDown from "../icons/chevron-down.svg";

const icons = { "chevron-down": chevronDown, "arrow-up": arrowUp, check };

export function Icon(props: { name: keyof typeof icons; size?: number; foreground?: boolean; primaryForeground?: boolean }) {
  const dark = () => colorScheme() === "dark";
  return (
    <Image
      src={icons[props.name]}
      pointerEvents="none"
      style={{
        width: props.size ?? 18,
        height: props.size ?? 18,
        flexShrink: 0,
        tintColor: props.primaryForeground
          ? dark() ? "#171717" : "#fafafa"
          : props.foreground
            ? dark() ? "#fafafa" : "#0a0a0a"
            : dark() ? "#a3a3a3" : "#737373",
      }}
    />
  );
}
