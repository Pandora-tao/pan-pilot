import type { ChatModelOption, ModelsResponse } from "./types.js";

/** 保存值失效时回到服务端默认；默认不可用时再取首个可用项。 */
export function chooseModelId(
  catalog: ModelsResponse,
  storedModelId: string,
): string {
  if (isAvailable(catalog.models, storedModelId)) return storedModelId;
  if (isAvailable(catalog.models, catalog.defaultModelId)) {
    return catalog.defaultModelId;
  }
  return catalog.models.find(({ status }) => status === "available")?.id ?? "";
}

export function modelDisplayLabel(
  catalog: ModelsResponse | null,
  modelId: string | undefined,
): string {
  if (!modelId) return "";
  return catalog?.models.find(({ id }) => id === modelId)?.label ?? modelId;
}

function isAvailable(models: ChatModelOption[], modelId: string): boolean {
  return models.some(({ id, status }) => id === modelId && status === "available");
}
