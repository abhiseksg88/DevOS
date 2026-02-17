"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { LogOut, CreditCard, Settings } from "lucide-react";
import Image from "next/image";
import type { User } from "@supabase/supabase-js";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const timeout = setTimeout(() => router.replace("/login"), 5000);
    supabase.auth
      .getSession()
      .then(({ data }) => {
        clearTimeout(timeout);
        if (!data.session) {
          router.replace("/login");
        } else {
          setUser(data.session.user);
        }
      })
      .catch(() => {
        clearTimeout(timeout);
        router.replace("/login");
      });
    return () => clearTimeout(timeout);
  }, [router]);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  if (!user)
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-0">
        <div className="animate-pulse-dot">
          <div className="w-8 h-8 rounded-full bg-brand-500/30 flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-brand-500" />
          </div>
        </div>
      </div>
    );

  return (
    <div className="min-h-screen bg-surface-0">
      {/* Top nav */}
      <header className="h-14 border-b border-surface-3 flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="text-lg font-semibold gradient-text">Vedaa.io</span>
        </div>

        <div className="flex items-center gap-2">
          <button className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-surface-2 transition-all">
            <CreditCard className="w-4 h-4" />
          </button>
          <button className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-surface-2 transition-all">
            <Settings className="w-4 h-4" />
          </button>
          <div className="w-px h-6 bg-surface-3 mx-1" />
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-brand-500/20 border border-brand-500/30 flex items-center justify-center text-brand-400 text-sm font-medium">
              {user.email?.[0]?.toUpperCase() ?? "U"}
            </div>
            <button
              onClick={handleSignOut}
              className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
