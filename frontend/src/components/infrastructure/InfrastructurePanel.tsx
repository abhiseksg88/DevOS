"use client";

import { useState } from "react";
import { Database, HardDrive, Table2, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { TableViewer } from "./TableViewer";
import { StorageBrowser } from "./StorageBrowser";
import { SchemaViewer } from "./SchemaViewer";

type InfraTab = "tables" | "storage" | "schema";

interface InfrastructurePanelProps {
  projectId: string;
  tenantId: string;
}

export function InfrastructurePanel({ projectId, tenantId }: InfrastructurePanelProps) {
  const [activeTab, setActiveTab] = useState<InfraTab>("tables");

  const tabs: { key: InfraTab; icon: typeof Database; label: string }[] = [
    { key: "tables", icon: Table2, label: "Tables" },
    { key: "storage", icon: HardDrive, label: "Storage" },
    { key: "schema", icon: Settings, label: "Schema" },
  ];

  return (
    <div className="h-full flex flex-col bg-surface-0">
      {/* Tab bar */}
      <div className="h-10 border-b border-surface-3 flex items-center px-3 gap-1 shrink-0">
        <Database className="w-3.5 h-3.5 text-brand-400 mr-2" />
        <span className="text-xs font-medium text-slate-400 mr-3">Infrastructure</span>
        {tabs.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
              activeTab === key
                ? "bg-surface-3 text-white"
                : "text-slate-500 hover:text-slate-300 hover:bg-surface-2"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "tables" && (
          <TableViewer projectId={projectId} tenantId={tenantId} />
        )}
        {activeTab === "storage" && (
          <StorageBrowser projectId={projectId} />
        )}
        {activeTab === "schema" && (
          <SchemaViewer projectId={projectId} tenantId={tenantId} />
        )}
      </div>
    </div>
  );
}
