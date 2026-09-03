// FILE: LanguageSettingsPanel.tsx
// Purpose: Display-language picker — a select-style trigger opening a searchable list.
// Layer: Settings UI components
// Exports: LanguageSettingsPanel

import { getActiveLocale, getLocalePreference, setLocalePreference, t } from "@synara/i18n/runtime";
import {
  LOCALES,
  localeDisplayName,
  SYSTEM_LOCALE_PREFERENCE,
  type LocalePreference,
} from "@synara/i18n/locales";
import { useMemo, useState } from "react";

import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
  AutocompleteTrigger,
  useAutocompleteFilter,
} from "~/components/ui/autocomplete";
import { selectTriggerVariants } from "~/components/ui/select";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

type LanguageOption = {
  readonly value: LocalePreference;
  /** Endonym for a language, or the translated "System" label for auto-detect. */
  readonly label: string;
  /** The same language named in the interface's current language, when that differs. */
  readonly secondary: string | null;
  /** Extra text the search box matches on, so "chinese" and "zh" both find 简体中文. */
  readonly keywords: string;
};

export function LanguageSettingsPanel() {
  // Read once: changing the preference reloads the app, so neither can go stale.
  const [preference] = useState<LocalePreference>(() => getLocalePreference());
  const [query, setQuery] = useState("");
  const filter = useAutocompleteFilter({ sensitivity: "base" });

  const options = useMemo<readonly LanguageOption[]>(() => {
    const activeLocale = getActiveLocale();
    return [
      {
        value: SYSTEM_LOCALE_PREFERENCE,
        label: t("Auto-detect"),
        secondary: null,
        keywords: "system automatic auto detect",
      },
      ...LOCALES.map((locale) => ({
        value: locale.id,
        label: locale.nativeLabel,
        secondary: localeDisplayName(locale.id, activeLocale),
        keywords: `${locale.id} ${localeDisplayName(locale.id, "en") ?? ""}`,
      })),
    ];
  }, []);

  const matches = useMemo(
    () =>
      options.filter(
        (option) =>
          filter.contains(option.label, query) ||
          (option.secondary !== null && filter.contains(option.secondary, query)) ||
          filter.contains(option.keywords, query),
      ),
    [filter, options, query],
  );

  // Base UI drives its empty state and indexing off `items`; the repo's other
  // autocompletes pass plain strings, so pass the option values rather than the objects.
  const matchValues = useMemo(() => matches.map((option) => option.value), [matches]);
  const selected = options.find((option) => option.value === preference);

  return (
    <SettingsSection title="Language">
      <SettingsRow
        title="Display language"
        description="Language used across the Synara interface. Anything not translated yet stays in English. Changing this reloads the app."
        resetAction={
          preference !== SYSTEM_LOCALE_PREFERENCE ? (
            <SettingResetButton
              label="display language"
              onClick={() => setLocalePreference(SYSTEM_LOCALE_PREFERENCE)}
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center justify-end sm:w-auto">
            <Autocomplete
              items={matchValues}
              mode="none"
              value={query}
              onValueChange={setQuery}
              // The query is a search box, not the field's value: clearing it on close
              // means reopening always starts from the full list.
              onOpenChange={(open) => {
                if (!open) setQuery("");
              }}
            >
              <AutocompleteTrigger
                aria-label="Display language"
                className={cn(
                  selectTriggerVariants({ size: "sm", variant: "default" }),
                  "w-full sm:w-44",
                )}
              >
                <span className="flex-1 truncate text-left">{selected?.label ?? preference}</span>
                <ChevronDownIcon className="size-3 opacity-50" />
              </AutocompleteTrigger>

              <AutocompletePopup className="w-64 min-w-64">
                <div className="border-[color:var(--color-border-light)] border-b p-1.5">
                  <AutocompleteInput
                    size="sm"
                    variant="soft"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Search languages"
                    aria-label="Search languages"
                    startAddon={<SearchIcon />}
                  />
                </div>
                <AutocompleteList>
                  {matches.map((option, index) => (
                    <AutocompleteItem
                      key={option.value}
                      index={index}
                      value={option.value}
                      onClick={() => setLocalePreference(option.value)}
                    >
                      <span className="flex-1 truncate">{option.label}</span>
                      {option.secondary ? (
                        <span className="truncate text-muted-foreground">{option.secondary}</span>
                      ) : null}
                      {option.value === preference ? (
                        <CheckIcon className="size-3.5 shrink-0 opacity-70" />
                      ) : null}
                    </AutocompleteItem>
                  ))}
                  <AutocompleteEmpty>No matching languages.</AutocompleteEmpty>
                </AutocompleteList>
              </AutocompletePopup>
            </Autocomplete>
          </div>
        }
      />
    </SettingsSection>
  );
}
