import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { StatusDot } from "./ui/connection-status";
import { ThemeToggle } from "./ui/theme-toggle";
import { ACPClient, DEFAULT_SETTINGS } from "../acp";
import type { ACPSettings, ConnectionState } from "../acp";
import { ChevronDown } from "lucide-react";

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
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export function ACPConnect({ onClientReady, expanded, onExpandedChange }: ACPConnectProps) {
  const [settings, setSettings] = useState<ACPSettings>(loadSettings);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<ACPClient | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasAutoCollapsedRef = useRef(false);

  // Initialize client
  useEffect(() => {
    const acpClient = new ACPClient(settings);
    acpClient.setConnectionStateHandler((state, err) => {
      setConnectionState(state);
      setError(err || null);
    });

    // NOTE: PWA cannot execute browser tools - no browser tool handler registered
    // Browser tools require the Chrome extension to be installed

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

  // Notify parent when client is ready and auto-collapse on connect
  useEffect(() => {
    const isConnected = connectionState === "connected";
    onClientReady?.(isConnected ? client : null);

    // Auto-collapse when connected for the first time
    if (isConnected && !hasAutoCollapsedRef.current) {
      hasAutoCollapsedRef.current = true;
      onExpandedChange(false);
    }

    // Reset auto-collapse flag when disconnected
    if (connectionState === "disconnected") {
      hasAutoCollapsedRef.current = false;
    }
  }, [connectionState, client, onClientReady, onExpandedChange]);

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

  // Format URL for display
  const displayUrl = settings.proxyUrl.replace(/^wss?:\/\//, "").replace(/\/ws$/, "");

  // Get status label
  const statusLabels: Record<ConnectionState, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting...",
    connected: "Connected",
    error: "Error",
  };

  return (
    <div className="border-b bg-background/80 backdrop-blur-sm">
      {/* Status Bar - Always visible */}
      <button
        onClick={() => onExpandedChange(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <StatusDot state={connectionState} />
          <span className="text-sm font-medium">{statusLabels[connectionState]}</span>
          {isConnected && displayUrl && (
            <span className="text-xs text-muted-foreground">• {displayUrl}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <div onClick={(e) => e.stopPropagation()}>
            <ThemeToggle />
          </div>
          <ChevronDown
            className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      {/* Expandable Settings Panel */}
      <div
        className="overflow-hidden transition-all duration-200 ease-out"
        style={{
          maxHeight: expanded ? contentRef.current?.scrollHeight ?? 200 : 0,
          opacity: expanded ? 1 : 0,
        }}
      >
        <div ref={contentRef} className="px-3 pb-3 pt-1 space-y-3">
          {/* URL Input */}
          <div className="flex gap-2">
            <Input
              value={settings.proxyUrl}
              onChange={(e) => updateSetting("proxyUrl", e.target.value)}
              placeholder="ws://localhost:9315/ws"
              disabled={isConnected || isConnecting}
              className="flex-1 h-9 text-sm"
            />
            {!isConnected ? (
              <Button
                onClick={handleConnect}
                disabled={isConnecting}
                size="sm"
                className="h-9 px-4"
              >
                {isConnecting ? "..." : "Connect"}
              </Button>
            ) : (
              <Button
                onClick={handleDisconnect}
                variant="destructive"
                size="sm"
                className="h-9 px-4"
              >
                Disconnect
              </Button>
            )}
          </div>

          {/* Error Message */}
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 px-2 py-1.5 rounded">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

