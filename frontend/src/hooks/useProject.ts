"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import * as api from "@/lib/api";
import type { Project, Build } from "@/types";

export function useProject(projectId: string) {
  const searchParams = useSearchParams();
  const tenantId = searchParams.get("tenant") ?? "";
  const [project, setProject] = useState<Project | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);

  const getToken = useCallback(async () => {
    if (token) return token;
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const t = data.session?.access_token ?? "";
    setToken(t);
    return t;
  }, [token]);

  useEffect(() => {
    if (!tenantId || !projectId) return;
    (async () => {
      const t = await getToken();
      if (!t) return;
      try {
        const [p, b] = await Promise.all([
          api.projects.get(t, tenantId, projectId),
          api.builds.list(t, tenantId, projectId),
        ]);
        setProject(p);
        setBuilds(b);
      } catch {
        // handle error
      }
      setLoading(false);
    })();
  }, [tenantId, projectId, getToken]);

  const createBuild = useCallback(
    async (prompt: string) => {
      const t = await getToken();
      const build = await api.builds.create(t, tenantId, projectId, prompt);
      setBuilds((prev) => [build, ...prev]);
      return build;
    },
    [getToken, tenantId, projectId]
  );

  const refreshBuild = useCallback(
    async (buildId: string) => {
      const t = await getToken();
      const build = await api.builds.get(t, tenantId, projectId, buildId);
      setBuilds((prev) => prev.map((b) => (b.id === buildId ? build : b)));
      return build;
    },
    [getToken, tenantId, projectId]
  );

  return { project, builds, tenantId, token, loading, createBuild, refreshBuild, getToken };
}
