import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Download,
  LoaderCircle,
  MessageSquare,
  MoreVertical,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Tags,
  Trash2,
  Video as VideoIcon,
  X,
} from "lucide-react";
import { eventMux, type BaiClient } from "@bai/api/client";
import {
  coerceMediaParams,
  formatCost,
  fuzzyTagScore,
  normalizeTags,
  readVideoGen,
  VIDEO_WORKFLOW_LABELS,
  type Asset,
  type Job,
  type MediaGenConfig,
  type MediaParamValue,
  type MediaTagCount,
  type VideoCapabilitiesResponse,
  type VideoInput,
  type VideoModelInfo,
  type VideoProviderInfo,
  type VideoWorkflow,
  type VideoWorkflowSpec,
} from "@bai/shared";
import {
  ActionRow,
  Banner,
  Button,
  Card,
  Chip,
  Combobox,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  Field,
  FormSection,
  IconButton,
  MediaParamsForm,
  Modal,
  PageHeader,
  SectionHeader,
  Select,
  Stat,
  StatRow,
  TagInput,
  TextInput,
  Textarea,
  Toolbar,
} from "./components";
import { useAssetUrl } from "./attachments";
import { galleryNavState } from "./image-nav";
import { useInView } from "./use-in-view";
import { videoModelOptionHint } from "./media-model-hint";
import { useVideoGallery } from "./use-video-gallery";
import { useVideoPoster } from "./use-video-poster";
import { MediaAssetPicker } from "./media-asset-picker";

type OnNotice = (message: string, kind?: "success" | "error" | "info") => void;

