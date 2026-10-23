import { cleanup, effect, mount } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";
import { ChatPage } from "./pages/ChatPage";
import { ConnectPage } from "./pages/ConnectPage";
import { createConnection } from "./state/connection";

type Route = "connect" | "chat";

function App() {
  const connection = createConnection();
  const nav = createNavStack<Route>(["connect"]);
  effect(() => {
    nav.setRoutes(connection.state() === "connected" ? ["connect", "chat"] : ["connect"]);
  });
  cleanup(() => connection.disconnect());

  return (
    <NavStack state={nav} class="flex-1">
      {(route) => (
        <NavPage
          class="flex-1"
          headerVisible={false}
          popOnBack={route === "connect"}
          onBackPress={() => { if (route === "chat") connection.disconnect(); }}
        >
          {route === "connect"
            ? <ConnectPage connection={connection} />
            : <ChatPage connection={connection} />}
        </NavPage>
      )}
    </NavStack>
  );
}

mount(App);
