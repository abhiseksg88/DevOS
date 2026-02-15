"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        router.replace("/dashboard");
      } else {
        router.replace("/login");
      }
    });
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-0">
      <div className="animate-pulse-dot">
        <div className="w-8 h-8 rounded-full bg-brand-500/30 flex items-center justify-center">
          <div className="w-3 h-3 rounded-full bg-brand-500" />
        </div>
      </div>
    </div>
  );
}
