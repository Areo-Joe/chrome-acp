import { cleanup, Input, mount, Scroll, signal, Text, View } from "nsh";
import { Button, Keyboard } from "nsh/base";
import { connectionUrl, createConnection } from "./state/connection";

function App() {
  const address = signal("");
  const token = signal("");
  const connection = createConnection();
  const active = () => connection.state() === "connecting" || connection.state() === "connected";
  const canConnect = () => !active() && connectionUrl(address()) !== null;
  const status = () => ({
    disconnected: "Disconnected",
    connecting: "Connecting…",
    connected: "Connected",
    error: "Connection failed",
  })[connection.state()];
  cleanup(() => connection.disconnect());

  return (
    <Scroll class="flex-1 bg-background" contentClass="px-6 py-12" keyboardShouldPersistTaps="handled">
      <View class="w-full max-w-md gap-8 self-center">
        <Text class="text-3xl font-semibold text-foreground">NSH Client</Text>
        <View class="gap-5">
          <View class="gap-2">
            <Text class="text-sm font-medium text-foreground">WS Address</Text>
            <Input
              testID="ws-address"
              value={address()}
              readonly={active()}
              onChange={(value) => address.set(value)}
              placeholder="ws://192.168.1.100:9315/ws"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              class="h-12 rounded-lg border border-border bg-background px-4 text-base text-foreground placeholder:text-muted-foreground"
            />
          </View>
          <View class="gap-2">
            <Text class="text-sm font-medium text-foreground">Token</Text>
            <Input
              testID="token"
              value={token()}
              readonly={active()}
              onChange={(value) => token.set(value)}
              placeholder="Enter your token"
              masked
              autoCapitalize="none"
              autoCorrect={false}
              class="h-12 rounded-lg border border-border bg-background px-4 text-base text-foreground placeholder:text-muted-foreground"
            />
          </View>
          <Button
            testID="connect"
            disabled={!canConnect()}
            onPress={() => {
              Keyboard.dismiss();
              connection.connect(address(), token());
            }}
            class="h-12 items-center justify-center rounded-lg bg-primary active:bg-primary/90 disabled:opacity-40"
          >
            <Text class="text-base font-semibold text-primary-foreground">
              {connection.state() === "connecting" ? "Connecting…" : connection.state() === "connected" ? "Connected" : "Connect"}
            </Text>
          </Button>
          <View class="gap-3">
            <View class="flex-row items-center gap-2">
              <View
                class="h-2 w-2 rounded-full"
                style={{ backgroundColor: connection.state() === "connected" ? "#22c55e" : connection.state() === "connecting" ? "#f59e0b" : connection.state() === "error" ? "#ef4444" : "#737373" }}
              />
              <Text testID="connection-status" class="text-sm text-foreground">{status()}</Text>
            </View>
            <If when={connection.error()}>
              <Text testID="connection-error" class="text-sm text-red-500">{connection.error()}</Text>
            </If>
            <If when={address().trim().length > 0 && !connectionUrl(address())}>
              <Text class="text-sm text-red-500">Enter a valid ws:// or wss:// address.</Text>
            </If>
            <If when={active()}>
              <Button
                testID="disconnect"
                onPress={() => connection.disconnect()}
                class="h-11 items-center justify-center rounded-lg border border-border active:opacity-60"
              >
                <Text class="text-sm font-medium text-foreground">
                  {connection.state() === "connecting" ? "Cancel" : "Disconnect"}
                </Text>
              </Button>
            </If>
          </View>
        </View>
      </View>
    </Scroll>
  );
}

mount(App);
