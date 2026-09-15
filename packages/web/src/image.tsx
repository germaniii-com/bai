import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  Download,
  LoaderCircle,
  MoreVertical,
  RotateCcw,
  SlidersHorizontal,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { eventMux, type BaiClient } from "@bai/api/client";
import {
  formatCost,
  fuzzyTagScore,
  modelsForWorkflow,
  readMediaGen,
  type Asset,
  type AttachmentRef,
  type Job,
  type MediaCapabilitiesResponse,
  type MediaGenConfig,
  type MediaModelInfo,
  type MediaMode,
  type MediaParamSpec,
  type MediaParamValue,
  type MediaTagCount,
} from "@bai/shared";
import {
  Button,
  Combobox,
  Field,
  Modal,
  SectionHeader,
  Select,
  TagInput,
  Textarea,
  TextInput,
  ToggleRow,
} from "./components";
import { ImageLightbox, useAssetUrl } from "./attachments";
import { useImageGallery } from "./use-image-gallery";

type OnNotice = (message: string, kind?: "success" | "error" | "info") => void;

/**
 * Reference-image formats. `accept` lists explicit MIME types (no `image/*`
 * wildcard): Safari's upload panel matches literal types more reliably and a
 * wildcard can leave its button disabled. `isReferenceImage` still validates
 * after the pick, and the formats are shown in the UI hint.
 */
const REFERENCE_LABEL = "PNG, JPG, GIF, WebP";
const REFERENCE_ACCEPT = "image/jpeg,image/gif,image/webp,image/png";
const REFERENCE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const REFERENCE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const REFERENCE_MAX_BYTES = 10 * 1024 * 1024;

/** Whether a picked/dropped file is an accepted reference image. */
function isReferenceImage(file: File): boolean {
  if (REFERENCE_MIMES.has(file.type.toLowerCase())) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return REFERENCE_EXTS.has(ext);
}

/**
 * The single-page image generation workbench: a workflow selector + params
 * on the left and a fuzzy tag-filtered gallery below (the gallery IS the
 * output — no duplicate batch view). Clicking a gallery image opens the
 * expanded modal; its `…` menu offers Download / Load Inputs / Delete.
 * Loading a recipe never mutates history; Generate always enqueues a NEW job.
 * Assets are self-describing — the request rides `meta.gen`.
 */
