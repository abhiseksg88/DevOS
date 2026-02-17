"use client";

import { Component, Suspense, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { Workspace } from "@/components/workspace/Workspace";
import { Loader2, AlertTriangle, RotateCcw, ArrowLeft } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Error boundary — catches runtime crashes and shows a recovery UI   */
/* instead of a blank white page.                                     */
/* ------------------------------------------------------------------ */
interface ErrorState {
  hasError: boolean;
  error: Error | null;
}

class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, ErrorState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[Workspace] Runtime error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-surface-0">
          <div className="max-w-md text-center px-6">
            <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-6">
              <AlertTriangle className="w-8 h-8 text-red-400" />
            </div>
            <h1 className="text-xl font-bold text-white mb-2">
              Something went wrong
            </h1>
            <p className="text-slate-400 text-sm mb-4">
              The workspace encountered an error. This is usually temporary.
            </p>
            <div className="bg-surface-2 border border-surface-3 rounded-lg p-3 mb-6 text-left">
              <code className="text-xs text-red-400 break-all">
                {this.state.error?.message || "Unknown error"}
              </code>
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-all"
              >
                <RotateCcw className="w-4 h-4" />
                Reload Page
              </button>
              <a
                href="/dashboard"
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-surface-3 text-slate-300 text-sm font-medium transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                Dashboard
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/* Page component                                                     */
/* ------------------------------------------------------------------ */
function ProjectLoader() {
  const { id } = useParams<{ id: string }>();
  return <Workspace projectId={id} />;
}

export default function ProjectPage() {
  return (
    <WorkspaceErrorBoundary>
      <Suspense
        fallback={
          <div className="h-screen flex items-center justify-center bg-surface-0">
            <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
          </div>
        }
      >
        <ProjectLoader />
      </Suspense>
    </WorkspaceErrorBoundary>
  );
}
