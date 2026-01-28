import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ACPClient } from "@/acp/client";
import type { ACPSettings, ConnectionState } from "@/acp/types";
import { DEFAULT_SETTINGS } from "@/acp/types";
import { executeBrowserTool } from "@/tools/browser";

// Storage key for settings
const STORAGE_KEY = "acp_settings";

// Load settings from localStorage
function loadSettings(): ACPSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return DEFAULT_SETTINGS;
}

// Save settings to localStorage
function saveSettings(settings: ACPSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

interface ACPConnectProps {
  onClientReady?: (client: ACPClient | null) => void;
  onConnectionStateChange?: (state: ConnectionState, proxyUrl: string) => void;
}

export function ACPConnect({ onClientReady, onConnectionStateChange }: ACPConnectProps) {
  const [settings, setSettings] = useState<ACPSettings>(loadSettings);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<ACPClient | null>(null);

  // Initialize client
  useEffect(() => {
    const acpClient = new ACPClient(settings);
    acpClient.setConnectionStateHandler((state, err) => {
      setConnectionState(state);
      setError(err || null);
    });

    // Register browser tool handler
    acpClient.setBrowserToolCallHandler(async (_callId, params) => {
      console.log("[ACPConnect] Executing browser tool:", params);
      return await executeBrowserTool(params);
    });

    setClient(acpClient);

    return () => {
      acpClient.disconnect();
    };
  }, []);

  // Update client settings when settings change
  useEffect(() => {
    if (client) {
      client.updateSettings(settings);
      saveSettings(settings);
    }
  }, [settings, client]);

  // Notify parent when client is ready
  useEffect(() => {
    onClientReady?.(connectionState === "connected" ? client : null);
  }, [connectionState, client, onClientReady]);

  // Notify parent of connection state changes
  useEffect(() => {
    onConnectionStateChange?.(connectionState, settings.proxyUrl);
  }, [connectionState, settings.proxyUrl, onConnectionStateChange]);

  const handleConnect = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      await client.connect();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client]);

  const handleDisconnect = useCallback(() => {
    client?.disconnect();
  }, [client]);

  const updateSetting = <K extends keyof ACPSettings>(key: K, value: ACPSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>ACP Connection</span>
          <StatusIndicator state={connectionState} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="proxyUrl">Proxy URL</Label>
          <Input
            id="proxyUrl"
            value={settings.proxyUrl}
            onChange={(e) => updateSetting("proxyUrl", e.target.value)}
            placeholder="ws://localhost:9315/ws"
            disabled={isConnected || isConnecting}
          />
        </div>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          {!isConnected ? (
            <Button
              onClick={handleConnect}
              disabled={isConnecting}
              className="flex-1"
            >
              {isConnecting ? "Connecting..." : "Connect"}
            </Button>
          ) : (
            <Button onClick={handleDisconnect} variant="destructive" className="flex-1">
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusIndicator({ state }: { state: ConnectionState }) {
  const colors: Record<ConnectionState, string> = {
    disconnected: "bg-gray-400",
    connecting: "bg-yellow-400 animate-pulse",
    connected: "bg-green-500",
    error: "bg-red-500",
  };

  return (
    <span className="flex items-center gap-2 text-sm font-normal">
      <span className={`w-2 h-2 rounded-full ${colors[state]}`} />
      {state}
    </span>
  );
}

