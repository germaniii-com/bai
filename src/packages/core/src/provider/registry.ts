import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream } from "./types";

/** Registry of providers; resolves "provider/model" catalog ids. */
export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  register(provider: Provider): void {
    this.providers.set(provider.name(), provider);
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }

  /** Resolve "provider/model" → concrete provider + vendor model id. */
  resolveModel(modelId: string): { provider: Provider; model: string } {
    const idx = modelId.indexOf("/");
    const providerName = idx >= 0 ? modelId.slice(0, idx) : modelId;
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown provider in model id "${modelId}"`);
    }
    return { provider, model: idx >= 0 ? modelId.slice(idx + 1) : modelId };
  }

  async allModels(): Promise<ModelInfo[]> {
    const lists = await Promise.all(this.list().map((p) => p.models()));
    return lists.flat();
  }
}

export type { LlmRequest, Provider, ProviderStream };
