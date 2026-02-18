"use client";

import { useCallback, useRef, useState } from "react";
import { streamBuildEvents } from "@/lib/api";
import type { BuildEvent, BuildStatus } from "@/types";

export interface BuildStreamState {
  events: BuildEvent[];
  isStreaming: boolean;
  status: BuildStatus | null;
  /** True when build is paused at HITL gate waiting for plan approval */
  awaitingApproval: boolean;
  /** Plan data from HITL gate for user review */
  plan: Record<string, unknown> | null;
}

export function useBuildStream() {
  const [state, setState] = useState<BuildStreamState>({
    events: [],
    isStreaming: false,
    status: null,
    awaitingApproval: false,
    plan: null,
  });
  const cancelRef = useRef<(() => void) | null>(null);

  const startStream = useCallback(
    (token: string, tenantId: string, projectId: string, buildId: string) => {
      // Cancel any existing stream
      cancelRef.current?.();

      setState({ events: [], isStreaming: true, status: "queued", awaitingApproval: false, plan: null });

      cancelRef.current = streamBuildEvents(
        token,
        tenantId,
        projectId,
        buildId,
        0,
        (event) => {
          const be = event as unknown as BuildEvent;
          const isHitl = be.kind === "info" && be.payload?.hitl_required === true;
          setState((prev) => ({
            ...prev,
            events: [...prev.events, be],
            status: (be.payload?.status as BuildStatus) ?? prev.status,
            awaitingApproval: isHitl ? true : prev.awaitingApproval,
            plan: isHitl ? (be.payload?.plan as Record<string, unknown>) ?? prev.plan : prev.plan,
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
