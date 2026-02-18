"use client";

import { useState } from "react";
import type { FileNode } from "@/types";
import { cn, getFileIcon } from "@/lib/utils";
import { ChevronRight, ChevronDown, FolderOpen, Folder } from "lucide-react";

interface FileTreeProps {
  files: FileNode[];
  activeFile: FileNode | null;
  onSelect: (file: FileNode) => void;
}

export function FileTree({ files, activeFile, onSelect }: FileTreeProps) {
  return (
    <div className="h-full bg-surface-1 border-r border-surface-3 overflow-y-auto">
      <div className="h-8 flex items-center px-3 border-b border-surface-3">
        <span className="text-2xs font-medium text-slate-500 uppercase tracking-wider">
          Explorer
        </span>
      </div>
      <div className="py-1">
        {files.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            activeFile={activeFile}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  activeFile,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  activeFile: FileNode | null;
  onSelect: (file: FileNode) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isDir = node.type === "directory";
  const isActive = activeFile?.path === node.path;

  const colorMap: Record<string, string> = {
    TS: "text-blue-400",
    TX: "text-blue-400",
    JS: "text-yellow-400",
    JX: "text-yellow-400",
    PY: "text-green-400",
    "{}": "text-amber-400",
    "#": "text-pink-400",
    "<>": "text-orange-400",
    M: "text-slate-400",
    DB: "text-cyan-400",
  };

  return (
    <>
      <button
        onClick={() => {
          if (isDir) {
            setExpanded(!expanded);
          } else {
            onSelect(node);
          }
        }}
        className={cn(
          "w-full flex items-center gap-1.5 py-[3px] pr-3 text-xs transition-colors group",
          isActive
            ? "bg-brand-500/10 text-foreground"
            : "text-slate-400 hover:text-slate-200 hover:bg-surface-2"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {/* Chevron or spacer */}
        {isDir ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 text-slate-600 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {/* Icon */}
        {isDir ? (
          expanded ? (
            <FolderOpen className="w-3.5 h-3.5 text-brand-400 shrink-0" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          )
        ) : (
          <span
            className={cn(
              "text-2xs font-bold shrink-0 w-4 text-center font-mono",
              colorMap[getFileIcon(node.name)] ?? "text-slate-500"
            )}
          >
            {getFileIcon(node.name)}
          </span>
        )}

        {/* Name */}
        <span className="truncate">{node.name}</span>

        {isActive && (
          <div className="ml-auto w-1 h-1 rounded-full bg-brand-500 shrink-0" />
        )}
      </button>

      {/* Children */}
      {isDir && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activeFile={activeFile}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </>
  );
}
