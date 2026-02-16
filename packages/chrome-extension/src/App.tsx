import { useState } from "react";
import { ACPConnect } from "@/components/ACPConnect";
import { ChatInterface } from "@chrome-acp/shared/components";
import { ThemeProvider } from "@chrome-acp/shared/lib";
import type { ACPClient } from "@chrome-acp/shared/acp";
import "./index.css";

export function App() {
  const [client, setClient] = useState<ACPClient | null>(null);
  const [expanded, setExpanded] = useState(true);

  return (
    <ThemeProvider>
      <div className="flex flex-col h-dvh w-full max-w-2xl mx-auto">
        {/* Unified Connection Bar */}
        <ACPConnect
          onClientReady={setClient}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />

        {/* Main Content */}
        <main className="flex-1 overflow-hidden p-4">
          {client ? (
            <ChatInterface client={client} />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <p className="text-lg mb-2">No agent connected</p>
                <p className="text-sm">Click the status bar above to configure connection</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </ThemeProvider>
  );
}

export default App;
