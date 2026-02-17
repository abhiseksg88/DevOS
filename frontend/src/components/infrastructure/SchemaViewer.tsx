"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Settings, Loader2, Table2, Hash, Type, Calendar, ToggleLeft } from "lucide-react";

interface SchemaViewerProps {
  projectId: string;
  tenantId: string;
}

interface FieldSchema {
  name: string;
  type: string;
  sample: string;
  count: number;
}

interface CollectionSchema {
  collection: string;
  rowCount: number;
  fields: FieldSchema[];
}

function inferType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "datetime";
    if (/^[a-f0-9-]{36}$/i.test(value)) return "uuid";
    return "string";
  }
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
}

const typeIcons: Record<string, typeof Hash> = {
  string: Type,
  integer: Hash,
  float: Hash,
  boolean: ToggleLeft,
  datetime: Calendar,
  uuid: Hash,
};

export function SchemaViewer({ projectId, tenantId }: SchemaViewerProps) {
  const [schemas, setSchemas] = useState<CollectionSchema[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const analyzeSchema = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    try {
      const { data, error: fetchError } = await supabase
        .from("app_data")
        .select("collection, data")
        .eq("project_id", projectId)
        .limit(500);

      if (fetchError) throw new Error(fetchError.message);

      // Group by collection and analyze fields
      const collMap = new Map<string, Record<string, unknown>[]>();
      for (const row of data ?? []) {
        if (!collMap.has(row.collection)) collMap.set(row.collection, []);
        collMap.get(row.collection)!.push(row.data as Record<string, unknown>);
      }

      const result: CollectionSchema[] = [];
      for (const [collection, rows] of collMap.entries()) {
        const fieldMap = new Map<string, { types: Set<string>; sample: unknown; count: number }>();

        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          for (const [key, value] of Object.entries(row)) {
            if (!fieldMap.has(key)) {
              fieldMap.set(key, { types: new Set(), sample: value, count: 0 });
            }
            const field = fieldMap.get(key)!;
            field.types.add(inferType(value));
            field.count++;
            if (field.sample === null || field.sample === undefined) {
              field.sample = value;
            }
          }
        }

        const fields: FieldSchema[] = Array.from(fieldMap.entries())
          .map(([name, info]) => ({
            name,
            type: Array.from(info.types).join(" | "),
            sample: typeof info.sample === "object"
              ? JSON.stringify(info.sample).slice(0, 50)
              : String(info.sample ?? "").slice(0, 50),
            count: info.count,
          }))
          .sort((a, b) => b.count - a.count);

        result.push({
          collection,
          rowCount: rows.length,
          fields,
        });
      }

      setSchemas(result.sort((a, b) => a.collection.localeCompare(b.collection)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze schema");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    analyzeSchema();
  }, [analyzeSchema]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-3">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-brand-400" />
          <span className="text-sm font-medium text-white">Schema Inspector</span>
        </div>
        <button
          onClick={analyzeSchema}
          className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
        >
          Re-analyze
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          {error}
        </div>
      )}

      {schemas.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
          <Settings className="w-10 h-10 mb-4 text-slate-600" />
          <p className="text-sm font-medium mb-1">No schema to display</p>
          <p className="text-xs text-slate-600 text-center max-w-xs">
            Schema is inferred from stored data. Add some data to see the schema.
          </p>
        </div>
      ) : (
        <div className="p-4 space-y-6">
          {schemas.map((schema) => (
            <div
              key={schema.collection}
              className="rounded-xl border border-surface-3/50 bg-surface-1/30 overflow-hidden"
            >
              {/* Collection header */}
              <div className="flex items-center gap-3 px-4 py-3 bg-surface-2/30 border-b border-surface-3/50">
                <Table2 className="w-4 h-4 text-brand-400" />
                <span className="text-sm font-semibold text-white">{schema.collection}</span>
                <span className="text-xs text-slate-500">{schema.rowCount} rows</span>
                <span className="text-xs text-slate-600">{schema.fields.length} fields</span>
              </div>

              {/* Fields table */}
              <div className="divide-y divide-surface-3/30">
                <div className="grid grid-cols-[1fr_120px_1fr] gap-4 px-4 py-2 text-2xs text-slate-500 uppercase tracking-wider font-medium">
                  <span>Field</span>
                  <span>Type</span>
                  <span>Sample</span>
                </div>
                {schema.fields.map((field) => {
                  const Icon = typeIcons[field.type.split(" | ")[0]] || Hash;
                  return (
                    <div
                      key={field.name}
                      className="grid grid-cols-[1fr_120px_1fr] gap-4 px-4 py-2.5 text-xs hover:bg-surface-2/20"
                    >
                      <div className="flex items-center gap-2">
                        <Icon className="w-3 h-3 text-slate-500" />
                        <span className="font-mono text-white">{field.name}</span>
                      </div>
                      <span className="font-mono text-brand-400/80">{field.type}</span>
                      <span className="text-slate-400 truncate font-mono">{field.sample}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
