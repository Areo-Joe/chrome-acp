import { colorScheme, Image } from "nsh";
import arrowDown from "../icons/arrow-down.svg";
import arrowRightLeft from "../icons/arrow-right-left.svg";
import arrowUp from "../icons/arrow-up.svg";
import brain from "../icons/brain.svg";
import checkCheck from "../icons/check-check.svg";
import check from "../icons/check.svg";
import chevronDown from "../icons/chevron-down.svg";
import chevronUp from "../icons/chevron-up.svg";
import circleX from "../icons/circle-x.svg";
import copy from "../icons/copy.svg";
import fileX from "../icons/file-x.svg";
import globe from "../icons/globe.svg";
import hammer from "../icons/hammer.svg";
import pencil from "../icons/pencil.svg";
import search from "../icons/search.svg";
import squareTerminal from "../icons/square-terminal.svg";
import square from "../icons/square.svg";
import triangle from "../icons/triangle.svg";
import x from "../icons/x.svg";

const icons = {
  "arrow-down": arrowDown, "arrow-right-left": arrowRightLeft, "arrow-up": arrowUp, brain, "check-check": checkCheck, check,
  "chevron-down": chevronDown, "chevron-up": chevronUp, "circle-x": circleX, copy, "file-x": fileX,
  globe, hammer, pencil, search, "square-terminal": squareTerminal, square, triangle, x,
};

export type IconName = keyof typeof icons;

const tones = {
  muted: { light: "#737373", dark: "#a3a3a3" },
  foreground: { light: "#0a0a0a", dark: "#fafafa" },
  "primary-foreground": { light: "#fafafa", dark: "#171717" },
  destructive: { light: "#dc2626", dark: "#f87171" },
  success: { light: "#16a34a", dark: "#4ade80" },
  warning: { light: "#d97706", dark: "#fbbf24" },
};

export function Icon(props: { name: IconName; size?: number; tone?: keyof typeof tones }) {
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