const STUB_PROVIDER: VideoProviderInfo = {
  id: "stub",
  label: "Stub (offline placeholder)",
  defaultModel: "stub",
  workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend", "upscale", "motion", "lipsync", "reframe"],
  connected: true,
  models: [{ id: "stub", label: "Stub (placeholder)", workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend", "upscale", "motion", "lipsync", "reframe"] }],
};

/**
 * The single-page video generation workbench: a model + workflow selector and
 * the workflow's typed reference slots on the left, a tag-filtered gallery
 * below (the gallery IS the output). Workflows and input roles come from the
 * adapter's declarative capabilities, so a new workflow is data, not UI work.
 */
export function VideoPane({
  client,
  videoGen,
  onNotice,
  onOpenSession,
}: {
  client: BaiClient;
  videoGen?: MediaGenConfig;
  onNotice: OnNotice;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [providers, setProviders] = useState<VideoProviderInfo[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [provider, setProvider] = useState(videoGen?.provider ?? "");
  const [model, setModel] = useState(videoGen?.model ?? "");
  const [caps, setCaps] = useState<VideoCapabilitiesResponse | null>(null);
  const [workflow, setWorkflow] = useState<VideoWorkflow>("t2v");
  const [prompt, setPrompt] = useState("");
  const [params, setParams] = useState<Record<string, MediaParamValue>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [inputs, setInputs] = useState<Partial<Record<string, VideoInput[]>>>({});
  const [tagOptions, setTagOptions] = useState<MediaTagCount[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [galleryQuery, setGalleryQuery] = useState("");
  const [galleryApplied, setGalleryApplied] = useState("");
  const [lightbox, setLightbox] = useState<Asset | null>(null);
  const [errorJob, setErrorJob] = useState<Job | null>(null);
  const [editingTags, setEditingTags] = useState<Asset | null>(null);
  const [pickerSlot, setPickerSlot] = useState<VideoWorkflowSpec["inputs"][number] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Asset | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const gallery = useVideoGallery(client, galleryApplied);
  // Infinite scroll: end sentinel auto-fetches the next page (PAGE_SIZE=24).
  const [gallerySentinelRef, gallerySentinelInView] = useInView<HTMLDivElement>("200px");
  const galleryLoadMore = gallery.loadMore;
  const galleryHasMore = gallery.hasMore;
  const galleryLoadingMore = gallery.loadingMore;
  useEffect(() => {
    if (gallerySentinelInView && galleryHasMore && !galleryLoadingMore) galleryLoadMore();
  }, [gallerySentinelInView, galleryHasMore, galleryLoadingMore, galleryLoadMore]);

  // Debounce the gallery tag search.
  useEffect(() => {
    const t = setTimeout(() => setGalleryApplied(galleryQuery), 200);
    return () => clearTimeout(t);
  }, [galleryQuery]);

  useEffect(() => {
    if (videoGen === undefined) return;
    setProvider((p) => (p.length > 0 ? p : (videoGen.provider ?? "stub")));
    setModel((m) => (m.length > 0 ? m : (videoGen.model ?? "")));
  }, [videoGen]);

  const reloadProviders = useCallback(async (): Promise<void> => {
    try {
      const list = await client.videoProviders();
      setProviders(list);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoaded(true);
    }
  }, [client]);

  useEffect(() => {
    void reloadProviders();
  }, [reloadProviders]);

  const activeProviders = useMemo(
    () => (providers.some((p) => p.connected) ? providers.filter((p) => p.connected) : [STUB_PROVIDER]),
    [providers],
  );

  const models = useMemo(() => {
    const out: { provider: VideoProviderInfo; model: VideoModelInfo }[] = [];
    const seen = new Set<string>();
    for (const p of activeProviders) {
      for (const m of p.models ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({ provider: p, model: m });
      }
    }
    return out;
  }, [activeProviders]);

  const selectedModel = models.find((m) => m.model.id === model)?.model;
  const workflowSpecs = caps?.capabilities.workflows ?? [];
  const activeSpec = workflowSpecs.find((w) => w.id === workflow) ?? workflowSpecs[0];

  // Resolve capabilities for the selected provider/model.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.videoCapabilities(
          provider.length > 0 ? provider : undefined,
          model.length > 0 ? model : undefined,
        );
        if (cancelled) return;
        setCaps(res);
        if (model.length === 0) {
          setModel(res.model);
          setProvider(res.provider);
        }
        setParams((prev) => coerceMediaParams(res.capabilities.params, prev));
      } catch {
        if (!cancelled) setCaps(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, provider, model]);

  const reloadTags = useCallback(async (): Promise<void> => {
    try {
      setTagOptions(await client.videoTags(undefined, 200));
    } catch {
      setTagOptions([]);
    }
  }, [client]);

  useEffect(() => {
    void reloadTags();
  }, [reloadTags]);

  // Seed the last job's placeholder (an in-flight or failed run survives a reload).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const recent = await client.videoRecent();
        if (cancelled) return;
        const last = recent.job;
        if (
          last !== undefined &&
          (last.status === "queued" || last.status === "running" || last.status === "error")
        ) {
          setJobs([last]);
        }
      } catch {
        // advisory
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Live updates: our job's status/progress (including a failure surfacing
  // immediately), plus gallery invalidation on any asset change from any
  // surface. Mirrors the Image page's firehose effect.
  useEffect(() => {
    const unsubscribe = eventMux(client).subscribe((evt) => {
      if (evt.type === "job.updated") {
        const updated = (evt.payload as { job: Job }).job;
        setJobs((prev) => {
          if (!prev.some((j) => j.id === updated.id)) return prev;
          // Done / cancelled placeholders disappear; the video appears via
          // `asset.created` (the gallery refresh below).
          if (updated.status === "done" || updated.status === "cancelled") {
            return prev.filter((j) => j.id !== updated.id);
          }
          return prev.map((j) => (j.id === updated.id ? updated : j));
        });
        if (updated.status === "done") {
          void gallery.refresh();
          void reloadTags();
        }
      } else if (
        evt.type === "asset.created" ||
        evt.type === "asset.deleted" ||
        evt.type === "asset.updated"
      ) {
        void gallery.refresh();
        if (evt.type === "asset.created" || evt.type === "asset.updated") void reloadTags();
      } else if (evt.type === "provider.updated") {
        // A provider file / key / config change may add or remove models.
        void reloadProviders();
      }
    });
    return unsubscribe;
  }, [client, gallery.refresh, reloadTags, reloadProviders]);

  const persistVideoGen = useCallback(
    (nextProvider: string, nextModel: string): void => {
      void client
        .putConfig({
          videoGen: {
            provider: nextProvider,
            model: nextModel,
            ...(videoGen?.account !== undefined && videoGen.provider === nextProvider
              ? { account: videoGen.account }
              : {}),
          },
        })
        .catch((err: unknown) => onNotice(err instanceof Error ? err.message : String(err), "error"));
    },
    [client, videoGen?.account, videoGen?.provider, onNotice],
  );

  const selectModel = useCallback(
    (entry: { provider: VideoProviderInfo; model: VideoModelInfo }): void => {
      setProvider(entry.provider.id);
      setModel(entry.model.id);
      persistVideoGen(entry.provider.id, entry.model.id);
    },
    [persistVideoGen],
  );

  // Keep the workflow within the selected model's supported set.
  useEffect(() => {
    if (workflowSpecs.length === 0) return;
    if (!workflowSpecs.some((w) => w.id === workflow)) {
      setWorkflow(workflowSpecs[0]!.id);
    }
  }, [workflowSpecs, workflow]);

  const addInput = useCallback((role: string, input: VideoInput): void => {
    setInputs((prev) => {
      const current = prev[role] ?? [];
      return { ...prev, [role]: [...current, input] };
    });
  }, []);

  const removeInput = useCallback((role: string, index: number): void => {
    setInputs((prev) => {
      const current = prev[role] ?? [];
      return { ...prev, [role]: current.filter((_, i) => i !== index) };
    });
  }, []);

  const uploadToSlot = useCallback(
    async (slot: VideoWorkflowSpec["inputs"][number], file: File): Promise<void> => {
      try {
        const ref = await client.uploadAttachment({ name: file.name, mime: file.type, bytes: file });
        addInput(slot.role, { role: slot.role, assetId: ref.id });
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [client, addInput, onNotice],
  );

  const generate = useCallback(async (): Promise<void> => {
    if (activeSpec === undefined) return;
    const missing = activeSpec.inputs.find((slot) => {
      if (slot.required !== true) return false;
      return (inputs[slot.role] ?? []).length === 0;
    });
    if (missing !== undefined) {
      onNotice(`${missing.label} is required for ${activeSpec.label}.`, "error");
      return;
    }
    setSubmitting(true);
    try {
      const flat: VideoInput[] = [];
      for (const value of Object.values(inputs)) for (const input of value ?? []) flat.push(input);
      const job = await client.generateVideo({
        workflow,
        prompt,
        ...(model.length > 0 ? { model } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(flat.length > 0 ? { inputs: flat } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      });
      setJobs((prev) => [...prev.filter((j) => j.status === "queued" || j.status === "running"), job]);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSubmitting(false);
    }
  }, [activeSpec, inputs, workflow, prompt, model, params, tags, client, onNotice]);

  const activeJob = jobs.find((j) => j.status === "queued" || j.status === "running");
  const busy = activeJob !== undefined || submitting;

  const cancel = useCallback(async (): Promise<void> => {
    if (activeJob === undefined) return;
    try {
      await client.cancelJob(activeJob.id);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  }, [activeJob, client, onNotice]);

  const retryJob = useCallback(
    async (job: Job): Promise<void> => {
      try {
        const next = await client.retryJob(job.id);
        if (next !== undefined) setJobs((prev) => [...prev.filter((j) => j.id !== job.id), next]);
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [client, onNotice],
  );

  const deleteVideo = useCallback(
    async (asset: Asset): Promise<void> => {
      try {
        await client.deleteAsset(asset.id);
        onNotice("video deleted");
        void gallery.refresh();
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [client, onNotice, gallery],
  );

  const loadInputs = useCallback(
    (asset: Asset): void => {
      const gen = readVideoGen(asset.meta);
      if (gen === undefined) {
        onNotice("This video has no stored recipe to load.", "error");
        return;
      }
      setWorkflow(gen.workflow);
      setPrompt(gen.prompt);
      setTags(gen.tags ?? []);
      if (gen.model !== undefined) setModel(gen.model);
      if (typeof asset.meta.provider === "string" && asset.meta.provider.length > 0) setProvider(asset.meta.provider);
      setParams(coerceMediaParams(caps?.capabilities.params ?? [], gen.params ?? {}));
      const next: Partial<Record<string, VideoInput[]>> = {};
      for (const input of gen.inputs ?? []) {
        next[input.role] = [...(next[input.role] ?? []), input];
      }
      setInputs(next);
      onNotice("inputs loaded — Generate creates a new video", "info");
    },
    [caps, onNotice],
  );

  const saveTags = useCallback(
    async (asset: Asset, next: string[]): Promise<void> => {
      try {
        await client.setAssetTags(asset.id, normalizeTags(next));
        setEditingTags(null);
        void gallery.refresh();
        void reloadTags();
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err), "error");
      }
    },
    [client, onNotice, gallery, reloadTags],
  );

  const gallerySuggestions = useMemo(() => {
    const q = galleryQuery.trim();
    if (q.length === 0) return [];
    return tagOptions
      .map((t) => ({ ...t, score: fuzzyTagScore(t.tag, q) }))
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score || b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 8);
  }, [galleryQuery, tagOptions]);

  const lightboxNav = galleryNavState(gallery.videos, lightbox?.id ?? null, {
    hasMore: gallery.hasMore,
    total: gallery.total,
  });

  const stepLightbox = useCallback(
    (delta: number): void => {
      if (lightbox === null) return;
      const index = gallery.videos.findIndex((a) => a.id === lightbox.id);
      const target = gallery.videos[index + delta];
      if (target !== undefined) setLightbox(target);
    },
    [lightbox, gallery.videos],
  );

  const canGenerate = activeSpec !== undefined && (prompt.trim().length > 0 || workflow === "upscale");

  return (
    <div className="video-pane">
      <PageHeader
        title="Video"
        lede="Generate or transform a clip — pick a workflow, attach its references, and go."
      />

      <div className="video-workbench">
        <Card variant="raised" className="workbench-panel">
          <FormSection title="Model" columns={2}>
            <Field label="Model" hint={activeProviders.find((p) => p.id === provider)?.label}>
              <Combobox
                value={model}
                ariaLabel="Model"
                onChange={(value) => {
                  const entry = models.find((m) => m.model.id === value);
                  if (entry !== undefined) selectModel(entry);
                  else setModel(value);
                }}
                options={models.map((m) => ({
                  value: m.model.id,
                  label: m.model.id,
                  hint: `${m.provider.label} · ${videoModelOptionHint(m.model)}`,
                }))}
                placeholder={models.length === 0 ? "stub (no provider connected)" : "select a model"}
                creatable
              />
            </Field>
            <Field label="Workflow" hint={activeSpec?.description}>
              <Select
                value={workflow}
                ariaLabel="Workflow"
                onChange={(v) => setWorkflow(v as VideoWorkflow)}
                options={(workflowSpecs.length > 0
                  ? workflowSpecs
                  : [{ id: "t2v" as VideoWorkflow, label: "Text to Video", inputs: [] }]
                ).map((w) => ({ value: w.id, label: w.label }))}
              />
            </Field>
          </FormSection>

          {selectedModel !== undefined && <VideoModelInfo model={selectedModel} />}

          {activeSpec !== undefined && activeSpec.inputs.length > 0 && (
            <FormSection title="References" flow="stack">
              {activeSpec.inputs.map((slot) => (
                <div className="video-slot" key={slot.role}>
                  <div className="video-slot-head">
                    <span className="video-slot-label">
                      {slot.label}
                      {slot.required === true ? " *" : ""}
                    </span>
                    <span className="dim video-slot-accepts">{slot.accepts.join(" / ")}</span>
                  </div>
                  {(inputs[slot.role] ?? []).length > 0 && (
                    <div className="video-slot-chips">
                      {(inputs[slot.role] ?? []).map((input, index) => (
                        <span className="video-slot-chip" key={`${input.assetId ?? input.url}-${index}`}>
                          <span className="video-slot-chip-name">{input.assetId ?? input.url}</span>
                          <IconButton label={`Remove ${slot.label}`} hint="Remove" onClick={() => removeInput(slot.role, index)}>
                            <X size={12} aria-hidden="true" />
                          </IconButton>
                        </span>
                      ))}
                    </div>
                  )}
                  {slot.multiple !== true || (inputs[slot.role] ?? []).length < (slot.maxCount ?? 4) ? (
                    <div className="video-slot-actions">
                      {/* @ui-raw: hidden file input driven by a styled label (FileInput renders its own button). */}
                      <label className="btn btn-secondary btn-sm">
                        Upload
                        <input
                          type="file"
                          hidden
                          accept={acceptFor(slot.accepts)}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file !== undefined) void uploadToSlot(slot, file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      <Button variant="secondary" size="sm" onClick={() => setPickerSlot(slot)}>
                        Pick asset
                      </Button>
                      <UrlInput
                        label={slot.label}
                        onAdd={(url) => addInput(slot.role, { role: slot.role, url })}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </FormSection>
          )}

          <FormSection title="Parameters" flow="stack">
            <MediaParamsForm
              specs={[...(caps?.capabilities.params ?? []), ...(activeSpec?.params ?? [])]}
              value={params}
              onChange={setParams}
            />
          </FormSection>

          <FormSection title="Content" flow="stack">
            {workflow !== "upscale" && (
              <Field label="Prompt">
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  placeholder="Describe the video (camera, subject, motion, mood)…"
                />
              </Field>
            )}
            <Field label="Tags" hint="(applied to every video; autocompletes from history)">
              <TagInput value={tags} onChange={setTags} suggestions={tagOptions} />
            </Field>
          </FormSection>

          <ActionRow align="end">
            {activeJob !== undefined && (
              <Button variant="ghost" onClick={() => void cancel()}>
                Cancel
              </Button>
            )}
            <Button
              variant="primary"
              size="lg"
              onClick={() => void generate()}
              disabled={busy || !canGenerate}
            >
              Generate
            </Button>
          </ActionRow>
        </Card>

        <div className="video-gallery-section">
          <SectionHeader title="Gallery" lede={`${gallery.total} video${gallery.total === 1 ? "" : "s"}`} />
          <Toolbar className="video-gallery-filter">
            <TextInput
              value={galleryQuery}
              placeholder="Filter by tag…"
              aria-label="Filter videos by tag"
              onChange={(e) => setGalleryQuery(e.target.value)}
            />
            {galleryQuery.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setGalleryQuery("")}>
                Clear
              </Button>
            )}
          </Toolbar>
          {gallerySuggestions.length > 0 && (
            <div className="tag-suggestions">
              {gallerySuggestions.map((s) => (
                <Chip key={s.tag} onClick={() => setGalleryQuery(s.tag)}>
                  {s.tag} ({s.count})
                </Chip>
              ))}
            </div>
          )}

          {gallery.loading && gallery.videos.length === 0 ? (
            <p className="dim">loading…</p>
          ) : gallery.videos.length === 0 && jobs.length === 0 ? (
            <EmptyState
              icon={<VideoIcon size={22} aria-hidden="true" />}
              title="No videos yet"
              description="Generated clips land here — generate one above to get started."
            />
          ) : (
            <div className="video-grid">
              {jobs.map((job) => (
                <VideoJobCard
                  key={job.id}
                  job={job}
                  onRetry={(j) => void retryJob(j)}
                  onOpenError={setErrorJob}
                />
              ))}
              {gallery.videos.map((asset) => (
                <VideoCard
                  key={asset.id}
                  client={client}
                  asset={asset}
                  onOpen={() => setLightbox(asset)}
                  onLoad={() => loadInputs(asset)}
                  onEditTags={() => setEditingTags(asset)}
                  onDelete={() => setPendingDelete(asset)}
                  onOpenChat={onOpenSession}
                />
              ))}
            </div>
          )}
          {gallery.hasMore && (
            <>
              <div
                ref={gallerySentinelRef}
                aria-hidden="true"
                style={{ height: 1, width: "100%" }}
              />
              <Button variant="secondary" onClick={() => gallery.loadMore()} disabled={gallery.loadingMore}>
                {gallery.loadingMore ? "loading…" : "Load more"}
              </Button>
            </>
          )}
        </div>
      </div>

      {lightbox !== null && (
        <VideoLightbox
          client={client}
          asset={lightbox}
          nav={lightboxNav}
          onStep={stepLightbox}
          onClose={() => setLightbox(null)}
        />
      )}
      {editingTags !== null && (
        <EditTagsModal
          asset={editingTags}
          suggestions={tagOptions}
          onSave={(next) => void saveTags(editingTags, next)}
          onClose={() => setEditingTags(null)}
        />
      )}
      {pickerSlot !== null && (
        <MediaAssetPicker
          client={client}
          accepts={pickerSlot.accepts}
          onPick={(asset) => {
            addInput(pickerSlot.role, { role: pickerSlot.role, assetId: asset.id });
            setPickerSlot(null);
          }}
          onClose={() => setPickerSlot(null)}
        />
      )}
      {pendingDelete !== null && (
        <ConfirmDialog
          open
          title="Delete video?"
          body="This removes the video file and its metadata. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => {
            void deleteVideo(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {errorJob !== null && (
        <VideoErrorJobModal
          job={errorJob}
          onRetry={(j) => {
            void retryJob(j);
            setErrorJob(null);
          }}
          onClose={() => setErrorJob(null)}
        />
      )}
      {providersLoaded && providers.length === 0 && (
        <Banner tone="info" title="Offline stub">
          No video provider connected — using the offline stub. Add a key in Settings → Video
          Generation to generate real clips.
        </Banner>
      )}
    </div>
  );
}

/** The selected model's full workflow/pricing summary. */
function VideoModelInfo({ model }: { model: VideoModelInfo }) {
  return (
    <StatRow className="media-model-info" ariaLabel="Model information">
      <Stat label="Model" value={model.label ?? model.id} />
      <span className="stat stat-stack">
        <span className="stat-label">Workflows</span>
        <span className="stat-value media-rate-tags">
          {model.workflows.map((w) => (
            <Chip key={w} size="sm">
              {w}
            </Chip>
          ))}
        </span>
      </span>
      {model.rates?.map((rate) => (
        <Stat key={rate.label} label={rate.label} value={rate.value} />
      ))}
    </StatRow>
  );
}

function acceptFor(accepts: string[]): string {
  const map: Record<string, string> = {
    image: "image/png,image/jpeg,image/webp,image/gif",
    video: "video/mp4,video/webm,video/quicktime",
    audio: "audio/mpeg,audio/wav,audio/mp4,audio/ogg",
  };
  return accepts.map((k) => map[k] ?? "").join(",");
}

function UrlInput({ label, onAdd }: { label: string; onAdd: (url: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <span className="video-url-input">
      <TextInput
        value={value}
        placeholder="Paste URL"
        aria-label={`${label} URL`}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={!/^https?:\/\//.test(value.trim())}
        onClick={() => {
          onAdd(value.trim());
          setValue("");
        }}
      >
        Add
      </Button>
    </span>
  );
}

/** Job input, loosely parsed for the placeholder card's settings line. */
function videoJobRequest(job: Job): { workflow?: string; prompt?: string; model?: string; resolution?: string } {
  const input = (typeof job.input === "object" && job.input !== null ? job.input : {}) as Record<string, unknown>;
  const params = (typeof input.params === "object" && input.params !== null ? input.params : {}) as Record<string, unknown>;
  return {
    ...(typeof input.workflow === "string" ? { workflow: input.workflow } : {}),
    ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    ...(typeof params.resolution === "string" ? { resolution: params.resolution } : {}),
  };
}

/** The in-flight / failed placeholder card (image-gallery parity). */
function VideoJobCard({
  job,
  onRetry,
  onOpenError,
}: {
  job: Job;
  onRetry: (job: Job) => void;
  onOpenError: (job: Job) => void;
}) {
  const failed = job.status === "error";
  const request = videoJobRequest(job);
  const trailing = request.resolution ?? request.model;
  return (
    <div
      className={
        failed
          ? "image-card image-card-job video-card-job failed"
          : "image-card image-card-job video-card-job"
      }
    >
      {/* @ui-raw: bespoke card media surface */}
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
        <DropdownMenu
          className="image-card-menu-btn"
          ariaLabel="Generation actions"
          align="end"
          button={<MoreVertical size={15} aria-hidden="true" />}
          items={[
            { label: "Retry", icon: <RotateCcw size={13} aria-hidden="true" />, onSelect: () => onRetry(job) },
          ]}
        />
      )}
      <div className="image-card-body">
        <div className="image-card-meta">
          <span className="image-card-mode">
            {request.workflow !== undefined ? request.workflow.toUpperCase() : "VIDEO"}
            {request.resolution !== undefined ? ` · ${request.resolution}` : ""}
          </span>
          {trailing !== undefined && (
            <span className="image-card-dims" title={trailing}>
              {trailing}
            </span>
          )}
        </div>
        {request.prompt !== undefined && request.prompt.length > 0 && (
          <p className="image-card-job-prompt" title={request.prompt}>
            {request.prompt}
          </p>
        )}
        {!failed && job.note !== undefined && <p className="image-card-job-note">{job.note}</p>}
      </div>
    </div>
  );
}

/** The failed job's full error, shown in a modal (never on the card). */
function VideoErrorJobModal({
  job,
  onRetry,
  onClose,
}: {
  job: Job;
  onRetry: (job: Job) => void;
  onClose: () => void;
}) {
  const request = videoJobRequest(job);
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
      {request.prompt !== undefined && request.prompt.length > 0 && (
        <p className="image-error-prompt">{request.prompt}</p>
      )}
      <pre className="image-error-detail">{job.error ?? "Unknown error"}</pre>
    </Modal>
  );
}

function VideoCard({
  client,
  asset,
  onOpen,
  onLoad,
  onEditTags,
  onDelete,
  onOpenChat,
}: {
  client: BaiClient;
  asset: Asset;
  onOpen: () => void;
  onLoad: () => void;
  onEditTags: () => void;
  onDelete: () => void;
  onOpenChat?: (sessionId: string) => void;
}) {
  const [cardRef, inView] = useInView<HTMLDivElement>();
  const hasPoster = typeof asset.meta["posterPath"] === "string";
  const poster = useVideoPoster(client, asset.id, inView, hasPoster);
  const gen = readVideoGen(asset.meta);
  const workflow =
    gen?.workflow ??
    (typeof asset.meta.workflow === "string" ? (asset.meta.workflow as VideoWorkflow) : undefined);
  const resolution = typeof asset.meta.resolution === "string" ? asset.meta.resolution : undefined;
  const duration =
    typeof asset.meta.durationSeconds === "number" ? Math.round(asset.meta.durationSeconds) : undefined;
  const width = typeof asset.meta.width === "number" ? asset.meta.width : undefined;
  const height = typeof asset.meta.height === "number" ? asset.meta.height : undefined;
  const cost = typeof asset.meta.costUsd === "number" ? asset.meta.costUsd : undefined;
  const sessionId =
    typeof asset.meta.sessionId === "string" && asset.meta.sessionId.length > 0
      ? asset.meta.sessionId
      : undefined;
  const tags = gen?.tags ?? [];
  const roles = [...new Set((gen?.inputs ?? []).map((i) => i.role))];

  // The settings used, shown at the card's foot (image-gallery parity).
  const settings: string[] = [];
  if (gen?.model !== undefined) settings.push(gen.model);
  if (typeof asset.meta.provider === "string") settings.push(asset.meta.provider);
  const params = gen?.params ?? {};
  if (typeof params.seed === "number") settings.push(`seed ${params.seed}`);
  if (typeof params.aspect_ratio === "string") settings.push(params.aspect_ratio);
  if (typeof params.generate_audio === "boolean") settings.push(params.generate_audio ? "audio" : "no audio");
  const settingsLine = settings.join(" · ");

  return (
    <div className="image-card" ref={cardRef}>
      {/* @ui-raw: bespoke card media surface (thumbnail + play/duration overlay). */}
      <button
        type="button"
        className="image-card-media video-card-media"
        onClick={onOpen}
        title="View video"
      >
        {poster !== undefined ? (
          <img src={poster} alt="" loading="lazy" />
        ) : (
          <span className="image-card-placeholder" />
        )}
        <span
          className={poster === undefined ? "video-card-play no-poster" : "video-card-play"}
          aria-hidden="true"
        >
          <Play size={20} />
        </span>
        {duration !== undefined && <span className="video-card-duration">{duration}s</span>}
      </button>
      <DropdownMenu
        className="image-card-menu-btn"
        ariaLabel="Video actions"
        align="end"
        button={<MoreVertical size={15} aria-hidden="true" />}
        items={[
          ...(sessionId !== undefined && onOpenChat !== undefined
            ? [
                {
                  label: "Open chat",
                  icon: <MessageSquare size={13} aria-hidden="true" />,
                  onSelect: () => onOpenChat(sessionId),
                },
              ]
            : []),
          {
            label: "Download",
            icon: <Download size={13} aria-hidden="true" />,
            onSelect: () => void downloadAsset(client, asset),
          },
          {
            label: "Load Inputs",
            icon: <SlidersHorizontal size={13} aria-hidden="true" />,
            onSelect: onLoad,
          },
          { label: "Edit Tags", icon: <Tags size={13} aria-hidden="true" />, onSelect: onEditTags },
          {
            label: "Delete",
            icon: <Trash2 size={13} aria-hidden="true" />,
            danger: true,
            onSelect: onDelete,
          },
        ]}
      />
      <div className="image-card-body">
        <div className="image-card-meta">
          <span className="image-card-mode">
            {workflow !== undefined ? VIDEO_WORKFLOW_LABELS[workflow] : "VIDEO"}
            {resolution !== undefined ? ` · ${resolution}` : ""}
          </span>
          {width !== undefined && height !== undefined && (
            <span className="image-card-dims">
              {width}×{height}
            </span>
          )}
          {duration !== undefined && <span className="image-card-dims">{duration}s</span>}
          {cost !== undefined && <span className="image-card-cost">{formatCost(cost)}</span>}
        </div>
        {(workflow !== undefined || roles.length > 0) && (
          <div className="image-card-tags">
            {workflow !== undefined && <Chip>{workflow}</Chip>}
            {roles.map((role) => (
              <Chip key={role}>{role.replace(/_/g, " ")}</Chip>
            ))}
          </div>
        )}
        {tags.length > 0 && (
          <div className="image-card-tags">
            {tags.map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
          </div>
        )}
        {settingsLine.length > 0 && (
          <p className="video-card-settings" title={settingsLine}>
            {settingsLine}
          </p>
        )}
      </div>
    </div>
  );
}

async function downloadAsset(client: BaiClient, asset: Asset): Promise<void> {
  try {
    const res = await client.assetContent(asset.id);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${asset.id}.${asset.mime.split("/")[1] ?? "mp4"}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // advisory
  }
}

function VideoLightbox({
  client,
  asset,
  nav,
  onStep,
  onClose,
}: {
  client: BaiClient;
  asset: Asset;
  nav: ReturnType<typeof galleryNavState>;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const url = useAssetUrl(client, asset.id);
  return (
    <Modal open title="Video" size="lg" onClose={onClose}>
      <div className="video-lightbox">
        {nav?.hasPrevious === true && (
          <IconButton label="Previous" hint="Previous" className="video-lightbox-nav prev" onClick={() => onStep(-1)}>
            ‹
          </IconButton>
        )}
        {url !== undefined ? <video className="video-lightbox-video" src={url} controls autoPlay playsInline /> : <LoaderCircle className="icon-spin" />}
        {nav?.hasNext === true && (
          <IconButton label="Next" hint="Next" className="video-lightbox-nav next" onClick={() => onStep(1)}>
            ›
          </IconButton>
        )}
      </div>
      {nav !== undefined && (
        <p className="dim video-lightbox-count">
          {nav.index + 1} / {nav.total}
        </p>
      )}
    </Modal>
  );
}

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
  const [tags, setTags] = useState<string[]>(() => readVideoGen(asset.meta)?.tags ?? []);
  return (
    <Modal
      open
      title="Edit tags"
      onClose={onClose}
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
