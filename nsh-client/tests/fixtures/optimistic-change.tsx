import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { createOptimisticChange } from "../../state/optimistic-change";

function App() {
  const confirmed = signal("Fast");
  const error = signal("none");
  const sends = signal(0);
  const change = createOptimisticChange<{ value: string; outcome: string }>({
    isConfirmed: (target) => confirmed() === target.value,
    onError: (reason) => error.set(reason instanceof Error ? reason.message : String(reason)),
    send: (target) => {
      sends.update((count) => count + 1);
      if (target.outcome === "reject") throw new Error("Rejected");
      if (target.outcome === "late-error") {
        return new Promise((_, reject) => setTimeout(() => reject(new Error("Old rejection")), 1000));
      }
      if (target.outcome !== "silent") {
        setTimeout(() => confirmed.set(target.value), target.outcome === "fast" ? 50 : 1000);
      }
      return Promise.resolve();
    },
  });
  return (
    <View>
      <Text>Actual: {confirmed()}</Text>
      <Text>Displayed: {change.target()?.value ?? confirmed()}</Text>
      <Text>Pending: {String(change.target() !== null)}</Text>
      <Text>Slow: {String(change.slow())}</Text>
      <Text>Error: {error()}</Text>
      <Text>Sends: {sends()}</Text>
      <Button testID="slow" onPress={() => change.start({ value: "Smart", outcome: "slow" })}><Text>Slow</Text></Button>
      <Button testID="fast" onPress={() => change.start({ value: "Smart", outcome: "fast" })}><Text>Fast</Text></Button>
      <Button testID="silent" onPress={() => change.start({ value: "Smart", outcome: "silent" })}><Text>Silent</Text></Button>
      <Button testID="reject" onPress={() => change.start({ value: "Smart", outcome: "reject" })}><Text>Reject</Text></Button>
      <Button testID="late-error" onPress={() => change.start({ value: "Smart", outcome: "late-error" })}><Text>Late error</Text></Button>
      <Button testID="expert" onPress={() => change.start({ value: "Expert", outcome: "silent" })}><Text>Expert</Text></Button>
      <Button testID="same" onPress={() => change.start({ value: "Fast", outcome: "silent" })}><Text>Same</Text></Button>
      <Button testID="confirm" onPress={() => confirmed.set("Smart")}><Text>Confirm</Text></Button>
      <Button testID="external" onPress={() => confirmed.set("Other")}><Text>External update</Text></Button>
      <Button testID="cancel" onPress={() => change.cancel()}><Text>Cancel</Text></Button>
      <Button testID="dispose" onPress={() => change.dispose()}><Text>Dispose</Text></Button>
    </View>
  );
}

mount(App);
