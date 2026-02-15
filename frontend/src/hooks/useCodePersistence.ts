"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as db from "@/lib/supabase-db";
import type { FileNode, ChatMessage } from "@/types";

export interface UseCodePersistenceReturn {
  isLoading: boolean;
  codeFiles: Record<string, string>;
  messages: ChatMessage[];
  workspaceState: db.WorkspaceUIState | null;
  versions: Array<{ version: number; label: string; trigger: string; created_at: string }>;

  // Actions
  saveCode: (code: Record<string, string>, trigger: 'generation' | 'autosave' | 'manual', label?: string) => Promise<void>;
  saveMessage: (role: 'user' | 'assistant' | 'system', content: string) => Promise<void>;
  saveWorkspaceState: (state: db.WorkspaceUIState) => void; // debounced
  rollbackToVersion: (version: number) => Promise<Record<string, string>>;
}

/**
 * Hook for persisting workspace code, chat, and UI state to Supabase.
 *
 * **On mount:**
 * - Loads code_files from projects table
 * - Loads chat messages from chat_messages table
 * - Loads workspace UI state from workspace_state table
 * - Loads version history from project_versions table
 *
 * **Saves code** when generation completes or user edits files
 * **Saves chat** immediately after each message
 * **Debounces workspace state** saves (2s idle)
 */
export function useCodePersistence(projectId: string, userId: string | null): UseCodePersistenceReturn {
  const [isLoading, setIsLoading] = useState(true);
  const [codeFiles, setCodeFiles] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workspaceState, setWorkspaceState] = useState<db.WorkspaceUIState | null>(null);
  const [versions, setVersions] = useState<Array<{ version: number; label: string; trigger: string; created_at: string }>>([]);

  // Track autosave throttle: max 1 autosave per 30s
  const lastAutoSaveRef = useRef<number>(0);
  const autoSaveDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Load persisted state on mount
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        // Load all data in parallel
        const [code, chat, state, vers] = await Promise.all([
          db.getProjectCode(projectId),
          db.loadChatMessages(projectId),
          userId ? db.loadWorkspaceState(projectId, userId) : Promise.resolve(null),
          db.listProjectVersions(projectId),
        ]);

        if (!mounted) return;

        setCodeFiles(code);
        setMessages(
          chat.map((msg) => ({
            id: msg.id,
            role: msg.role as 'user' | 'assistant' | 'system',
            content: msg.content,
            timestamp: new Date(msg.created_at).getTime(),
          }))
        );
        setWorkspaceState(state);
        setVersions(vers);
      } catch (err) {
        console.error('Failed to load persisted state:', err);
        // Continue with empty state
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [projectId, userId]);

  /**
   * Save code files. Creates a version snapshot in the database.
   */
  const saveCode = useCallback(
    async (code: Record<string, string>, trigger: 'generation' | 'autosave' | 'manual', label?: string) => {
      try {
        const result = await db.updateProjectCode(projectId, code, trigger, label);
        setCodeFiles(code);

        // Add to versions list
        setVersions((prev) => [
          {
            version: result.version,
            label: label ?? trigger,
            trigger,
            created_at: new Date().toISOString(),
          },
          ...prev,
        ]);
      } catch (err) {
        console.error('Failed to save code:', err);
      }
    },
    [projectId]
  );

  /**
   * Save a chat message immediately.
   */
  const saveMessage = useCallback(
    async (role: 'user' | 'assistant' | 'system', content: string) => {
      try {
        await db.saveChatMessage(projectId, role, content);
        const now = new Date();
        setMessages((prev) => [
          ...prev,
          {
            id: `${now.getTime()}`,
            role,
            content,
            timestamp: now.getTime(),
          },
        ]);
      } catch (err) {
        console.error('Failed to save message:', err);
      }
    },
    [projectId]
  );

  /**
   * Debounced workspace state save. Maximum 1 save per 30s.
   */
  const saveWorkspaceState = useCallback(
    (state: db.WorkspaceUIState) => {
      if (!userId) return; // Can't save without user

      // Clear pending debounce
      if (autoSaveDebounceRef.current) {
        clearTimeout(autoSaveDebounceRef.current);
      }

      // Check throttle: only save if 30s has passed since last autosave
      const now = Date.now();
      if (now - lastAutoSaveRef.current < 30000) {
        // Set debounce to save after 2s idle
        autoSaveDebounceRef.current = setTimeout(async () => {
          try {
            await db.saveWorkspaceState(projectId, userId, state);
            setWorkspaceState(state);
            lastAutoSaveRef.current = Date.now();
          } catch (err) {
            console.error('Failed to save workspace state:', err);
          }
        }, 2000);
      } else {
        // No throttle active, save immediately
        (async () => {
          try {
            await db.saveWorkspaceState(projectId, userId, state);
            setWorkspaceState(state);
            lastAutoSaveRef.current = Date.now();
          } catch (err) {
            console.error('Failed to save workspace state:', err);
          }
        })();
      }
    },
    [projectId, userId]
  );

  /**
   * Rollback to a specific version.
   * Creates a NEW version with trigger='rollback' to preserve the current state in history.
   */
  const rollbackToVersion = useCallback(
    async (version: number) => {
      try {
        const code = await db.getProjectVersion(projectId, version);
        // Create a rollback version (so current state is not lost)
        await saveCode(code, 'manual', `Rolled back from version ${version}`);
        return code;
      } catch (err) {
        console.error('Failed to rollback to version:', err);
        throw err;
      }
    },
    [projectId, saveCode]
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (autoSaveDebounceRef.current) {
        clearTimeout(autoSaveDebounceRef.current);
      }
    };
  }, []);

  return {
    isLoading,
    codeFiles,
    messages,
    workspaceState,
    versions,
    saveCode,
    saveMessage,
    saveWorkspaceState,
    rollbackToVersion,
  };
}
