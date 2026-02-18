"use client";

import { useRef, useEffect, useState } from "react";
import { ChatMessageBubble } from "./ChatMessage";
import { PromptInput } from "./PromptInput";
import type { ChatMessage, BuildEvent } from "@/types";
import { Sparkles } from "lucide-react";

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  onApprovePlan: () => void;
  onModifyPlan: (notes: string) => void;
  onRejectPlan: () => void;
  onOpenPreview: () => void;
  onOpenCode: () => void;
  isStreaming: boolean;
  isAnalyzing: boolean;
  buildEvents: BuildEvent[];
}

export function ChatPanel({
  messages,
  onSendMessage,
  onApprovePlan,
  onModifyPlan,
  onRejectPlan,
  onOpenPreview,
  onOpenCode,
  isStreaming,
  isAnalyzing,
  buildEvents,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showWelcome, setShowWelcome] = useState(true);

  useEffect(() => {
    if (messages.length > 0) setShowWelcome(false);
  }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, buildEvents]);

  return (
    <div className="h-full flex flex-col bg-surface-1 border-r border-surface-3">
      {/* Header */}
      <div className="h-10 border-b border-surface-3 flex items-center px-4 shrink-0">
        <Sparkles className="w-3.5 h-3.5 text-brand-400 mr-2" />
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          AI Agent
        </span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {showWelcome && <WelcomeMessage onSuggestionClick={onSendMessage} />}

        {messages.map((msg) => (
          <ChatMessageBubble
            key={msg.id}
            message={msg}
            onApprovePlan={onApprovePlan}
            onModifyPlan={onModifyPlan}
            onRejectPlan={onRejectPlan}
            onOpenPreview={onOpenPreview}
            onOpenCode={onOpenCode}
          />
        ))}

        {/* Streaming indicator — only show during build (not analyze) when no pipeline message exists */}
        {isStreaming && !messages.some(m => m.type === "pipeline") && buildEvents.length > 0 && (
          <div className="space-y-1 animate-fade-in">
            {buildEvents.slice(-5).map((event, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-xs text-slate-500 animate-slide-up"
              >
                <div className="w-1 h-1 rounded-full bg-brand-500 mt-1.5 shrink-0 animate-pulse-dot" />
                <span>
                  <span className="text-slate-400 font-medium">
                    {event.agent ?? event.kind}
                  </span>
                  {" — "}
                  {(event.payload?.message as string) ?? event.kind}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Input */}
      <PromptInput
        onSubmit={onSendMessage}
        disabled={isStreaming || isAnalyzing}
        placeholder={
          isAnalyzing
            ? "Analyzing your request..."
            : isStreaming
            ? "Generating..."
            : "Describe what you want to build..."
        }
      />
    </div>
  );
}

function WelcomeMessage({ onSuggestionClick }: { onSuggestionClick: (text: string) => void }) {
  return (
    <div className="text-center py-12 animate-fade-in">
      <div className="w-14 h-14 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mx-auto mb-5 glow-brand">
        <Sparkles className="w-7 h-7 text-brand-400" />
      </div>
      <h2 className="text-lg font-semibold text-foreground mb-2">What do you want to build?</h2>
      <p className="text-sm text-slate-500 max-w-xs mx-auto leading-relaxed">
        Describe your app and our AI agents will plan, code, review, and deploy it for you.
      </p>
      <div className="mt-6 space-y-2">
        {[
          "A SaaS dashboard with auth and billing",
          "A landing page with hero, features, and CTA",
          "A task management app with database",
        ].map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => onSuggestionClick(suggestion)}
            className="block w-full text-left text-xs text-slate-500 hover:text-slate-300 px-3 py-2 rounded-lg bg-surface-2/50 border border-surface-3 hover:border-brand-500/30 hover:bg-surface-2 cursor-pointer transition-all"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
