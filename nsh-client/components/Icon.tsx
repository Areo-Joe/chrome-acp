import { Canvas, type CanvasRenderingContext2D } from "nsh";
import { colorScheme } from "nsh/device";

type IconName = "chevron-down" | "arrow-up";

function line(context: CanvasRenderingContext2D, points: number[]) {
  context.beginPath();
  context.moveTo(points[0], points[1]);
  for (let index = 2; index < points.length; index += 2) context.lineTo(points[index], points[index + 1]);
  context.stroke();
}

export function Icon(props: { name: IconName; size?: number; primaryForeground?: boolean }) {
  return (
    <Canvas
      pointerEvents="none"
      style={{ width: props.size ?? 18, height: props.size ?? 18, flexShrink: 0 }}
      draw={(context, { width }) => {
        context.scale(width / 20, width / 20);
        context.strokeStyle = props.primaryForeground
          ? colorScheme() === "dark" ? "#171717" : "#fafafa"
          : colorScheme() === "dark" ? "#a3a3a3" : "#737373";
        context.lineWidth = 1.7;
        context.lineCap = "round";
        context.lineJoin = "round";
        switch (props.name) {
          case "chevron-down":
            line(context, [5, 8, 10, 13, 15, 8]);
            break;
          case "arrow-up":
            line(context, [10, 16, 10, 4]);
            line(context, [5, 9, 10, 4, 15, 9]);
            break;
        }
      }}
    />
  );
}
