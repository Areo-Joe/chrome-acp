import { useState, useMemo } from "react";
import { Check } from "lucide-react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "../ui/command";
import type { ModelInfo } from "../../acp/types";
import { cn } from "../../lib/utils";

interface ModelSelectorPickerProps {
  models: ModelInfo[];
  currentModelId: string | null;
  onSelect: (model: ModelInfo) => void;
}

/**
 * Fuzzy search implementation for model filtering.
 * Reference: Zed's fuzzy_search() in model_selector.rs
 */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  const lowerQuery = query.toLowerCase();
  const lowerText = text.toLowerCase();
  
  // Simple fuzzy match - check if all query chars appear in order
  let queryIdx = 0;
  for (let i = 0; i < lowerText.length && queryIdx < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIdx]) {
      queryIdx++;
    }
  }
  return queryIdx === lowerQuery.length;
}

/**
 * Model picker using cmdk Command component.
 * Reference: Zed's AcpModelPickerDelegate with fuzzy search support.
 */
export function ModelSelectorPicker({
  models,
  currentModelId,
  onSelect,
}: ModelSelectorPickerProps) {
  const [search, setSearch] = useState("");

  // Filter models using fuzzy search
  const filteredModels = useMemo(() => {
    if (!search) return models;
    return models.filter((model) => 
      fuzzyMatch(search, model.name) || 
      fuzzyMatch(search, model.modelId)
    );
  }, [models, search]);

  return (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder="Select a model…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>No models found.</CommandEmpty>
        <CommandGroup>
          {filteredModels.map((model) => (
            <CommandItem
              key={model.modelId}
              value={model.modelId}
              onSelect={() => onSelect(model)}
              className="flex items-center justify-between gap-2"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="truncate font-medium">{model.name}</span>
                {model.description && (
                  <span className="text-xs text-muted-foreground truncate">
                    {model.description}
                  </span>
                )}
              </div>
              <Check
                className={cn(
                  "h-4 w-4 shrink-0",
                  currentModelId === model.modelId ? "opacity-100" : "opacity-0"
                )}
              />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

