import { Keyboard, signal, Text, View } from "nsh";
import { Input, Menu, MenuItem } from "nsh/base";
import type { Choice } from "../state/composer";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

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

type Row = { choice: Choice } | { group: string; first: boolean; before: Choice["value"] };

export function ConfigPicker(props: Props) {
  const search = signal("");
  const current = () => props.choices.find((choice) => choice.value === props.value)?.name ?? String(props.value);
  const filtered = () => props.choices.filter((choice) =>
    `${choice.name} ${choice.description ?? ""} ${choice.group ?? ""}`.toLowerCase().includes(search().toLowerCase()));
  const rows = () => filtered().flatMap((choice, index, list): Row[] =>
    choice.group && choice.group !== list[index - 1]?.group
      ? [{ group: choice.group, first: index === 0, before: choice.value }, { choice }]
      : [{ choice }]);

  return (
    <Menu
      popupClass="max-w-80 rounded-xl border border-border bg-background p-2"
      backdropClass="bg-black/40"
      onOpenChange={({ open }) => { search.set(""); if (open) Keyboard.dismiss(); }}
      trigger={
        <View
          role="button"
          testID={`config-${props.id}`}
          disabled={props.disabled}
          accessibilityLabel={`${props.name}: ${current()}`}
          class="h-9 flex-row items-center justify-center gap-2 rounded-lg border border-border px-3"
        >
          <Text class="text-xs font-medium text-foreground" style={{ numberOfLines: 1, lineHeight: 16 }}>{current()}</Text>
          <If when={props.busy}>
            <Spinner testID={`config-loading-${props.id}`} />
          </If>
          <If when={!props.busy}><Icon name="chevron-down" size={14} /></If>
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
          onChange={({ value }) => search.set(value)}
          autoCorrect={false}
          autoCapitalize="none"
          class="mx-2 mb-2 h-10 rounded-lg border border-border px-3 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </If>
      <Each of={rows()} key={(row) => "choice" in row ? `choice:${row.choice.value}` : `group:${row.before}`}>
        {(row) => {
          const initial = row();
          if (!("choice" in initial)) {
            const group = () => row() as Extract<Row, { group: string }>;
            return (
              <Text class={`px-3 pb-1 text-xs text-muted-foreground ${group().first ? "pt-1" : "mt-1 border-t border-border pt-3"}`}>
                {group().group}
              </Text>
            );
          }
          const choice = () => (row() as Extract<Row, { choice: Choice }>).choice;
          return (
            <MenuItem
              testID={`choice-${props.id}-${choice().value}`}
              disabled={props.disabled}
              accessibilityLabel={[choice().name, choice().description, choice().value === props.value && "selected"]
                .filter(Boolean).join(", ")}
              onSelect={() => props.onSelect(choice().value)}
              class="flex-row items-center gap-3 rounded-lg px-3 py-3 active:bg-muted"
            >
              <View class="shrink grow gap-1">
                <Text class="text-sm text-foreground">{choice().name}</Text>
                <If when={choice().description}>
                  <Text class="text-xs text-muted-foreground">{choice().description}</Text>
                </If>
              </View>
              <View class="w-4 items-center">
                <If when={choice().value === props.value}>
                  <Icon name="check" size={16} tone="foreground" />
                </If>
              </View>
            </MenuItem>
          );
        }}
      </Each>
      <If when={filtered().length === 0}>
        <Text class="px-3 py-3 text-sm text-muted-foreground">No matching options</Text>
      </If>
    </Menu>
  );
}
