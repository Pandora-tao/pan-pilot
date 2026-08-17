import { Download, FileAudio, FileCode, FileImage, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiClient, downloadBlob, readError } from "../../api";
import { downloadFileName } from "../../download-name";

const NAME_CACHE = new Map<string, Promise<string | null>>();

interface FileLinkProps {
  /** /v1/artifacts/{id} 或 /v1/media/{id} 的受控下载路径。 */
  url: string;
  client: ApiClient;
  toast: (message: string) => void;
}

/**
 * 生成文件链接（代码产物 / Office 文档等）的可下载 chip：
 * 图标 + 真实文件名；悬停（或键盘聚焦）出现「下载」按钮，点击 chip 或按钮均下载到本地。
 * 文件名经一次 HEAD 请求解析，失败时退化为通用名。
 */
export function FileLink({ url, client, toast }: FileLinkProps) {
  const isArtifact = url.startsWith("/v1/artifacts/");
  const fallback = isArtifact ? "代码产物" : "文档";
  const [name, setName] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void resolveFileName(url, client).then((resolved) => {
      if (!cancelled && resolved) setName(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [client, url]);

  const displayName = name ?? fallback;

  async function download() {
    if (busyRef.current) return;
    busyRef.current = true;
    setDownloading(true);
    try {
      const response = await client.request(url);
      if (!response.ok) throw new Error(await readError(response));
      downloadBlob(await response.blob(), name ?? fallback);
    } catch (error) {
      toast("下载失败：" + errorMessage(error));
    } finally {
      busyRef.current = false;
      setDownloading(false);
    }
  }

  const Icon = fileIcon(url, name);

  return (
    <span className="file-chip">
      <button
        className="file-chip-main"
        type="button"
        title={`下载 ${displayName}`}
        onClick={() => void download()}
      >
        <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
        <span className="file-chip-name">{displayName}</span>
      </button>
      <button
        className="file-chip-download"
        type="button"
        title="下载"
        aria-label={`下载 ${displayName}`}
        onClick={() => void download()}
      >
        {downloading ? (
          <span className="chip-spinner" aria-hidden="true" />
        ) : (
          <Download aria-hidden="true" size={13} />
        )}
      </button>
    </span>
  );
}

/** 按文件类型选图标：代码产物用代码图标，媒体按扩展名区分图片/音频/常规文档。 */
function fileIcon(url: string, name: string | null): typeof FileText {
  const lower = (name ?? "").toLowerCase();
  if (url.startsWith("/v1/media/")) {
    if (/\.(png|jpe?g|webp|gif|svg|bmp)$/.test(lower)) return FileImage;
    if (/\.(mp3|wav|ogg|m4a|flac|aac)$/.test(lower)) return FileAudio;
    return FileText;
  }
  return FileCode;
}

/** HEAD 解析真实文件名；同一 URL 只请求一次（成功或失败均缓存）。 */
function resolveFileName(url: string, client: ApiClient): Promise<string | null> {
  const cached = NAME_CACHE.get(url);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const response = await client.request(url, { method: "HEAD" });
      if (!response.ok) return null;
      const fallback = url.startsWith("/v1/artifacts/") ? "代码产物" : "文档";
      return downloadFileName(response, fallback);
    } catch {
      return null;
    }
  })();
  NAME_CACHE.set(url, promise);
  return promise;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
