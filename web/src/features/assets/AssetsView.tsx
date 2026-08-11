import {
  Copy,
  Download,
  FileText,
  MessageSquare,
  Paperclip,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { ApiClient, downloadBlob, readError } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import { ViewHeader } from "../../components/ViewHeader";
import type { FileAsset, MediaAsset } from "../../types";

interface AssetsViewProps {
  client: ApiClient;
  files: FileAsset[];
  media: MediaAsset[];
  selectedMediaIds: Set<string>;
  onFilesChange: (files: FileAsset[]) => void;
  onMediaChange: (media: MediaAsset[]) => void;
  onToggleMedia: (mediaId: string) => void;
  onUseDocument: (fileId: string) => void;
  toast: (message: string) => void;
}

export function AssetsView({
  client,
  files,
  media,
  selectedMediaIds,
  onFilesChange,
  onMediaChange,
  onToggleMedia,
  onUseDocument,
  toast,
}: AssetsViewProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function uploadDocument() {
    if (!selectedFile) return;
    setUploadingFile(true);
    try {
      const uploaded = await client.uploadFile(selectedFile);
      onFilesChange([uploaded, ...files]);
      setSelectedFile(null);
      if (fileInput.current) fileInput.current.value = "";
      toast("Word 文档上传成功");
    } catch (error) {
      toast("上传失败：" + errorMessage(error));
    } finally {
      setUploadingFile(false);
    }
  }

  async function uploadMedia(file: File) {
    setUploadingMedia(true);
    try {
      const uploaded = await client.uploadMedia(file);
      onMediaChange([uploaded, ...media]);
      onToggleMedia(uploaded.mediaId);
      toast("媒体已上传并添加到对话");
    } catch (error) {
      toast("上传失败：" + errorMessage(error));
    } finally {
      setUploadingMedia(false);
      if (mediaInput.current) mediaInput.current.value = "";
    }
  }

  async function download(path: string, name: string) {
    try {
      const response = await client.request(path);
      if (!response.ok) throw new Error(await readError(response));
      downloadBlob(await response.blob(), name);
    } catch (error) {
      toast("下载失败：" + errorMessage(error));
    }
  }

  async function deleteMedia(item: MediaAsset) {
    if (confirmDelete !== item.mediaId) {
      setConfirmDelete(item.mediaId);
      window.setTimeout(() => setConfirmDelete((current) => (
        current === item.mediaId ? null : current
      )), 8000);
      return;
    }
    try {
      await client.deleteMedia(item.mediaId);
      onMediaChange(media.filter((candidate) => candidate.mediaId !== item.mediaId));
      if (selectedMediaIds.has(item.mediaId)) onToggleMedia(item.mediaId);
      setConfirmDelete(null);
      toast("媒体已删除");
    } catch (error) {
      toast("删除失败：" + errorMessage(error));
    }
  }

  return (
    <section className="view active">
      <ViewHeader
        number="02"
        title="文件与媒体"
        description="管理当前页面会话上传的 Word 文档、图片和音频，并将媒体加入对话。"
      />

      <div className="section-stack">
        <section className="surface">
          <div className="section-head">
            <FileText aria-hidden="true" size={18} />
            <h3>Word 文档</h3>
            <p>支持 .docx，最大 10MB；上传后可复制 fileId、下载或填入聊天框。</p>
          </div>
          <div className="section-body">
            <div className="upload-zone">
              <div>
                <strong>{selectedFile?.name ?? "未选择文件"}</strong>
                <span className="upload-note">
                  {selectedFile ? formatSize(selectedFile.size) : "选择本地 Word 文档后再上传。"}
                </span>
              </div>
              <div className="item-actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".docx"
                  hidden
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                />
                <button type="button" onClick={() => fileInput.current?.click()}>
                  选择文件
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={!selectedFile || uploadingFile}
                  onClick={() => void uploadDocument()}
                >
                  <Upload aria-hidden="true" size={16} />
                  {uploadingFile ? "上传中" : "上传"}
                </button>
              </div>
            </div>
          </div>
          {files.length ? (
            <div className="record-list">
              {files.map((item) => (
                <div className="record-item" key={item.fileId}>
                  <div>
                    <div className="record-name">{item.name}</div>
                    <div className="record-meta">{formatSize(item.size)} · {item.fileId}</div>
                  </div>
                  <div className="item-actions">
                    <button
                      className="small"
                      type="button"
                      onClick={() => void copyText(item.fileId, toast)}
                    >
                      <Copy aria-hidden="true" size={14} />复制 ID
                    </button>
                    <button className="small" type="button" onClick={() => onUseDocument(item.fileId)}>
                      <MessageSquare aria-hidden="true" size={14} />填入对话
                    </button>
                    <button
                      className="small primary"
                      type="button"
                      onClick={() => void download(`/v1/files/${item.fileId}`, item.name)}
                    >
                      <Download aria-hidden="true" size={14} />下载
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-tip">当前页面会话还没有 Word 上传记录。</div>
          )}
        </section>

        <section className="surface">
          <div className="section-head">
            <Paperclip aria-hidden="true" size={18} />
            <h3>图片与音频</h3>
            <p>支持 png、jpg、jpeg、webp、gif、mp3、wav，最大 10MB。</p>
            <input
              ref={mediaInput}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadMedia(file);
              }}
            />
            <button
              className="primary"
              type="button"
              disabled={uploadingMedia}
              onClick={() => mediaInput.current?.click()}
            >
              <Upload aria-hidden="true" size={16} />
              {uploadingMedia ? "上传中" : "上传媒体"}
            </button>
          </div>
          {media.length ? (
            <div className="record-list">
              {media.map((item) => {
                const attached = selectedMediaIds.has(item.mediaId);
                return (
                  <div className="record-item" key={item.mediaId}>
                    <div>
                      <div className="record-name">
                        {item.name}
                        <StatusBadge
                          status={item.kind === "image" ? "available" : "reserved"}
                          label={item.kind === "image" ? "图片" : "音频"}
                        />
                      </div>
                      <div className="record-meta">
                        {formatSize(item.size)} · {item.mimeType} · {item.mediaId}
                      </div>
                    </div>
                    <div className="item-actions">
                      <button
                        className={`small ${attached ? "primary" : ""}`}
                        type="button"
                        onClick={() => onToggleMedia(item.mediaId)}
                      >
                        <MessageSquare aria-hidden="true" size={14} />
                        {attached ? "已添加" : "添加到对话"}
                      </button>
                      <button
                        className="small"
                        type="button"
                        onClick={() => void download(`/v1/media/${item.mediaId}`, item.name)}
                      >
                        <Download aria-hidden="true" size={14} />下载
                      </button>
                      <button
                        className="small danger"
                        type="button"
                        onClick={() => void deleteMedia(item)}
                      >
                        <Trash2 aria-hidden="true" size={14} />
                        {confirmDelete === item.mediaId ? "再次点击删除" : "删除"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-tip">当前页面会话还没有媒体上传记录。</div>
          )}
        </section>
      </div>
    </section>
  );
}

async function copyText(text: string, toast: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    toast("ID 已复制");
  } catch {
    toast("复制失败，请手动选择");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
