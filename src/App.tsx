import { useState } from "react";
import { ACPConnect } from "@/components/ACPConnect";
import { ChatInterface } from "@/components/ChatInterface";
import type { ACPClient } from "@/acp/client";
import { ChevronDown, ChevronUp, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./index.css";

export function App() {
  const [client, setClient] = useState<ACPClient | null>(null);
  const [showSettings, setShowSettings] = useState(true);

  return (
    <div className="flex flex-col h-screen w-full max-w-2xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between p-4 border-b">
        <h1 className="text-xl font-bold">Chrome ACP</h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowSettings(!showSettings)}
        >
          <Settings className="w-4 h-4 mr-1" />
          {showSettings ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </header>

      {/* Settings Panel (collapsible) - keep mounted to preserve connection */}
      <div className={showSettings ? "p-4 border-b bg-muted/30" : "hidden"}>
        <ACPConnect onClientReady={(c) => {
          setClient(c);
          if (c) setShowSettings(false);
        }} />
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

export default App;
