import { useState, useRef, useCallback } from "react";
import { ACPConnect } from "@/components/ACPConnect";
import { ChatInterface } from "@chrome-acp/shared/components";
import type { ACPClient, ConnectionState } from "@chrome-acp/shared/acp";
import { Settings } from "lucide-react";
import "./index.css";

export function App() {
  const [client, setClient] = useState<ACPClient | null>(null);
  const [showSettings, setShowSettings] = useState(true);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [proxyUrl, setProxyUrl] = useState("");
  const hasAutoHiddenRef = useRef(false);

  const handleClientReady = (c: ACPClient | null) => {
    const wasConnected = client !== null;
    const isNowConnected = c !== null;

    setClient(c);

    if (!wasConnected && isNowConnected && !hasAutoHiddenRef.current) {
      hasAutoHiddenRef.current = true;
      setShowSettings(false);
    }

    if (!isNowConnected) {
      hasAutoHiddenRef.current = false;
    }
  };

  const handleConnectionStateChange = useCallback((state: ConnectionState, url: string) => {
    setConnectionState(state);
    setProxyUrl(url);
  }, []);

  // Format URL for display
  const displayUrl = proxyUrl.replace(/^wss?:\/\//, "").replace(/\/ws$/, "");

  return (
    <div className="flex flex-col h-screen w-full max-w-2xl mx-auto">
      {/* Modern Status Bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-background/80 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <StatusDot state={connectionState} />
          <span className="text-sm font-medium">
            {connectionState === "connected" ? "Connected" :
             connectionState === "connecting" ? "Connecting..." :
             connectionState === "error" ? "Error" : "Disconnected"}
          </span>
          {connectionState === "connected" && displayUrl && (
            <span className="text-xs text-muted-foreground truncate max-w-[150px]">
              {displayUrl}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="p-1.5 rounded-md hover:bg-muted transition-colors"
        >
          <Settings className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Settings Panel (collapsible) */}
      <div className={`overflow-hidden transition-all duration-200 ${showSettings ? "border-b" : ""}`}>
        <div className={`p-4 bg-muted/30 ${showSettings ? "" : "hidden"}`}>
          <ACPConnect
            onClientReady={handleClientReady}
            onConnectionStateChange={handleConnectionStateChange}
          />
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden p-4">
        {client ? (
          <ChatInterface client={client} />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center">
              <p className="text-lg mb-2">No agent connected</p>
              <p className="text-sm">Configure and connect to an ACP agent above</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatusDot({ state }: { state: ConnectionState }) {
  const styles: Record<ConnectionState, string> = {
    disconnected: "bg-gray-400",
    connecting: "bg-yellow-400 animate-pulse",
    connected: "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]",
    error: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]",
  };

  return (
    <span className={`w-2 h-2 rounded-full ${styles[state]}`} />
  );
}

export default App;
