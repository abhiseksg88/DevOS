/**
 * Yjs Provider backed by Supabase Realtime.
 *
 * Foundation layer for Phase 4A CRDT state management.
 * Provides Y.Doc for workspace state synchronization via
 * Supabase Realtime channels. Monaco binding is next iteration.
 */

import * as Y from "yjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class SupabaseYjsProvider {
  doc: Y.Doc;
  private channel: ReturnType<SupabaseClient["channel"]> | null = null;
  private supabase: SupabaseClient;
  private projectId: string;
  private connected = false;

  constructor(supabaseUrl: string, supabaseKey: string, projectId: string) {
    this.doc = new Y.Doc();
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.projectId = projectId;
  }

  connect() {
    if (this.connected) return;

    this.channel = this.supabase.channel(`workspace:${this.projectId}`);

    // Broadcast local updates to peers
    this.doc.on("update", (update: Uint8Array) => {
      if (!this.channel) return;
      this.channel.send({
        type: "broadcast",
        event: "yjs-update",
        payload: { update: Array.from(update) },
      });
    });

    // Receive remote updates from peers
    this.channel.on(
      "broadcast",
      { event: "yjs-update" },
      (payload: { payload: { update: number[] } }) => {
        const update = new Uint8Array(payload.payload.update);
        Y.applyUpdate(this.doc, update);
      }
    );

    this.channel.subscribe();
    this.connected = true;
  }

  disconnect() {
    this.channel?.unsubscribe();
    this.doc.destroy();
    this.connected = false;
  }

  /** Shared map for file contents */
  getFileMap(): Y.Map<string> {
    return this.doc.getMap("files");
  }

  /** Shared map for cursor positions */
  getCursorMap(): Y.Map<Record<string, unknown>> {
    return this.doc.getMap("cursors");
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected;
  }
}
