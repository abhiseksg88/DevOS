"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  HardDrive,
  File,
  Upload,
  Trash2,
  Download,
  RefreshCw,
  Loader2,
  FolderOpen,
} from "lucide-react";

interface StorageBrowserProps {
  projectId: string;
}

interface StorageFile {
  name: string;
  id: string;
  created_at: string;
  updated_at: string;
  metadata: {
    size: number;
    mimetype: string;
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function StorageBrowser({ projectId }: StorageBrowserProps) {
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const bucket = "project-assets";
  const prefix = `${projectId}/`;

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    try {
      const { data, error: listError } = await supabase.storage
        .from(bucket)
        .list(projectId, { limit: 100, sortBy: { column: "created_at", order: "desc" } });

      if (listError) throw new Error(listError.message);
      setFiles((data ?? []) as unknown as StorageFile[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to list files");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    const supabase = createClient();

    try {
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(`${projectId}/${file.name}`, file, { upsert: true });

      if (uploadError) throw new Error(uploadError.message);
      await fetchFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }, [projectId, fetchFiles]);

  const handleDelete = useCallback(async (fileName: string) => {
    const supabase = createClient();
    const { error: delError } = await supabase.storage
      .from(bucket)
      .remove([`${projectId}/${fileName}`]);

    if (delError) {
      setError(delError.message);
      return;
    }

    setFiles((prev) => prev.filter((f) => f.name !== fileName));
  }, [projectId]);

  const handleDownload = useCallback(async (fileName: string) => {
    const supabase = createClient();
    const { data } = await supabase.storage
      .from(bucket)
      .createSignedUrl(`${projectId}/${fileName}`, 60);

    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
    }
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-3">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-brand-400" />
          <span className="text-sm font-medium text-foreground">Storage</span>
          <span className="text-xs text-slate-500">{files.length} files</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500/10 border border-brand-500/20 text-brand-400 text-xs font-medium hover:bg-brand-500/20 transition-all cursor-pointer">
            {uploading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Upload className="w-3 h-3" />
            )}
            Upload
            <input
              type="file"
              className="hidden"
              onChange={handleUpload}
              disabled={uploading}
            />
          </label>
          <button
            onClick={fetchFiles}
            className="p-1.5 rounded-md text-slate-400 hover:text-foreground hover:bg-surface-2 transition-all"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-auto">
        {files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-500">
            <FolderOpen className="w-10 h-10 mb-4 text-slate-600" />
            <p className="text-sm font-medium mb-1">No files uploaded</p>
            <p className="text-xs text-slate-600 text-center max-w-xs">
              Upload files for your project. They&apos;ll be stored in Supabase Storage.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-surface-3/50">
            {files.map((file) => (
              <div
                key={file.name}
                className="flex items-center justify-between px-4 py-3 hover:bg-surface-1/50 transition-all group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-surface-2 border border-surface-3 flex items-center justify-center shrink-0">
                    <File className="w-4 h-4 text-slate-400" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-foreground truncate">{file.name}</p>
                    <p className="text-2xs text-slate-500">
                      {file.metadata?.size ? formatBytes(file.metadata.size) : "—"}
                      {" · "}
                      {file.metadata?.mimetype || "unknown"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleDownload(file.name)}
                    className="p-1.5 rounded-md text-slate-400 hover:text-foreground hover:bg-surface-2 transition-all"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(file.name)}
                    className="p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