export function ImagePane({
  client,
  imageGen,
  onNotice,
}: {
  client: BaiClient;
  imageGen?: MediaGenConfig;
  onNotice: OnNotice;
}) {
  const [provider, setProvider] = useState(imageGen?.provider ?? "");
  const [model, setModel] = useState(imageGen?.model ?? "");
  const [caps, setCaps] = useState<MediaCapabilitiesResponse | null>(null);
  const [workflow, setWorkflow] = useState<MediaMode>("t2i");
  const [prompt, setPrompt] = useState("");
  const [params, setParams] = useState<Record<string, MediaParamValue>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<MediaTagCount[]>([]);
  const [reference, setReference] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [galleryQuery, setGalleryQuery] = useState("");
  const [galleryApplied, setGalleryApplied] = useState("");
  const [lightbox, setLightbox] = useState<Asset | null>(null);
  const [editingTags, setEditingTags] = useState<Asset | null>(null);
  const [errorJob, setErrorJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const gallery = useImageGallery(client, galleryApplied);
  const galleryRefresh = gallery.refresh;
  const fileRef = useRef<HTMLInputElement>(null);

  // Debounce the free-text gallery tag search (fuzzy, resolved server-side).
  useEffect(() => {
    const timer = setTimeout(() => setGalleryApplied(galleryQuery), 200);
    return () => clearTimeout(timer);
  }, [galleryQuery]);

  // Seed provider/model from config once it lands (config loads async).
  useEffect(() => {
    if (imageGen === undefined) return;
    setProvider((p) => (p.length > 0 ? p : (imageGen.provider ?? "stub")));
    setModel((m) => (m.length > 0 ? m : (imageGen.model ?? "")));
  }, [imageGen]);

  // Capabilities for the selected provider/model (drives the params UI).
  useEffect(() => {
    let cancelled = false;
    void client
      .imageCapabilities(
        provider.trim() || undefined,
        model.trim() || undefined,
      )
      .then((res) => {
        if (cancelled) return;
        setCaps(res);
        setParams((prev) => coerceParams(res.capabilities.params, prev));
        setProvider((p) => (p.length > 0 ? p : res.provider));
        setModel((m) => (m.length > 0 ? m : res.model));
      })
      .catch(() => {
        if (!cancelled) setCaps(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, provider, model]);

  const reloadTags = useCallback(async (): Promise<void> => {
    try {
      // Fetch a wide slice so the fuzzy autocomplete searches the whole tag set.
      setTagOptions(await client.imageTags(undefined, 200));
    } catch {
      // Advisory — autocomplete just stays as-is.
    }
  }, [client]);

  useEffect(() => {
    void reloadTags();
  }, [reloadTags]);

  // Seed the last job's placeholder (an in-flight or failed run survives a reload).
  useEffect(() => {
    let cancelled = false;
    void client
      .imageRecent()
      .then((recent) => {
        if (cancelled) return;
        const last = recent.job;
        if (
          last !== undefined &&
          (last.status === "queued" || last.status === "running" || last.status === "error")
        ) {
          setJobs([last]);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Live updates: our job's status/progress, and gallery invalidation on any
  // asset change from any surface.
  useEffect(() => {
    const unsubscribe = eventMux(client).subscribe((evt) => {
      if (evt.type === "job.updated") {
        const updated = (evt.payload as { job: Job }).job;
        setJobs((prev) => {
          if (!prev.some((j) => j.id === updated.id)) return prev;
          // Done / cancelled placeholders disappear; assets appear via
          // `asset.created` (the gallery refresh below).
          if (updated.status === "done" || updated.status === "cancelled") {
            return prev.filter((j) => j.id !== updated.id);
          }
          return prev.map((j) => (j.id === updated.id ? updated : j));
        });
        if (updated.status === "done") {
          void galleryRefresh();
          void reloadTags();
        }
      } else if (
        evt.type === "asset.created" ||
        evt.type === "asset.deleted" ||
        evt.type === "asset.updated"
      ) {
        void galleryRefresh();
        if (evt.type === "asset.created" || evt.type === "asset.updated") void reloadTags();
      }
    });
    return unsubscribe;
  }, [client, galleryRefresh, reloadTags]);

  const persistImageGen = useCallback(
    (nextProvider: string, nextModel: string): void => {
      void client
        .putConfig({
          imageGen: {
            provider: nextProvider,
            model: nextModel,
            ...(imageGen?.account !== undefined
              ? { account: imageGen.account }
              : {}),
          },
        })
        .catch((err) =>
          onNotice(err instanceof Error ? err.message : String(err), "error"),
        );
    },
    [client, imageGen?.account, onNotice],
  );

  const updateProvider = (next: string): void => {
    setProvider(next);
    if (next.trim().length > 0 && model.trim().length > 0)
      persistImageGen(next, model);
  };

  const updateModel = (next: string): void => {
    setModel(next);
    if (next.trim().length > 0 && provider.trim().length > 0)
      persistImageGen(provider, next);
  };

  // Keep the selection inside the current workflow's supported model set: a
  // model that can't do image-to-image is hidden (and swapped out) for i2i.
  useEffect(() => {
    if (caps === null) return;
    const supported = modelsForWorkflow(caps.models, workflow);
    if (supported.length === 0) return;
    if (supported.some((m) => m.id === model)) return;
    const next = supported[0]?.id;
    if (next === undefined) return;
    setModel(next);
    if (provider.trim().length > 0) persistImageGen(provider, next);
  }, [caps, workflow, model, provider, persistImageGen]);

  const uploadReference = useCallback(
    async (file: File): Promise<void> => {
      if (!isReferenceImage(file)) {
        onNotice(`Unsupported image format — use ${REFERENCE_LABEL}.`, "error");
        return;
      }
      if (file.size > REFERENCE_MAX_BYTES) {
        onNotice(`Image is too large — ${REFERENCE_LABEL} up to 10 MB.`, "error");
        return;
      }
      try {
        const ref: AttachmentRef = await client.uploadAttachment({
          name: file.name,
          mime: file.type,
          bytes: file,
        });
        setReference({ id: ref.id, name: ref.name });
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [client, onNotice],
  );

  const onReferenceDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file !== undefined) void uploadReference(file);
  };

  // Paste an image from the clipboard (Ctrl/Cmd+V) while on Image to Image.
  // Ignored when the paste targets a text field (the prompt, tags, …).
  useEffect(() => {
    if (workflow !== "i2i") return;
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      const item = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file !== undefined && file !== null) {
        e.preventDefault();
        void uploadReference(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [workflow, uploadReference]);

  const generate = async (): Promise<void> => {
    const text = prompt.trim();
    if (text.length === 0) {
      onNotice("Enter a prompt first.", "error");
      return;
    }
    if (workflow === "i2i" && reference === null) {
      onNotice("Image-to-image needs a reference image.", "error");
      return;
    }
    setSubmitting(true);
    try {
      const created = await client.generateImage({
        mode: workflow,
        prompt: text,
        ...(model.trim().length > 0 ? { model: model.trim() } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(workflow === "i2i" && reference !== null
          ? { referenceAssetIds: [reference.id] }
          : {}),
        ...(tags.length > 0 ? { tags } : {}),
      });
      // Show a placeholder card immediately (prune older failed placeholders).
      setJobs((prev) => [
        ...prev.filter((j) => j.status === "queued" || j.status === "running"),
        created,
      ]);
      onNotice("generation queued", "info");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSubmitting(false);
    }
  };

  // The most recent in-flight job drives the Cancel button; failed jobs
  // surface their Retry from the card's `…` menu and the error modal.
  const activeJob =
    [...jobs].reverse().find((j) => j.status === "queued" || j.status === "running") ??
    null;
  const busy = activeJob !== null;

  const cancel = async (): Promise<void> => {
    if (activeJob === null) return;
    try {
      await client.cancelJob(activeJob.id);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const retryJob = async (job: Job): Promise<void> => {
    try {
      const next = await client.retryJob(job.id);
      if (next !== undefined) {
        setJobs((prev) => [...prev.filter((j) => j.id !== job.id), next]);
      }
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const deleteImage = async (asset: Asset): Promise<void> => {
    try {
      const ok = await client.deleteAsset(asset.id);
      if (ok) {
        await gallery.refresh();
        onNotice("image deleted");
      }
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const downloadImage = async (asset: Asset): Promise<void> => {
    try {
      const res = await client.assetContent(asset.id);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${assetTitle(asset)}.${extFromMime(asset.mime)}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const saveTags = async (asset: Asset, tags: string[]): Promise<void> => {
    try {
      const updated = await client.setAssetTags(asset.id, tags);
      if (updated === undefined) {
        onNotice("Image not found.", "error");
        return;
      }
      setEditingTags(null);
      await gallery.refresh();
      await reloadTags();
      onNotice("tags updated");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const loadInputs = (asset: Asset): void => {
    const gen = readMediaGen(asset.meta);
    if (gen === undefined) {
      onNotice("This image has no stored recipe to load.", "error");
      return;
    }
    setWorkflow(gen.mode);
    setPrompt(gen.prompt);
    setTags(gen.tags ?? []);
    if (gen.model !== undefined && gen.model.length > 0) setModel(gen.model); // form-only on load
    if (gen.params !== undefined)
      setParams(coerceParams(caps?.capabilities.params ?? [], gen.params));
    const refId = gen.referenceAssetIds?.[0];
    setReference(refId !== undefined ? { id: refId, name: "reference" } : null);
    onNotice("inputs loaded — Generate creates a new image", "info");
  };

  // Generate stays available while a job runs — each click queues a new
  // generation (parallel up to config.jobs.concurrency), with its own prompt.
  const canGenerate =
    prompt.trim().length > 0 && !submitting && (workflow === "t2i" || reference !== null);
  const selectedModel = caps?.models.find((m) => m.id === model);
  // Only models that support the selected workflow are offered (e.g. a
  // text-to-image-only model disappears for Image to Image).
  const workflowModels = modelsForWorkflow(caps?.models ?? [], workflow);

  // Fuzzy tag suggestions for the gallery search (ranked prefix > substring > subsequence).
  const gallerySuggestions: MediaTagCount[] =
    galleryQuery.trim().length === 0
      ? []
      : tagOptions
          .map((tag) => ({ tag, score: fuzzyTagScore(tag.tag, galleryQuery) }))
          .filter((row) => row.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.tag.count - a.tag.count ||
              a.tag.tag.localeCompare(b.tag.tag),
          )
          .slice(0, 8)
          .map((row) => row.tag);

  return (
    <div className="image-pane">
      <SectionHeader
        title="Image Gen"
        lede="Generate images and browse your history. Click an image to load its inputs — Generate always creates a new one."
      />

      <div className="image-workbench">
        <div className="image-controls">
          <div className="image-controls-row">
            <Field label="Workflow">
              <Select
                value={workflow}
                onChange={(v) => setWorkflow(v === "i2i" ? "i2i" : "t2i")}
                ariaLabel="Workflow"
                options={[
                  { value: "t2i", label: "Text to Image" },
                  { value: "i2i", label: "Image to Image" },
                ]}
              />
            </Field>
            <Field label="Provider">
              <Combobox
                creatable
                value={provider}
                onChange={updateProvider}
                options={[
                  {
                    value: "openrouter",
                    label: "OpenRouter",
                    hint: "image API",
                  },
                  {
                    value: "stub",
                    label: "Stub (placeholder)",
                    hint: "offline",
                  },
                ]}
                ariaLabel="Provider"
                emptyText="Type a provider id."
              />
            </Field>
            <Field label="Model" hint={`(${workflowModels.length})`}>
              <Combobox
                creatable
                value={model}
                onChange={updateModel}
                options={workflowModels.map((m) => ({
                  value: m.id,
                  label: m.id,
                  hint: modelOptionHint(m),
                }))}
                ariaLabel="Model"
                emptyText="No model supports this workflow — type an id."
              />
            </Field>
          </div>

          {caps !== null && workflowModels.length === 0 && (
            <p className="dim">
              No {workflow === "i2i" ? "image-to-image" : "text-to-image"} model
              is available for {provider.trim() || "this provider"}.
            </p>
          )}

          {selectedModel !== undefined && <ModelInfo model={selectedModel} />}

          <MediaParamsForm
            specs={caps?.capabilities.params ?? []}
            value={params}
            onChange={setParams}
          />

          <Field
            label="Tags"
            hint="(applied to every image; autocompletes from history)"
          >
            <TagInput
              value={tags}
              onChange={setTags}
              suggestions={tagOptions}
            />
          </Field>

          <Field label="Prompt">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Describe the image…"
            />
          </Field>

          {workflow === "i2i" && (
            <div className="field">
              <div
                className="image-ref"
                onDragOver={(e) => e.preventDefault()}
                onDrop={onReferenceDrop}
              >
                {reference !== null ? (
                  <div className="image-ref-preview">
                    <ReferenceImage client={client} id={reference.id} />
                    <div className="image-ref-actions">
                      <span className="dim">{reference.name}</span>
                      <Button
                        variant="ghost"
                        onClick={() => setReference(null)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="dim">Drop an image here, paste it (Ctrl/Cmd+V), or</p>
                    <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                      Choose image
                    </Button>
                    {/* Custom-styled picker: the native input stays hidden and
                        is opened programmatically (the repo's AttachButton
                        pattern), so the UI keeps its own control. */}
                    <input
                      ref={fileRef}
                      type="file"
                      accept={REFERENCE_ACCEPT}
                      hidden
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        const file = e.target.files?.[0];
                        if (file !== undefined) void uploadReference(file);
                        e.target.value = "";
                      }}
                    />
                    <p className="image-ref-formats">
                      Supported: {REFERENCE_LABEL} · up to 10 MB
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="image-actions">
            <Button
              variant="primary"
              onClick={() => void generate()}
              loading={submitting}
              disabled={!canGenerate}
            >
              Generate
            </Button>
            {busy && (
              <Button variant="ghost" onClick={() => void cancel()}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="image-gallery-section">
        <SectionHeader
          title="Gallery"
          lede={
            gallery.total > 0
              ? `${gallery.total} image${gallery.total === 1 ? "" : "s"}.`
              : undefined
          }
        />
        <div className="image-gallery-filter">
          <TextInput
            type="search"
            value={galleryQuery}
            onChange={(e) => setGalleryQuery(e.target.value)}
            placeholder="Search tags… (e.g. gemini)"
            aria-label="Search images by tag"
          />
          {galleryQuery.length > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                setGalleryQuery("");
                setGalleryApplied("");
              }}
            >
              Clear
            </Button>
          )}
        </div>
        {gallerySuggestions.length > 0 && (
          <div
            className="tag-suggestions"
            role="listbox"
            aria-label="Tag suggestions"
          >
            {gallerySuggestions.map((tag) => (
              <button
                key={tag.tag}
                type="button"
                className="tag-suggestion"
                onClick={() => {
                  setGalleryQuery(tag.tag);
                  setGalleryApplied(tag.tag);
                }}
              >
                {tag.tag} <span className="dim">· {tag.count}</span>
              </button>
            ))}
          </div>
        )}
        {gallery.loading ? (
          <p className="dim">Loading…</p>
        ) : gallery.images.length === 0 && jobs.length === 0 ? (
          <p className="dim">
            {galleryApplied.trim().length > 0
              ? "No images match that tag search."
              : "No images yet."}
          </p>
        ) : (
          <div className="image-grid">
            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onRetry={(j) => void retryJob(j)}
                onOpenError={setErrorJob}
              />
            ))}
            {gallery.images.map((asset) => (
              <ImageCard
                key={asset.id}
                client={client}
                asset={asset}
                onOpen={setLightbox}
                onDownload={(a) => void downloadImage(a)}
                onLoad={loadInputs}
                onEditTags={setEditingTags}
                onDelete={(a) => void deleteImage(a)}
              />
            ))}
          </div>
        )}
        {gallery.hasMore && (
          <button
            type="button"
            className="load-more"
            onClick={gallery.loadMore}
            disabled={gallery.loadingMore}
          >
            {gallery.loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>

      {lightbox !== null && (
        <ImageLightbox
          attachment={{
            id: lightbox.id,
            name: assetTitle(lightbox),
            mime: lightbox.mime,
            bytes: lightbox.bytes,
            kind: "image",
          }}
          client={client}
          onClose={() => setLightbox(null)}
        />
      )}

      {editingTags !== null && (
        <EditTagsModal
          key={editingTags.id}
          asset={editingTags}
          suggestions={tagOptions}
          onSave={(tags) => void saveTags(editingTags, tags)}
          onClose={() => setEditingTags(null)}
        />
      )}

      {errorJob !== null && (
        <ErrorJobModal
          key={errorJob.id}
          job={errorJob}
          onRetry={(job) => {
            setErrorJob(null);
            void retryJob(job);
          }}
          onClose={() => setErrorJob(null)}
        />
      )}
    </div>
  );
}

/** Renders the capability param spec generically (enum/toggle/range/number/text). */
function MediaParamsForm({
  specs,
  value,
  onChange,
}: {
  specs: MediaParamSpec[];
  value: Record<string, MediaParamValue>;
  onChange: (next: Record<string, MediaParamValue>) => void;
}) {
  if (specs.length === 0) return null;
  const set = (key: string, v: MediaParamValue): void =>
    onChange({ ...value, [key]: v });
  return (
    <div className="media-params">
      {specs.map((spec) => {
        if (spec.kind === "enum") {
          return (
            <Field key={spec.key} label={spec.label} hint={spec.hint}>
              <Select
                value={String(
                  value[spec.key] ??
                    spec.default ??
                    spec.options[0]?.value ??
                    "",
                )}
                onChange={(v) => set(spec.key, v)}
                ariaLabel={spec.label}
                options={spec.options}
              />
            </Field>
          );
        }
        if (spec.kind === "toggle") {
          return (
            <ToggleRow
              key={spec.key}
              checked={Boolean(value[spec.key] ?? spec.default ?? false)}
              onChange={(next) => set(spec.key, next)}
              title={spec.label}
              description={spec.hint}
            />
          );
        }
        if (spec.kind === "range") {
          const current =
            typeof value[spec.key] === "number"
              ? (value[spec.key] as number)
              : (spec.default ?? spec.min);
          return (
            <Field key={spec.key} label={spec.label} hint={spec.hint}>
              <div className="param-range">
                <input
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step ?? 1}
                  value={current}
                  aria-label={spec.label}
                  onChange={(e) => set(spec.key, Number(e.target.value))}
                />
                <span className="param-range-value">
                  {current}
                  {spec.unit ?? ""}
                </span>
              </div>
            </Field>
          );
        }
        if (spec.kind === "number") {
          const current =
            typeof value[spec.key] === "number"
              ? (value[spec.key] as number)
              : spec.default;
          return (
            <Field key={spec.key} label={spec.label} hint={spec.hint}>
              <TextInput
                type="number"
                min={spec.min}
                max={spec.max}
                value={current ?? ""}
                aria-label={spec.label}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  set(spec.key, Number.isFinite(n) ? n : 0);
                }}
              />
            </Field>
          );
        }
        return (
          <Field key={spec.key} label={spec.label} hint={spec.hint}>
            <TextInput
              type="text"
              value={String(value[spec.key] ?? spec.default ?? "")}
              placeholder={spec.placeholder}
              aria-label={spec.label}
              onChange={(e) => set(spec.key, e.target.value)}
            />
          </Field>
        );
      })}
    </div>
  );
}

/** The request embedded in a job's input, for the placeholder's uniform meta. */
function jobRequest(job: Job): {
  mode: MediaMode;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
} {
  const input = (typeof job.input === "object" && job.input !== null ? job.input : {}) as Record<
    string,
    unknown
  >;
  const params = (
    typeof input.params === "object" && input.params !== null ? input.params : {}
  ) as Record<string, unknown>;
  return {
    mode: input.mode === "i2i" ? "i2i" : "t2i",
    ...(typeof input.prompt === "string" && input.prompt.length > 0 ? { prompt: input.prompt } : {}),
    ...(typeof input.model === "string" && input.model.length > 0 ? { model: input.model } : {}),
    ...(typeof params.aspect_ratio === "string" ? { aspectRatio: params.aspect_ratio } : {}),
    ...(typeof params.resolution === "string" ? { resolution: params.resolution } : {}),
  };
}

/**
 * A gallery placeholder for an in-flight (spinner) or failed (X) job. Real
 * images replace it as `asset.created` lands; the card disappears on done.
 * A failed card offers Retry from its `…` menu.
 */
function JobCard({
  job,
  onRetry,
  onOpenError,
}: {
  job: Job;
  onRetry: (job: Job) => void;
  onOpenError: (job: Job) => void;
}) {
  const failed = job.status === "error";
  const request = jobRequest(job);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const trailing = request.resolution ?? request.model;
  return (
    <div
      ref={rootRef}
      className={failed ? "image-card image-card-job failed" : "image-card image-card-job"}
    >
      <button
        type="button"
        className="image-card-job-media"
        role="status"
        disabled={!failed}
        aria-label={failed ? "View generation error" : undefined}
        onClick={failed ? () => onOpenError(job) : undefined}
      >
        {failed ? (
          <X size={30} aria-hidden="true" />
        ) : (
          <LoaderCircle size={30} className="icon-spin" aria-hidden="true" />
        )}
        <span className="image-card-job-label">{failed ? "Failed" : "Generating…"}</span>
      </button>
      {failed && (
        <>
          <button
            type="button"
            className="image-card-menu-btn"
            aria-label="Generation actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreVertical size={15} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="image-card-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="image-card-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onRetry(job);
                }}
              >
                <RotateCcw size={13} aria-hidden="true" />
                Retry
              </button>
            </div>
          )}
        </>
      )}
      <div className="image-card-body">
        <div className="image-card-meta">
          <span className="image-card-mode">
            {request.mode.toUpperCase()}
            {request.aspectRatio !== undefined ? ` · ${request.aspectRatio}` : ""}
          </span>
          {trailing !== undefined && (
            <span className="image-card-dims" title={trailing}>
              {trailing}
            </span>
          )}
        </div>
        {request.prompt !== undefined && (
          <p className="image-card-job-prompt" title={request.prompt}>
            {request.prompt}
          </p>
        )}
        {!failed && job.note !== undefined && <p className="image-card-job-note">{job.note}</p>}
      </div>
    </div>
  );
}

function ImageCard({
  client,
  asset,
  onOpen,
  onDownload,
  onLoad,
  onEditTags,
  onDelete,
}: {
  client: BaiClient;
  asset: Asset;
  onOpen: (asset: Asset) => void;
  onDownload: (asset: Asset) => void;
  onLoad: (asset: Asset) => void;
  onEditTags: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}) {
  const url = useAssetUrl(client, asset.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const gen = readMediaGen(asset.meta);
  const mode =
    gen?.mode ??
    (typeof asset.meta.mode === "string"
      ? (asset.meta.mode as MediaMode)
      : undefined);
  const ratio =
    typeof asset.meta.aspectRatio === "string"
      ? asset.meta.aspectRatio
      : undefined;
  const width =
    typeof asset.meta.width === "number" ? asset.meta.width : undefined;
  const height =
    typeof asset.meta.height === "number" ? asset.meta.height : undefined;
  const cost =
    typeof asset.meta.costUsd === "number" ? asset.meta.costUsd : undefined;
  const tags = gen?.tags ?? [];

  // Close the actions popup on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (
        rootRef.current !== null &&
        !rootRef.current.contains(e.target as Node)
      )
        setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const run = (fn: (a: Asset) => void): void => {
    setMenuOpen(false);
    fn(asset);
  };

  return (
    <div className="image-card" ref={rootRef}>
      {/* Clicking the image always opens the expanded modal. */}
      <button
        type="button"
        className="image-card-media"
        onClick={() => onOpen(asset)}
        title="View image"
      >
        {url !== undefined ? (
          <img src={url} alt={assetTitle(asset)} loading="lazy" />
        ) : (
          <span className="image-card-placeholder" />
        )}
      </button>
      <button
        type="button"
        className="image-card-menu-btn"
        aria-label="Image actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tooltip="Actions"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreVertical size={15} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="image-card-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="image-card-menu-item"
            onClick={() => run(onDownload)}
          >
            <Download size={13} aria-hidden="true" />
            Download
          </button>
          <button
            type="button"
            role="menuitem"
            className="image-card-menu-item"
            onClick={() => run(onLoad)}
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
            Load Inputs
          </button>
          <button
            type="button"
            role="menuitem"
            className="image-card-menu-item"
            onClick={() => run(onEditTags)}
          >
            <Tags size={13} aria-hidden="true" />
            Edit Tags
          </button>
          <button
            type="button"
            role="menuitem"
            className="image-card-menu-item danger"
            onClick={() => run(onDelete)}
          >
            <Trash2 size={13} aria-hidden="true" />
            Delete
          </button>
        </div>
      )}
      <div className="image-card-body">
        <div className="image-card-meta">
          <span className="image-card-mode">
            {mode !== undefined ? mode.toUpperCase() : "IMG"}
            {ratio !== undefined ? ` · ${ratio}` : ""}
          </span>
          {width !== undefined && height !== undefined && (
            <span className="image-card-dims">
              {width}×{height}
            </span>
          )}
          {cost !== undefined && (
            <span className="image-card-cost">{formatCost(cost)}</span>
          )}
        </div>
        {tags.length > 0 && (
          <div className="image-card-tags">
            {tags.map((tag) => (
              <span className="tag-chip small" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Edit one image's tags (seeded from its stored recipe). */
function EditTagsModal({
  asset,
  suggestions,
  onSave,
  onClose,
}: {
  asset: Asset;
  suggestions: MediaTagCount[];
  onSave: (tags: string[]) => void;
  onClose: () => void;
}) {
  const [tags, setTags] = useState<string[]>(() => readMediaGen(asset.meta)?.tags ?? []);
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit tags"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(tags)}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Tags" hint="(autocompletes from history)">
        <TagInput value={tags} onChange={setTags} suggestions={suggestions} />
      </Field>
    </Modal>
  );
}

/** The full failure detail for a job (opened by clicking its failed card). */
function ErrorJobModal({
  job,
  onRetry,
  onClose,
}: {
  job: Job;
  onRetry: (job: Job) => void;
  onClose: () => void;
}) {
  const request = jobRequest(job);
  return (
    <Modal
      open
      onClose={onClose}
      title="Generation failed"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => onRetry(job)}>
            Retry
          </Button>
        </>
      }
    >
      {request.prompt !== undefined && <p className="image-error-prompt">{request.prompt}</p>}
      <pre className="image-error-detail">{job.error ?? "Unknown error"}</pre>
    </Modal>
  );
}

function ReferenceImage({ client, id }: { client: BaiClient; id: string }) {
  const url = useAssetUrl(client, id);
  if (url === undefined) return <span className="image-ref-placeholder" />;
  return <img className="image-ref-img" src={url} alt="Reference" />;
}

/** `t2i` → "T2I", `i2i` → "I2I". */
function modeLabel(mode: MediaMode): string {
  return mode === "t2i" ? "T2I" : "I2I";
}

/** Every field of a {@link MediaModelInfo}, compacted for a dropdown row. */
function modelOptionHint(model: MediaModelInfo): string {
  const parts: string[] = [];
  if (model.label !== undefined && model.label !== model.id)
    parts.push(model.label);
  parts.push(model.modes.map(modeLabel).join("/"));
  parts.push(`refs≤${model.maxReferences}`);
  parts.push(`n≤${model.maxCount}`);
  if (model.rates !== undefined && model.rates.length > 0) {
    parts.push(model.rates.map((r) => `${r.label} ${r.value}`).join(", "));
  }
  return parts.join(" · ");
}

/** The selected model's full capability/pricing summary. */
function ModelInfo({ model }: { model: MediaModelInfo }) {
  return (
    <div className="media-model-info" aria-label="Model information">
      <span className="media-rate">
        <span className="media-rate-label">Model</span>
        <span className="media-rate-value">{model.label ?? model.id}</span>
      </span>
      <span className="media-rate">
        <span className="media-rate-label">Workflows</span>
        <span className="media-rate-value">
          {model.modes.map(modeLabel).join(" + ")}
        </span>
      </span>
      <span className="media-rate">
        <span className="media-rate-label">References</span>
        <span className="media-rate-value">≤ {model.maxReferences}</span>
      </span>
      <span className="media-rate">
        <span className="media-rate-label">Max images</span>
        <span className="media-rate-value">{model.maxCount}</span>
      </span>
      {model.rates?.map((rate) => (
        <span className="media-rate" key={rate.label}>
          <span className="media-rate-label">{rate.label}</span>
          <span className="media-rate-value">{rate.value}</span>
        </span>
      ))}
    </div>
  );
}

/** Human-ish title for an asset (falls back to a short id). */
function assetTitle(asset: Asset): string {
  const gen = readMediaGen(asset.meta);
  if (gen !== undefined) {
    const text = gen.prompt.trim();
    if (text.length > 0)
      return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  return `image ${asset.id.slice(-6)}`;
}

/** File extension for a download filename, from the asset's MIME type. */
function extFromMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

/** Clamp/validate params against the spec (used when the model or recipe changes). */
function coerceParams(
  specs: MediaParamSpec[],
  params: Record<string, MediaParamValue>,
): Record<string, MediaParamValue> {
  const out: Record<string, MediaParamValue> = {};
  for (const spec of specs) {
    const current = params[spec.key];
    switch (spec.kind) {
      case "enum": {
        const chosen =
          typeof current === "string" &&
          spec.options.some((o) => o.value === current)
            ? current
            : spec.default;
        if (chosen !== undefined) out[spec.key] = chosen;
        break;
      }
      case "toggle": {
        const chosen = typeof current === "boolean" ? current : spec.default;
        if (chosen !== undefined) out[spec.key] = chosen;
        break;
      }
      case "range": {
        const chosen =
          typeof current === "number"
            ? clamp(current, spec.min, spec.max)
            : spec.default;
        if (chosen !== undefined) out[spec.key] = chosen;
        break;
      }
      case "number": {
        if (typeof current === "number") {
          out[spec.key] = clamp(
            current,
            spec.min ?? current,
            spec.max ?? current,
          );
        } else if (spec.default !== undefined) {
          out[spec.key] = spec.default;
        }
        break;
      }
      case "text": {
        if (typeof current === "string") out[spec.key] = current;
        else if (spec.default !== undefined) out[spec.key] = spec.default;
        break;
      }
    }
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
