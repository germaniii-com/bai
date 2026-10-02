import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { ProviderInfo, RemoteModelInfo } from "@bai/shared";
import { Button, Checkbox, IconButton, Modal } from "./components";
import { mergeModelSelection, modelSelectionRows, stripProviderPrefix, toggleModelSelection } from "./provider-utils";

/**
 * Manage a custom provider's model list: the stored models as checkboxes,
 * a fetch icon button that re-lists the endpoint's own `GET /models`
 * (the key stays server-side — `provider` + `account` resolve the stored
 * credential), and Save/Cancel. Persistence stays with the caller so the
 * settings toast + refresh flow (`mutate`) applies.
 */
export function ManageModelsModal({
  client,
  provider,
  accountId,
  onSave,
  onClose,
}: {
  client: BaiClient;
  provider: ProviderInfo;
  /** Account whose stored key authorizes the refresh fetch. */
  accountId: string;
  /** Persist the selection (caller writes it via `mutate`). */
  onSave: (models: string[]) => void;
  onClose: () => void;
}) {
  const [models, setModels] = useState<string[]>(
    provider.models.map((m) => stripProviderPrefix(provider.id, m.id)),
  );
  const [available, setAvailable] = useState<RemoteModelInfo[] | null>(
    provider.models.map((m) => {
      const id = stripProviderPrefix(provider.id, m.id);
      return m.label !== undefined && m.label !== id && m.label !== m.id ? { id, name: m.label } : { id };
    }),
  );
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const baseUrl = provider.baseUrl;

  const fetchModels = (): void => {
    if (baseUrl === undefined) {
      setFetchError("No endpoint configured for this provider");
      return;
    }
    void (async () => {
      setFetching(true);
      setFetchError(null);
      try {
        const fetched = await client.listProviderModels({ baseUrl, provider: provider.id, account: accountId });
        setAvailable(fetched);
        // Every fetched model arrives pre-selected; earlier picks stay.
        setModels((prev) => mergeModelSelection(prev, fetched));
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      } finally {
        setFetching(false);
      }
    })();
  };

  const rows = available === null ? [] : modelSelectionRows(available, models);
  const selectedFetched = available === null ? 0 : available.filter((m) => models.includes(m.id)).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Models · ${provider.name}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(models)}>
            Save
          </Button>
        </>
      }
    >
      <div className="field">
        <div className="model-fetch-head">
          <IconButton label="Refresh models" hint="Refresh models" disabled={fetching || baseUrl === undefined} onClick={fetchModels}>
            <RefreshCw size={14} aria-hidden="true" />
          </IconButton>
          {available !== null && (
            <span className="dim">
              {selectedFetched} of {available.length} selected
            </span>
          )}
          {rows.length > 0 && (
            <span className="model-fetch-actions">
              <Button variant="ghost" size="sm" onClick={() => setModels(available?.map((m) => m.id) ?? [])}>
                Select all
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setModels([])}>
                Clear
              </Button>
            </span>
          )}
        </div>
        {rows.length > 0 && (
          <div className="checkbox-group model-fetch-list">
            {rows.map((m) => (
              <Checkbox
                key={m.id}
                label={m.name !== undefined ? `${m.id} · ${m.name}` : m.id}
                checked={models.includes(m.id)}
                onChange={(e) => setModels((prev) => toggleModelSelection(prev, m.id, e.target.checked))}
              />
            ))}
          </div>
        )}
        {available !== null && rows.length === 0 && <p className="dim">No models.</p>}
        {fetchError !== null && (
          <p className="error" role="alert">
            {fetchError}
          </p>
        )}
      </div>
    </Modal>
  );
}
