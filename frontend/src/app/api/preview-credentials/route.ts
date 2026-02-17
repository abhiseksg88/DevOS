/**
 * Returns Supabase credentials for preview iframe embedding.
 * Reads directly from environment variables (no backend proxy needed).
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  });
}
