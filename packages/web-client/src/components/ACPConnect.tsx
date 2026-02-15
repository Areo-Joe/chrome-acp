// Re-export from shared with PWA-specific configuration
import { ACPConnect as SharedACPConnect } from "@chrome-acp/shared/components";
import type { ACPClient } from "@chrome-acp/shared/acp";

interface ACPConnectProps {
  onClientReady?: (client: ACPClient | null) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export function ACPConnect({ onClientReady, expanded, onExpandedChange }: ACPConnectProps) {
  return (
    <SharedACPConnect
      onClientReady={onClientReady}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      showTokenInput
      inferFromUrl
      showScanButton
    />
  );
}
