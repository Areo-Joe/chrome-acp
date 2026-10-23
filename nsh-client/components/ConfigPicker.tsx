import { Input, signal, Text, View } from "nsh";
import { Keyboard, Menu, MenuItem } from "nsh/base";
import type { Choice } from "../state/composer";
import { Icon } from "./Icon";

type Props = {
  id: string;
  name: string;
  description?: string | null;
  value: string | boolean;
  choices: Choice[];
  disabled: boolean;
  busy: boolean;
  onSelect: (value: string | boolean) => void;
};

export function ConfigPicker(props: Props) {
  const search = signal("");
  const current = () => props.choices.find((choice) => choice.value === props.value)?.name ?? String(props.value);
  const filtered = () => props.choices.filter((choice) =>
    `${choice.name} ${choice.description ?? ""} ${choice.group ?? ""}`.toLowerCase().includes(search().toLowerCase()));

  return (
    <Menu
      popupClass="rounded-xl border border-border bg-background p-2"
      backdropClass="bg-black/40"
      onOpenChange={(open) => { search.set(""); if (open) Keyboard.dismiss(); }}
      trigger={
        <View
          role="button"
          testID={`config-${props.id}`}
          disabled={props.disabled}
          accessibilityLabel={`${props.name}: ${current()}`}
          class="h-9 flex-row items-center justify-center gap-2 rounded-lg border border-border px-3 disabled:opacity-40"
        >
          <Text numberOfLines={1} class="text-xs font-medium text-foreground" style={{ lineHeight: 16 }}>{props.busy ? "Updating…" : current()}</Text>
          <Icon name="chevron-down" size={14} />
        </View>
      }
    >
      <View class="gap-1 px-3 py-2">
        <Text class="text-base font-semibold text-foreground">{props.name}</Text>
        <If when={props.description}>
          <Text class="text-xs text-muted-foreground">{props.description}</Text>
        </If>
      </View>
      <If when={props.choices.length > 5}>
        <Input
          testID={`search-${props.id}`}
          placeholder="Search options…"
          value={search()}
          onChange={(value) => search.set(value)}
          autoCorrect={false}
          autoCapitalize="none"
          class="mx-2 mb-2 h-10 rounded-lg border border-border px-3 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </If>
      <Each of={filtered()}>
        {(choice) => (
          <MenuItem
            testID={`choice-${props.id}-${choice().value}`}
            disabled={props.disabled}
            onSelect={() => props.onSelect(choice().value)}
            class="gap-1 rounded-lg px-3 py-3 active:bg-muted"
          >
            <Text class="text-sm text-foreground">
              {choice().value === props.value ? "✓ " : ""}{choice().name}
            </Text>
            <If when={choice().group || choice().description}>
              <Text class="text-xs text-muted-foreground">{choice().group ?? choice().description}</Text>
            </If>
          </MenuItem>
        )}
      </Each>
      <If when={filtered().length === 0}>
        <Text class="px-3 py-3 text-sm text-muted-foreground">No matching options</Text>
      </If>
    </Menu>
  );
}
