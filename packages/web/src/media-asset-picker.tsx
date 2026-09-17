import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Asset, MediaKind } from "@bai/shared";
import { Modal, Spinner } from "./components";
import { useAssetUrl } from "./attachments";
import { useVideoPoster } from "./use-video-poster";

/**
 * A modal picker over stored assets, filtered to the kinds a video workflow
 * input accepts. Choosing an asset returns it verbatim (the caller stores an
 * `ast_…` id on the input). Uploads and hosted URLs are handled by the caller.
 */
export function MediaAssetPicker({
  client,
  accepts,
  onPick,
  onClose,
}: {
  client: BaiClient;
  accepts: MediaKind[];
  onPick: (asset: Asset) => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await client.listAssets({ limit: 200 });
        if (!cancelled) setAssets(all.filter((a) => accepts.includes(a.kind as MediaKind)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, accepts]);

  return (
    <Modal open title="Pick an asset" size="lg" onClose={onClose}>
      {error !== null ? (
        <p className="dim">{error}</p>
      ) : assets === null ? (
        <Spinner />
      ) : assets.length === 0 ? (
        <p className="dim empty">No stored assets yet — upload a file or paste a URL instead.</p>
      ) : (
        <div className="asset-picker-grid">
          {assets.map((asset) => (
            // @ui-raw: bespoke asset tile (thumbnail + name + kind, no Button look).
            <button key={asset.id} type="button" className="asset-picker-item" onClick={() => onPick(asset)}>
              <AssetThumb client={client} asset={asset} />
              <span className="asset-picker-name">
                {typeof asset.meta.prompt === "string" && asset.meta.prompt.length > 0
                  ? asset.meta.prompt.slice(0, 40)
                  : asset.id.slice(-6)}
              </span>
              <span className="asset-picker-kind">{asset.kind}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function AssetThumb({ client, asset }: { client: BaiClient; asset: Asset }) {
  // Video cards show the extracted poster still — never a <video> element
  // outside the full-screen modal.
  if (asset.kind === "video") return <VideoAssetThumb client={client} asset={asset} />;
  return <BinaryAssetThumb client={client} asset={asset} />;
}

function VideoAssetThumb({ client, asset }: { client: BaiClient; asset: Asset }) {
  const hasPoster = typeof asset.meta["posterPath"] === "string";
  const poster = useVideoPoster(client, asset.id, true, hasPoster);
  if (poster === undefined) return <div className="asset-picker-thumb asset-picker-audio">video</div>;
  return <img className="asset-picker-thumb" src={poster} alt="" />;
}

function BinaryAssetThumb({ client, asset }: { client: BaiClient; asset: Asset }) {
  const url = useAssetUrl(client, asset.id);
  if (asset.kind === "audio") {
    return <div className="asset-picker-thumb asset-picker-audio">audio</div>;
  }
  if (url === undefined) return <div className="asset-picker-thumb" />;
  return <img className="asset-picker-thumb" src={url} alt="" />;
}
