import { Text, View } from "nsh";
import { Button, TextView } from "nsh/base";
import { authenticationKind } from "../acp/client";
import type { ComposerState } from "../state/composer";
import { Spinner } from "./Spinner";

export function Authentication(props: { state: ComposerState }) {
  const state = props.state;
  return (
    <View testID="authentication" class="flex-1 justify-end p-3">
      <View class="gap-3 rounded-xl border border-border bg-muted/30 p-4">
        <If when={state.phase() === "authenticating"} else={
          <>
            <Text class="text-base font-semibold text-foreground">Authenticate to {state.agentName()}</Text>
            <If when={state.authDescription() !== null}>
              <TextView testID="auth-description" selectable markdown={state.authDescription()!} class="text-sm text-muted-foreground" />
            </If>
            <If when={state.authDescription() === null && state.authMethods().length > 1}>
              <Text class="text-sm text-muted-foreground">Choose one of the following authentication options:</Text>
            </If>
            <View class="flex-row flex-wrap justify-end gap-2">
              <Each of={[...state.authMethods()].reverse()}>
                {(method) => (
                  <Button
                    testID={`auth-method-${method().id}`}
                    accessibilityLabel={method().name}
                    disabled={authenticationKind(method()) !== "agent"}
                    onPress={() => state.authenticate(method().id)}
                    class={method() === state.authMethods()[0]
                      ? "rounded-lg bg-primary px-3 py-2 disabled:opacity-30"
                      : "rounded-lg border border-border px-3 py-2 disabled:opacity-30"}
                  >
                    <Text class={method() === state.authMethods()[0] ? "text-sm text-primary-foreground" : "text-sm text-foreground"}>{method().name}</Text>
                    <If when={method().description}>
                      <Text class="text-xs text-muted-foreground">{method().description}</Text>
                    </If>
                  </Button>
                )}
              </Each>
            </View>
            <If when={state.authMethods().some((method) => authenticationKind(method) === "terminal")}>
              <Text testID="terminal-auth-unavailable" class="text-sm text-muted-foreground">Terminal sign-in is unavailable on this connection.</Text>
            </If>
          </>
        }>
          <View testID="auth-pending" class="flex-row items-center gap-2">
            <Spinner />
            <Text class="text-sm text-foreground">Authenticating to {state.agentName()}…</Text>
          </View>
        </If>
      </View>
    </View>
  );
}
