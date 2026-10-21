import { useState, useEffect, useMemo, useCallback } from "react";
import type { ACPClient } from "../acp/client";
import type { ModelPickerOption, ModelPickerState } from "../acp/types";

export interface UseModelsResult {
  /** Whether model selection is supported by the current agent */
  supportsModelSelection: boolean;
  /** List of available models */
  availableModels: ModelPickerOption[];
  /** The currently selected model ID */
  currentModelId: string | null;
  /** The currently selected model info */
  currentModel: ModelPickerOption | null;
  /** Set the model for the current session */
  setModel: (modelId: string) => Promise<void>;
  /** Whether a model change is in progress */
  isLoading: boolean;
}

/**
 * Hook to manage model selection state.
 *
 * ACP represents model selection as a session config option with category
 * "model", so this hook subscribes to config-option updates and derives a
 * model picker view from them (matching Zed's config-option-driven UI).
 */
export function useModels(client: ACPClient): UseModelsResult {
  const [modelState, setModelState] = useState<ModelPickerState | null>(
    client.modelState
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const sync = () => {
      setModelState(client.modelState);
      setIsLoading(false);
    };

    // Called immediately with the current state, then on every update.
    client.setConfigOptionsChangedHandler(sync);

    return () => {
      client.setConfigOptionsChangedHandler(() => {});
    };
  }, [client]);

  const availableModels = useMemo(
    () => modelState?.availableModels ?? [],
    [modelState]
  );

  const currentModelId = modelState?.currentModelId ?? null;

  const currentModel = useMemo(
    () =>
      availableModels.find((m) => m.modelId === currentModelId) ?? null,
    [availableModels, currentModelId]
  );

  const setModel = useCallback(
    async (modelId: string) => {
      if (!modelState) {
        throw new Error("Model selection not supported");
      }
      setIsLoading(true);
      try {
        await client.setSessionModel(modelId);
        // config_options_changed / config_option_update will settle the state.
      } catch (error) {
        setIsLoading(false);
        throw error;
      }
    },
    [client, modelState]
  );

  return {
    supportsModelSelection: modelState !== null && availableModels.length > 0,
    availableModels,
    currentModelId,
    currentModel,
    setModel,
    isLoading,
  };
}
