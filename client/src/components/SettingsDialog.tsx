import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Dialog, DialogContent, Button, inputClasses, Badge, Tooltip } from "./ui/primitives";

type Settings = Record<string, number>;

const LABELS: Record<string, { label: string; hint: string }> = {
  maxIterations: { label: "Max iterations", hint: "Tool-call rounds per request (1–100)" },
  maxOutputTokens: { label: "Max output tokens", hint: "Output budget per model request — thinking models need 2048+ (256–65536)" },
  maxFileReadChars: { label: "Max file read chars", hint: "Truncation limit for read_file results (1000–500000)" },
  maxSearchResults: { label: "Max search results", hint: "Cap for search_files matches (1–200)" },
};

const ORDER = ["maxIterations", "maxOutputTokens", "maxFileReadChars", "maxSearchResults"];

/**
 * Settings dialog — edits the SQLite-backed agent config. Each setting has its
 * own reset button (restores the factory default); Save persists all.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [values, setValues] = useState<Settings>({});
  const [defaults, setDefaults] = useState<Settings>({});
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api
      .getSettings()
      .then((s) => {
        setValues(s.agent);
        setDefaults(s.defaults);
        setDirty(false);
      })
      .catch((err) => setError((err as Error).message));
  }, [open]);

  const setValue = (key: string, v: number) => {
    setValues((s) => ({ ...s, [key]: v }));
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateSettings(values);
      setValues(r.agent);
      setDefaults(r.defaults);
      setDirty(false);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Agent settings"
        description="Stored in SQLite (data/harness.db) — persists across restarts. Each setting can be reset to its factory default."
        className="w-[460px]"
      >
        <div className="space-y-1.5">
          {ORDER.map((key) => {
            const meta = LABELS[key] ?? { label: key, hint: "" };
            const isDefault = values[key] === defaults[key];
            return (
              <div
                key={key}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface-0/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-zinc-200">{meta.label}</span>
                    {!isDefault && <Badge tone="amber">modified</Badge>}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-snug text-ink-3">{meta.hint}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <input
                    type="number"
                    value={values[key] ?? ""}
                    onChange={(e) => setValue(key, Number(e.target.value))}
                    className={`${inputClasses} w-24 text-right font-mono`}
                  />
                  <Tooltip content="Reset to default">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={isDefault}
                      onClick={() => setValue(key, defaults[key])}
                      title="Reset to default"
                    >
                      ↺
                    </Button>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-2
            text-[11px] text-red-400">{error}</div>
        )}

        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="solid" size="sm" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
