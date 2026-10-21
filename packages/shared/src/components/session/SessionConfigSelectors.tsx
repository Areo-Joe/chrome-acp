import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ACPClient } from "../../acp/client";
import { flattenConfigSelectOptions } from "../../acp/client";
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionModeState,
} from "../../acp/types";
import { useSessionConfig } from "../../hooks/useSessionConfig";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";

function configOptionLabel(option: SessionConfigOption): string {
  if (option.type === "boolean") {
    return `${option.name}: ${option.currentValue ? "On" : "Off"}`;
  }
  const choices = flattenConfigSelectOptions(option.options);
  const current = choices.find((choice) => choice.value === option.currentValue);
  return `${option.name}: ${current?.name ?? option.currentValue}`;
}

function ConfigOptionPopover({
  option,
  onChange,
}: {
  option: SessionConfigOption;
  onChange: (configId: string, value: string | boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  if (option.type === "boolean") {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        onClick={() => {
          onChange(option.id, !option.currentValue).catch((error) => {
            console.error("[SessionConfig] Failed to set option:", error);
          });
        }}
        title={option.description ?? undefined}
      >
        <span
          className={cn(
            "size-2 rounded-full",
            option.currentValue ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        <span className="max-w-40 truncate">{option.name}</span>
      </Button>
    );
  }

  const choices = flattenConfigSelectOptions(option.options);
  const firstChoice = option.options[0];
  const groups =
    firstChoice && "group" in firstChoice
      ? option.options.filter(
          (candidate): candidate is SessionConfigSelectGroup => "group" in candidate,
        )
      : null;

  const renderChoice = (choice: SessionConfigSelectOption) => {
    const selected = choice.value === option.currentValue;
    return (
      <button
        key={choice.value}
        type="button"
        className={cn(
          "flex w-full flex-col rounded-sm px-2 py-1.5 text-left hover:bg-accent",
          selected && "bg-accent/60",
        )}
        onClick={() => {
          setOpen(false);
          onChange(option.id, choice.value).catch((error) => {
            console.error("[SessionConfig] Failed to set option:", error);
          });
        }}
      >
        <span className="flex items-center gap-2">
          <span className="flex-1 truncate text-sm">{choice.name}</span>
          {selected && <Check className="size-3.5 shrink-0" />}
        </span>
        {choice.description && (
          <span className="truncate text-[11px] text-muted-foreground">
            {choice.description}
          </span>
        )}
      </button>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          title={option.description ?? undefined}
        >
          <span className="max-w-40 truncate">{configOptionLabel(option)}</span>
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {option.name}
        </div>
        <div className="max-h-64 overflow-y-auto">
          {groups
            ? groups.map((group) => (
                <div key={group.group} className="mb-1">
                  <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    {group.name}
                  </div>
                  {group.options.map(renderChoice)}
                </div>
              ))
            : choices.map(renderChoice)}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ModePopover({
  modes,
  onChange,
}: {
  modes: SessionModeState;
  onChange: (modeId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const current = modes.availableModes.find(
    (mode) => mode.id === modes.currentModeId,
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          title={current?.description ?? undefined}
        >
          <span className="max-w-40 truncate">{current?.name ?? "Mode"}</span>
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        {modes.availableModes.map((mode) => {
          const selected = mode.id === modes.currentModeId;
          return (
            <button
              key={mode.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                selected && "bg-accent/60",
              )}
              onClick={() => {
                setOpen(false);
                onChange(mode.id).catch((error) => {
                  console.error("[SessionConfig] Failed to set mode:", error);
                });
              }}
            >
              <span className="flex-1 truncate">{mode.name}</span>
              {selected && <Check className="size-3.5 shrink-0" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Session config selectors shown in the prompt footer.
 *
 * Reference: Zed's `ConfigOptionsView`. Config options take precedence over
 * legacy session modes. Options with category "model" are rendered by the
 * model picker instead.
 */
export function SessionConfigSelectors({ client }: { client: ACPClient }) {
  const {
    modes,
    configOptions,
    supportsModes,
    supportsConfigOptions,
    setMode,
    setConfigOption,
  } = useSessionConfig(client);

  if (supportsConfigOptions && configOptions) {
    return (
      <>
        {configOptions
          .filter((option) => option.category !== "model")
          .map((option) => (
            <ConfigOptionPopover
              key={option.id}
              option={option}
              onChange={setConfigOption}
            />
          ))}
      </>
    );
  }

  if (supportsModes && modes) {
    return <ModePopover modes={modes} onChange={setMode} />;
  }

  return null;
}
