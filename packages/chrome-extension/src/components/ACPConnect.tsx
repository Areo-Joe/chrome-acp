// Re-export from shared with browser tool handler configured
import { ACPConnect as SharedACPConnect, type ACPConnectProps as SharedACPConnectProps } from "@chrome-acp/shared/components";
import { executeBrowserTool } from "@/tools/browser";
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
      browserToolHandler={executeBrowserTool}
      showTokenInput
    />
  );
}
