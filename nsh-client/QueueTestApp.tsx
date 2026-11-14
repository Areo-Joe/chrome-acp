// Test-only entry at the application root so native SVG assets use the same
// resource base as App.tsx. The production entry never imports this module.
import { cleanup, host, mount, signal, Text, View } from "nsh";
import { ChatPage } from "./pages/ChatPage";
import { ConnectPage } from "./pages/ConnectPage";
import { createConnection } from "./state/connection";
function App() {
  const connection = createConnection();
  const result = signal<unknown>(null);
  cleanup(host.on("queue-control-clear", () => result.set(null)));
  cleanup(() => connection.disconnect());
  cleanup(host.on("queue-control", payload => {
    const request = payload as { request: number; token: string; reason?: string; id: string };
    const base = String(host.params.queueMockUrl);
    const url = `${base}/__queue?token=${encodeURIComponent(request.token)}&id=${encodeURIComponent(request.id)}${request.reason ? `&action=finish&reason=${request.reason}` : ""}`;
    void fetch(url).then(async response => {
      if (!response.ok) throw new Error(`Mock control: ${response.status}`);
      return response.json();
    }).then(data => result.set({ request: request.request, data }))
      .catch(error => result.set({ request: request.request, error: String(error) }));
  }));
  return <View class="flex-1"><If when={connection.state() === "connected"} else={<ConnectPage connection={connection} />}>
    <ChatPage connection={connection} />
  </If><If when={result() !== null}><Text class="text-xs">{`QUEUE_CONTROL:${JSON.stringify(result())}`}</Text></If></View>;
}
mount(App);
