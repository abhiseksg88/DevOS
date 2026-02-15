"use client";

import { useCallback, useRef, useState } from "react";
import { streamBuildEvents } from "@/lib/api";
import type { BuildEvent, BuildStatus } from "@/types";

export interface BuildStreamState {
  events: BuildEvent[];
  isStreaming: boolean;
  status: BuildStatus | null;
}

export function useBuildStream() {
  const [state, setState] = useState<BuildStreamState>({
    events: [],
    isStreaming: false,
    status: null,
  });
  const cancelRef = useRef<(() => void) | null>(null);

  const startStream = useCallback(
    (token: string, tenantId: string, projectId: string, buildId: string) => {
      // Cancel any existing stream
      cancelRef.current?.();

      setState({ events: [], isStreaming: true, status: "queued" });

      cancelRef.current = streamBuildEvents(
        token,
        tenantId,
        projectId,
        buildId,
        0,
        (event) => {
          const be = event as unknown as BuildEvent;
          setState((prev) => ({
            ...prev,
            events: [...prev.events, be],
            status: (be.payload?.status as BuildStatus) ?? prev.status,
          }));
        },
        () => {
          setState((prev) => ({ ...prev, isStreaming: false }));
        },
        () => {
          setState((prev) => ({ ...prev, isStreaming: false }));
        }
      );
    },
    []
  );

  const stopStream = useCallback(() => {
    cancelRef.current?.();
    setState((prev) => ({ ...prev, isStreaming: false }));
  }, []);

  return { ...state, startStream, stopStream };
}
