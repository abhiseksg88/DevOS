"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { Workspace } from "@/components/workspace/Workspace";
import { Loader2 } from "lucide-react";

function ProjectLoader() {
  const { id } = useParams<{ id: string }>();
  return <Workspace projectId={id} />;
}

export default function ProjectPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen flex items-center justify-center bg-surface-0">
          <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
        </div>
      }
    >
      <ProjectLoader />
    </Suspense>
  );
}
