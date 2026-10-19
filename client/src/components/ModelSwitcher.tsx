import { useState } from "react";
import { useChatStore } from "../stores/chat";
import { api } from "../lib/api";
import {
  Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel,
  Dialog, DialogTrigger, DialogContent, Field, inputClasses, Button, Tooltip,
} from "./ui/primitives";
import type { ProviderInfo } from "../types/agent";

function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-60">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Form to add a custom OpenAI-compatible endpoint (local LAN Ollama, cloud APIs…). */
function AddProviderForm({ onDone }: { onDone: () => void }) {
  const addProvider = useChatStore((s) => s.addProvider);
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!baseURL.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addProvider(name, baseURL.trim(), apiKey.trim());
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Field label="Display name (optional)">
        <input className={inputClasses} placeholder="My PC Ollama / OpenRouter / …"
          value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Base URL (OpenAI-compatible, ends with /v1)">
        <input className={inputClasses} placeholder="http://192.168.1.20:11434/v1"
          value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      </Field>
      <Field label="API key (optional — for cloud providers)">
        <input className={inputClasses} type="password" placeholder="sk-…"
          value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      {error && (
        <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-2
          text-[11px] leading-relaxed text-red-400">{error}</div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
        <Button variant="solid" size="sm" disabled={!baseURL.trim() || busy} onClick={() => void submit()}>
          {busy ? "Verifying…" : "Add endpoint"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Edit a provider's endpoint (e.g. the local server moved to a different
 * port). Persisted to SQLite; built-in providers can also be reset to their
 * factory URL.
 */
function EditProviderForm({ provider, onDone }: { provider: ProviderInfo; onDone: () => void }) {
  const refreshProviders = useChatStore((s) => s.refreshProviders);
  const [baseURL, setBaseURL] = useState(provider.baseURL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasDefault = Boolean(provider.factoryBaseURL);
  const isDefaultURL = provider.factoryBaseURL != null && baseURL === provider.factoryBaseURL;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateProvider(provider.id, { baseURL: baseURL.trim() });
      await refreshProviders();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resetProvider(provider.id);
      await refreshProviders();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Field label={`Base URL for "${provider.name}"`}>
        <input className={`${inputClasses} font-mono`} placeholder="http://127.0.0.1:11434/v1"
          value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
      </Field>
      {hasDefault && (
        <div className="mb-3 text-[10px] text-ink-3">
          Factory default: <span className="font-mono">{provider.factoryBaseURL}</span>
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-2
          text-[11px] leading-relaxed text-red-400">{error}</div>
      )}
      <div className="flex items-center justify-between gap-2">
        {hasDefault ? (
          <Button variant="ghost" size="sm" disabled={busy || isDefaultURL} onClick={() => void reset()} title="Restore the factory URL">
            ↺ Reset
          </Button>
        ) : <span />}
        <span className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
          <Button variant="solid" size="sm" disabled={busy || !baseURL.trim() || baseURL.trim() === provider.baseURL} onClick={() => void save()}>
            {busy ? "Verifying…" : "Save"}
          </Button>
        </span>
      </div>
    </div>
  );
}

/**
 * Single model switcher dropdown: models grouped by provider, plus
 * add/remove custom endpoints.
 */
export function ModelSwitcher() {
  const { providers, providerId, model, setProvider, setModel, removeProvider } = useChatStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const current = providers.find((p) => p.id === providerId);

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <Dropdown>
        <DropdownTrigger asChild>
          <button
            className="flex h-7 min-w-0 items-center justify-between gap-1.5 rounded-md
              border border-line bg-surface-0 px-2 text-[11px] text-ink-2 outline-none
              transition-colors hover:border-zinc-600 hover:text-zinc-200"
            title={`${current?.name ?? "Provider"} — ${model || "no model"}`}
          >
            <span className="max-w-[190px] truncate font-mono">{model || "Select model"}</span>
            <ChevronDown />
          </button>
        </DropdownTrigger>
        <DropdownContent align="end" >
          <div className="max-h-[320px] overflow-y-auto">
            {providers.map((p) => (
              <div key={p.id}>
                <DropdownLabel>
                  <span className="flex items-center justify-between">
                    <span className="truncate">{p.name}</span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      <Tooltip content="Change endpoint URL / port">
                        <button
                          className="rounded px-1 text-[10px] text-ink-3 hover:text-sky-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(p);
                          }}
                        >
                          edit
                        </button>
                      </Tooltip>
                      {p.id.startsWith("custom_") && (
                        <Tooltip content="Remove this endpoint">
                          <button
                            className="rounded px-1 text-[10px] text-ink-3 hover:text-red-400"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeProvider(p.id);
                            }}
                          >
                            remove
                          </button>
                        </Tooltip>
                      )}
                    </span>
                  </span>
                </DropdownLabel>
                {p.models.map((m) => (
                  <DropdownItem
                    key={m}
                    selected={p.id === providerId && m === model}
                    onSelect={() => {
                      setProvider(p.id);
                      setModel(m);
                    }}
                  >
                    <span className="truncate font-mono">{m}</span>
                    {p.id === providerId && m === model && <span className="text-[10px]">●</span>}
                  </DropdownItem>
                ))}
                {p.models.length === 0 && (
                  <DropdownItem disabled>no models found</DropdownItem>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 border-t border-line pt-1">
            <DialogTrigger asChild>
              <DropdownItem onSelect={(e) => { e.preventDefault(); }}>
                <span>＋ Add custom endpoint…</span>
                <span className="text-[10px] text-ink-3">cloud / LAN</span>
              </DropdownItem>
            </DialogTrigger>
          </div>
        </DropdownContent>
      </Dropdown>

      <DialogContent
        title="Add custom endpoint"
        description="Any OpenAI-compatible server works — Ollama/FreeToken on another PC (LAN) or cloud APIs (OpenRouter, Together, vLLM…). The endpoint is verified before saving."
      >
        <AddProviderForm onDone={() => setDialogOpen(false)} />
      </DialogContent>

      <Dialog open={Boolean(editing)} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent
          title="Edit endpoint"
          description="Saved to SQLite (data/harness.db) — the harness keeps using the new URL across restarts."
        >
          {editing && <EditProviderForm provider={editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
