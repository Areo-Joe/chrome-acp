import { useCallback, useEffect, useState } from "react";
import type { ACPClient } from "../acp/client";
import type {
  AvailableCommand,
  SessionConfigOption,
  SessionModeState,
  Usage,
  UsageUpdate,
} from "../acp/types";

export interface UseSessionConfigResult {
  /** Legacy session modes (only when the agent does not send config options). */
  modes: SessionModeState | null;
  /** Config options (mode/model/thought_level/... categories). */
  configOptions: SessionConfigOption[] | null;
  supportsModes: boolean;
  supportsConfigOptions: boolean;
  setMode: (modeId: string) => Promise<void>;
  setConfigOption: (configId: string, value: string | boolean) => Promise<void>;
}

/**
 * Session configuration state (modes + config options).
 *
 * Reference: Zed treats `configOptions` as taking precedence over legacy
 * `modes`; when config options are present, modes are ignored.
 */
export function useSessionConfig(client: ACPClient): UseSessionConfigResult {
  const [modes, setModes] = useState<SessionModeState | null>(client.sessionModes);
  const [configOptions, setConfigOptions] = useState<SessionConfigOption[] | null>(
    client.configOptions,
  );

  useEffect(() => {
    client.setSessionModesChangedHandler(setModes);
    client.setConfigOptionsChangedHandler(setConfigOptions);
    return () => {
      client.setSessionModesChangedHandler(() => {});
      client.setConfigOptionsChangedHandler(() => {});
    };
  }, [client]);

  const setMode = useCallback(
    async (modeId: string) => {
      await client.setSessionMode(modeId);
    },
    [client],
  );

  const setConfigOption = useCallback(
    async (configId: string, value: string | boolean) => {
      await client.setConfigOption(configId, value);
    },
    [client],
  );

  return {
    modes,
    configOptions,
    supportsModes: modes !== null && modes.availableModes.length > 0,
    supportsConfigOptions: configOptions !== null && configOptions.length > 0,
    setMode,
    setConfigOption,
  };
}

/** Current context usage and cost for the session. */
export function useUsage(client: ACPClient): UsageUpdate | null {
  const [usage, setUsage] = useState<UsageUpdate | null>(client.usage);

  useEffect(() => {
    client.setUsageChangedHandler(setUsage);
    return () => {
      client.setUsageChangedHandler(() => {});
    };
  }, [client]);

  return usage;
}

/** Token usage from the most recent prompt turn (`PromptResponse.usage`). */
export function useTurnUsage(client: ACPClient): Usage | null {
  const [usage, setUsage] = useState<Usage | null>(client.turnUsage);

  useEffect(() => {
    client.setTurnUsageChangedHandler(setUsage);
    return () => {
      client.setTurnUsageChangedHandler(() => {});
    };
  }, [client]);

  return usage;
}

/** Slash commands advertised by the agent. */
export function useAvailableCommands(client: ACPClient): AvailableCommand[] {
  const [commands, setCommands] = useState<AvailableCommand[]>(
    client.availableCommands,
  );

  useEffect(() => {
    client.setAvailableCommandsChangedHandler(setCommands);
    return () => {
      client.setAvailableCommandsChangedHandler(() => {});
    };
  }, [client]);

  return commands;
}
