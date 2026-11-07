import { colorScheme, Image } from "nsh";
import arrowUp from "../icons/arrow-up.svg";
import brain from "../icons/brain.svg";
import check from "../icons/check.svg";
import chevronDown from "../icons/chevron-down.svg";
import chevronUp from "../icons/chevron-up.svg";
import circleX from "../icons/circle-x.svg";
import copy from "../icons/copy.svg";
import square from "../icons/square.svg";
import x from "../icons/x.svg";

const icons = {
  "arrow-up": arrowUp, brain, check, "chevron-down": chevronDown, "chevron-up": chevronUp,
  "circle-x": circleX, copy, square, x,
};

const tones = {
  muted: { light: "#737373", dark: "#a3a3a3" },
  foreground: { light: "#0a0a0a", dark: "#fafafa" },
  "primary-foreground": { light: "#fafafa", dark: "#171717" },
  destructive: { light: "#dc2626", dark: "#f87171" },
};

export function Icon(props: { name: keyof typeof icons; size?: number; tone?: keyof typeof tones }) {
  return (
    <Image
      src={icons[props.name]}
      pointerEvents="none"
      style={{
        width: props.size ?? 18,
        height: props.size ?? 18,
        flexShrink: 0,
        tintColor: tones[props.tone ?? "muted"][colorScheme() === "dark" ? "dark" : "light"],
      }}
    />
  );
}
