import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  try {
    const response = NextResponse.next({ request: { headers: request.headers } });

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options);
            });
          },
        },
      }
    );

    const { data: { session } } = await supabase.auth.getSession();

    // Protect dashboard and project routes
    const isProtected = request.nextUrl.pathname.startsWith("/dashboard") ||
                        request.nextUrl.pathname.startsWith("/project");

    if (isProtected && !session) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // Redirect logged-in users away from login
    if (request.nextUrl.pathname === "/login" && session) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    return response;
  } catch {
    // If Supabase env vars are missing or client fails, pass through
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/dashboard/:path*", "/project/:path*", "/login"],
};
