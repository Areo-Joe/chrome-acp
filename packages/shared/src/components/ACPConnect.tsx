import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { StatusDot } from "./ui/connection-status";
import { ThemeToggle } from "./ui/theme-toggle";
import { ACPClient, DEFAULT_SETTINGS } from "../acp";
import type { ACPSettings, ConnectionState, BrowserToolParams, BrowserToolResult } from "../acp";
import { ChevronDown, Lock, ScanLine, X } from "lucide-react";
import QrScanner from "qr-scanner";

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

/** QR code data format for scanning */
interface QRCodeData {
  url: string;
  token: string;
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
  /** Show QR code scan button (for mobile) */
  showScanButton?: boolean;
}

export function ACPConnect({
  onClientReady,
  expanded,
  onExpandedChange,
  browserToolHandler,
  showTokenInput = false,
  inferFromUrl = false,
  placeholder = "Proxy server URL",
  showScanButton = false,
}: ACPConnectProps) {
  const [settings, setSettings] = useState<ACPSettings>(() => loadSettings(inferFromUrl));
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [isShaking, setIsShaking] = useState(false);
  const [client, setClient] = useState<ACPClient | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasAutoCollapsedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const qrScannerRef = useRef<QrScanner | null>(null);
  const pendingAutoConnectRef = useRef(false);

  // Initialize client once on mount.
  // We intentionally use an empty dependency array because:
  // 1. The client is created with initial settings from loadSettings()
  // 2. Settings changes are handled by the separate useEffect that calls client.updateSettings()
  // 3. Re-creating the client on every settings change would disconnect/reconnect unnecessarily
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const acpClient = new ACPClient(settings);
    acpClient.setConnectionStateHandler((state, err) => {
      setConnectionState(state);
      setError(err || null);
    });

    setClient(acpClient);

    return () => {
      acpClient.disconnect();
    };
  }, []);

  // Register browser tool handler when it changes
  useEffect(() => {
    if (client && browserToolHandler) {
      client.setBrowserToolCallHandler(browserToolHandler);
    }
  }, [client, browserToolHandler]);

  // Update client settings when settings change, and auto-connect if pending
  useEffect(() => {
    if (client) {
      client.updateSettings(settings);
      saveSettings(settings);

      // Auto-connect after QR scan (when pendingAutoConnectRef is set)
      if (pendingAutoConnectRef.current) {
        pendingAutoConnectRef.current = false;
        client.connect().catch((e) => {
          setError((e as Error).message);
          setIsShaking(true);
          setTimeout(() => setIsShaking(false), 500);
          onExpandedChange(true);
        });
      }
    }
  }, [settings, client, onExpandedChange]);

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
    // Prevent duplicate connect calls if already connecting or connected
    if (!client || connectionState === "connecting" || connectionState === "connected") {
      return;
    }
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
  }, [client, connectionState, onExpandedChange]);

  const handleDisconnect = useCallback(() => {
    client?.disconnect();
  }, [client]);

  const updateSetting = <K extends keyof ACPSettings>(key: K, value: ACPSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // QR code scanning handlers
  const startScanning = useCallback(() => {
    setIsScanning(true);
    setError(null);
  }, []);

  // Actually start the scanner when video element is ready
  useEffect(() => {
    if (!isScanning || !videoRef.current) return;

    // Track if this effect has been cleaned up to handle async initialization race
    let isCancelled = false;
    let scanner: QrScanner | null = null;

    const initScanner = async () => {
      try {
        const newScanner = new QrScanner(
          videoRef.current!,
          (result) => {
            try {
              const data = JSON.parse(result.data) as QRCodeData;
              if (data.url && data.token) {
                // Stop scanning
                newScanner.stop();
                newScanner.destroy();
                qrScannerRef.current = null;
                setIsScanning(false);

                // Mark for auto-connect (will be triggered by settings useEffect)
                pendingAutoConnectRef.current = true;

                // Update settings - this will trigger auto-connect via useEffect
                setSettings((prev) => ({
                  ...prev,
                  proxyUrl: data.url,
                  token: data.token,
                }));
              }
            } catch {
              // Not valid JSON, ignore
            }
          },
          {
            returnDetailedScanResult: true,
            highlightScanRegion: true,
            highlightCodeOutline: true,
          }
        );

        // Check if effect was cancelled during async initialization
        if (isCancelled) {
          newScanner.destroy();
          return;
        }

        scanner = newScanner;
        qrScannerRef.current = newScanner;
        await newScanner.start();

        // Check again after start() in case it was cancelled during camera access
        if (isCancelled) {
          newScanner.stop();
          newScanner.destroy();
          qrScannerRef.current = null;
        }
      } catch (e) {
        // Only update state if not cancelled
        if (!isCancelled) {
          setError(`Camera error: ${(e as Error).message}`);
          setIsScanning(false);
        }
      }
    };

    initScanner();

    return () => {
      isCancelled = true;
      if (scanner) {
        scanner.stop();
        scanner.destroy();
      }
      // Also clean up via ref in case scanner was set after local var but before cleanup
      if (qrScannerRef.current) {
        qrScannerRef.current.stop();
        qrScannerRef.current.destroy();
        qrScannerRef.current = null;
      }
    };
  }, [isScanning]);

  const stopScanning = useCallback(() => {
    if (qrScannerRef.current) {
      qrScannerRef.current.stop();
      qrScannerRef.current.destroy();
      qrScannerRef.current = null;
    }
    setIsScanning(false);
  }, []);

  // Cleanup scanner on unmount
  useEffect(() => {
    return () => {
      if (qrScannerRef.current) {
        qrScannerRef.current.stop();
        qrScannerRef.current.destroy();
      }
    };
  }, []);

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
          {/* QR Scanner View - Full screen overlay */}
          {isScanning && (
            <div className="fixed inset-0 z-50 bg-black flex flex-col">
              <video
                ref={videoRef}
                className="flex-1 w-full object-cover"
              />
              <Button
                onClick={stopScanning}
                variant="ghost"
                size="sm"
                className="absolute top-4 right-4 h-10 w-10 p-0 bg-black/50 hover:bg-black/70 text-white rounded-full"
              >
                <X className="h-5 w-5" />
              </Button>
              <div className="absolute bottom-8 left-0 right-0 text-center text-sm text-white/80">
                Point camera at QR code
              </div>
            </div>
          )}

          {/* URL Input */}
          {!isScanning && (
            <div className="flex gap-2">
              {showScanButton && !isConnected && !isConnecting && (
                <Button
                  onClick={startScanning}
                  variant="outline"
                  size="sm"
                  className="h-9 px-3"
                  title="Scan QR code"
                >
                  <ScanLine className="h-4 w-4" />
                </Button>
              )}
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
          )}

          {/* Token Input (for remote access) - only shown if enabled and not scanning */}
          {showTokenInput && !isScanning && (
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
