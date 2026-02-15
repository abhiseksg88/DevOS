"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";

interface PromptInputProps {
  onSubmit: (content: string) => void;
  disabled?: boolean;
}

export function PromptInput({ onSubmit, disabled }: PromptInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, [value]);

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  }

  return (
    <div className="border-t border-surface-3 p-3">
      <div className="relative flex items-end rounded-xl bg-surface-2 border border-surface-4 focus-within:border-brand-500/50 focus-within:ring-1 focus-within:ring-brand-500/30 transition-all">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={disabled ? "Building..." : "Describe what you want to build..."}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent text-white text-sm placeholder:text-slate-600 px-4 py-3 resize-none focus:outline-none disabled:opacity-50 max-h-[150px]"
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="p-2 m-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-all disabled:opacity-30 disabled:hover:bg-brand-600 shrink-0"
        >
          {disabled ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>
      <p className="text-2xs text-slate-700 mt-1.5 px-1">
        Press Enter to send, Shift+Enter for new line
      </p>
    </div>
  );
}
