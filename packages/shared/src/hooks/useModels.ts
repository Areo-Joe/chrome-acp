import { useState, useEffect, useMemo, useCallback } from "react";
import type { ACPClient } from "../acp/client";
import type { ModelInfo, SessionModelState } from "../acp/types";

export interface UseModelsResult {
  /** Whether model selection is supported by the current agent */
  supportsModelSelection: boolean;
  /** List of available models */
  availableModels: ModelInfo[];
  /** The currently selected model ID */
  currentModelId: string | null;
  /** The currently selected model info */
  currentModel: ModelInfo | null;
  /** Set the model for the current session */
  setModel: (modelId: string) => Promise<void>;
  /** Whether a model change is in progress */
  isLoading: boolean;
}

/**
 * Hook to manage model selection state.
 * Reference: Zed's AcpModelSelector reads from state.available_models and state.current_model_id
 */
export function useModels(client: ACPClient): UseModelsResult {
  const [modelState, setModelState] = useState<SessionModelState | null>(
    client.modelState
  );
  const [isLoading, setIsLoading] = useState(false);

  // Subscribe to model changes
  useEffect(() => {
    // Update state when model changes (from server or locally)
    const handleModelChanged = (modelId: string) => {
      setModelState((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          currentModelId: modelId,
        };
      });
      setIsLoading(false);
    };

    client.setModelChangedHandler(handleModelChanged);

    // Sync initial state
    setModelState(client.modelState);

    return () => {
      // Clear handler on unmount
      client.setModelChangedHandler(() => {});
    };
  }, [client]);

  // Sync model state when session is created
  useEffect(() => {
    const checkModelState = () => {
      const newState = client.modelState;
      if (newState !== modelState) {
        setModelState(newState);
      }
    };

    // Check periodically for session creation
    const interval = setInterval(checkModelState, 500);
    return () => clearInterval(interval);
  }, [client, modelState]);

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
        // The model_changed event will update the state
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

