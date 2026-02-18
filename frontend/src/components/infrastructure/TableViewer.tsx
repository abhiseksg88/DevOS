"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  RefreshCw,
  Plus,
  Trash2,
  ChevronRight,
  Loader2,
  Table2,
  ArrowLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TableViewerProps {
  projectId: string;
  tenantId: string;
}

interface CollectionInfo {
  collection: string;
  count: number;
}

interface DataRow {
  id: string;
  collection: string;
  record_id: string;
  data: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export function TableViewer({ projectId, tenantId }: TableViewerProps) {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [rows, setRows] = useState<DataRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowLoading, setRowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch collections
  const fetchCollections = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    try {
      const { data, error: fetchError } = await supabase
        .from("app_data")
        .select("collection")
        .eq("project_id", projectId);

      if (fetchError) throw new Error(fetchError.message);

      // Group by collection and count
      const collMap = new Map<string, number>();
      for (const row of data ?? []) {
        collMap.set(row.collection, (collMap.get(row.collection) ?? 0) + 1);
      }

      const result: CollectionInfo[] = Array.from(collMap.entries())
        .map(([collection, count]) => ({ collection, count }))
        .sort((a, b) => a.collection.localeCompare(b.collection));

      setCollections(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load collections");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Fetch rows for a collection
  const fetchRows = useCallback(async (collection: string) => {
    setRowLoading(true);
    const supabase = createClient();

    try {
      const { data, error: fetchError } = await supabase
        .from("app_data")
        .select("*")
        .eq("project_id", projectId)
        .eq("collection", collection)
        .order("created_at", { ascending: false })
        .limit(100);

      if (fetchError) throw new Error(fetchError.message);
      setRows((data ?? []) as DataRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rows");
    } finally {
      setRowLoading(false);
    }
  }, [projectId]);

  // Delete a row
  const deleteRow = useCallback(async (id: string) => {
    const supabase = createClient();
    const { error: delError } = await supabase
      .from("app_data")
      .delete()
      .eq("id", id);

    if (delError) {
      setError(delError.message);
      return;
    }

    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  useEffect(() => {
    if (selectedCollection) {
      fetchRows(selectedCollection);
    }
  }, [selectedCollection, fetchRows]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
      </div>
    );
  }

  // Collection detail view
  if (selectedCollection) {
    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-3">
          <button
            onClick={() => {
              setSelectedCollection(null);
              setRows([]);
            }}
            className="p-1 rounded-md text-slate-400 hover:text-foreground hover:bg-surface-2 transition-all"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Table2 className="w-4 h-4 text-brand-400" />
          <span className="text-sm font-medium text-foreground">{selectedCollection}</span>
          <span className="text-xs text-slate-500 ml-auto">{rows.length} rows</span>
          <button
            onClick={() => fetchRows(selectedCollection)}
            className="p-1.5 rounded-md text-slate-400 hover:text-foreground hover:bg-surface-2 transition-all"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-auto">
          {rowLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-500">
              <Table2 className="w-8 h-8 mb-3 text-slate-600" />
              <p className="text-sm">No data in this collection</p>
            </div>
          ) : (
            <div className="divide-y divide-surface-3">
              {rows.map((row) => (
                <div key={row.id} className="px-4 py-3 hover:bg-surface-1/50 group">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-slate-400">{row.record_id}</span>
                        <span className="text-2xs text-slate-600">v{row.version}</span>
                      </div>
                      <pre className="text-xs text-slate-300 font-mono bg-surface-2/50 rounded-lg p-3 overflow-x-auto max-h-32">
                        {JSON.stringify(row.data, null, 2)}
                      </pre>
                      <span className="text-2xs text-slate-600 mt-1 block">
                        {new Date(row.created_at).toLocaleString()}
                      </span>
                    </div>
                    <button
                      onClick={() => deleteRow(row.id)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
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

  // Collections list view
  return (
    <div className="h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-3">
        <div className="flex items-center gap-2">
          <Table2 className="w-4 h-4 text-brand-400" />
          <span className="text-sm font-medium text-foreground">Data Collections</span>
        </div>
        <button
          onClick={fetchCollections}
          className="p-1.5 rounded-md text-slate-400 hover:text-foreground hover:bg-surface-2 transition-all"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          {error}
        </div>
      )}

      {collections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
          <Table2 className="w-10 h-10 mb-4 text-slate-600" />
          <p className="text-sm font-medium mb-1">No data yet</p>
          <p className="text-xs text-slate-600 text-center max-w-xs">
            When your app stores data using Supabase, collections will appear here.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-surface-3/50">
          {collections.map(({ collection, count }) => (
            <button
              key={collection}
              onClick={() => setSelectedCollection(collection)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-1/50 transition-all text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center justify-center">
                  <Table2 className="w-4 h-4 text-brand-400" />
                </div>
                <div>
                  <span className="text-sm font-medium text-foreground">{collection}</span>
                  <span className="text-xs text-slate-500 ml-2">{count} rows</span>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-slate-400 transition-colors" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
