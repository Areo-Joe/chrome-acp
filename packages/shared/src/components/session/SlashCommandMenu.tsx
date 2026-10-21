import type { AvailableCommand } from "../../acp/types";
import { usePromptInputController } from "../ai-elements/prompt-input";

/**
 * Slash-command suggestions for commands advertised by the agent.
 *
 * Reference: Zed's command completion in the message editor. Commands are
 * plain prompt text; selecting one inserts `/<name> ` into the editor.
 */
export function SlashCommandMenu({
  commands,
}: {
  commands: AvailableCommand[];
}) {
  const controller = usePromptInputController();
  const text = controller.textInput.value;

  if (!text.startsWith("/")) return null;
  // Only suggest while typing the command name, not its arguments.
  if (/\s/.test(text)) return null;

  const query = text.slice(1).toLowerCase();
  const matches = commands
    .filter((command) => command.name.toLowerCase().startsWith(query))
    .slice(0, 8);

  if (matches.length === 0) return null;

  return (
    <div className="mb-1 w-full overflow-hidden rounded-md border bg-popover p-1 shadow-sm">
      {matches.map((command) => (
        <button
          key={command.name}
          type="button"
          className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
          onMouseDown={(event) => {
            // Keep focus in the textarea.
            event.preventDefault();
            controller.textInput.setInput(`/${command.name} `);
          }}
        >
          <span className="font-mono text-xs">/{command.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {command.description}
          </span>
          {command.input?.hint && (
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
              {command.input.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
