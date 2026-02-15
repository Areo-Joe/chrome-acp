import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { StatusDot } from "./ui/connection-status";
import { ThemeToggle } from "./ui/theme-toggle";
import { ACPClient, DEFAULT_SETTINGS } from "../acp";
import type { ACPSettings, ConnectionState, BrowserToolParams, BrowserToolResult } from "../acp";
import { ChevronDown, Lock } from "lucide-react";

// Storage key for settings
const STORAGE_KEY = "acp_settings";

// Get token from URL query param (for pre-filled URLs from server)
function getTokenFromUrl(): string | undefined {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("token") || undefined;
  } catch {
    return undefined;
  }
}

// Infer WebSocket URL from current page URL (for pre-filled links from server)
// e.g., http://localhost:9315/app?token=xxx -> ws://localhost:9315/ws
function inferProxyUrlFromPage(): string | undefined {
  try {
    const url = new URL(window.location.href);
    // Only infer if we have a token param (indicates user came from server-printed URL)
    if (!url.searchParams.has("token")) {
      return undefined;
    }
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/ws`;
  } catch {
    return undefined;
  }
}

// Load settings from localStorage, with optional URL overrides
function loadSettings(inferFromUrl: boolean): ACPSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const settings = stored
      ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
      : { ...DEFAULT_SETTINGS };

    // Override from URL if enabled (for pre-filled links from server)
    if (inferFromUrl) {
      const urlToken = getTokenFromUrl();
      const inferredUrl = inferProxyUrlFromPage();

      if (urlToken) {
        settings.token = urlToken;
      }
      if (inferredUrl) {
        settings.proxyUrl = inferredUrl;
      }
    }

    return settings;
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return DEFAULT_SETTINGS;
}

// Save settings to localStorage
function saveSettings(settings: ACPSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export interface ACPConnectProps {
  onClientReady?: (client: ACPClient | null) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Handler for browser tool calls (only Chrome extension can execute these) */
  browserToolHandler?: (params: BrowserToolParams) => Promise<BrowserToolResult>;
  /** Show token input field (for remote access) */
  showTokenInput?: boolean;
  /** Infer proxy URL and token from page URL (for PWA) */
  inferFromUrl?: boolean;
  /** Placeholder for proxy URL input */
  placeholder?: string;
}

export function ACPConnect({
  onClientReady,
  expanded,
  onExpandedChange,
  browserToolHandler,
  showTokenInput = false,
  inferFromUrl = false,
  placeholder = "Proxy server URL",
}: ACPConnectProps) {
  const [settings, setSettings] = useState<ACPSettings>(() => loadSettings(inferFromUrl));
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [isShaking, setIsShaking] = useState(false);
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

    // Register browser tool handler if provided
    if (browserToolHandler) {
      acpClient.setBrowserToolCallHandler(browserToolHandler);
    }

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
    setIsShaking(false);
    try {
      await client.connect();
    } catch (e) {
      const errorMessage = (e as Error).message;
      setError(errorMessage);
      // Trigger shake animation
      setIsShaking(true);
      setTimeout(() => setIsShaking(false), 500);
      // Ensure panel is expanded to show error
      onExpandedChange(true);
    }
  }, [client, onExpandedChange]);

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
        <div ref={contentRef} className={`px-3 pb-3 pt-1 space-y-3 ${isShaking ? "animate-shake" : ""}`}>
          {/* URL Input */}
          <div className="flex gap-2">
            <Input
              value={settings.proxyUrl}
              onChange={(e) => updateSetting("proxyUrl", e.target.value)}
              placeholder={placeholder}
              disabled={isConnected || isConnecting}
              aria-invalid={!!error}
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

          {/* Token Input (for remote access) - only shown if enabled */}
          {showTokenInput && (
            <div className="flex gap-2 items-center">
              <Input
                value={settings.token || ""}
                onChange={(e) => updateSetting("token", e.target.value || undefined)}
                placeholder="Auth token (for remote access)"
                disabled={isConnected || isConnecting}
                type="password"
                aria-invalid={!!error}
                className="flex-1 h-9 text-sm font-mono"
              />
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {settings.token ? <Lock className="h-3.5 w-3.5" /> : "Optional"}
              </span>
            </div>
          )}

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
