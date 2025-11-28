import { useState } from "react";
import { ACPConnect } from "@/components/ACPConnect";
import type { ACPClient } from "@/acp/client";
import "./index.css";

export function App() {
  const [client, setClient] = useState<ACPClient | null>(null);

  return (
    <div className="container mx-auto p-4 max-w-md">
      <h1 className="text-2xl font-bold mb-4">Chrome ACP</h1>
      <ACPConnect onClientReady={setClient} />
      {client && (
        <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 rounded text-sm">
          ✓ Connected to ACP agent. Ready to send messages.
        </div>
      )}
    </div>
  );
}

export default App;
