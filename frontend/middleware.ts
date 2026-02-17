import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Known base domains for the app.
 * Subdomains of these will be routed to serve published apps.
 * e.g., my-app.vedaa.io → /api/serve-app?slug=my-app
 */
const APP_DOMAINS = ["vedaa.io", "devos.app"];

/**
 * Extract subdomain from the hostname.
 * Returns null if no subdomain or if the subdomain is "www".
 */
function extractSubdomain(hostname: string): string | null {
  // Remove port if present
  const host = hostname.split(":")[0];

  for (const baseDomain of APP_DOMAINS) {
    if (host === baseDomain || host === `www.${baseDomain}`) {
      return null; // Root domain or www, not a subdomain
    }
    if (host.endsWith(`.${baseDomain}`)) {
      const sub = host.slice(0, -(baseDomain.length + 1));
      // Only single-level subdomains (no dots)
      if (sub && !sub.includes(".") && sub !== "www") {
        return sub;
      }
    }
  }

  return null;
}

export async function middleware(request: NextRequest) {
  const hostname = request.headers.get("host") || "";

  // --- Subdomain routing: serve published apps ---
  const subdomain = extractSubdomain(hostname);
  if (subdomain) {
    // Rewrite subdomain requests to the serve-app API route
    const url = request.nextUrl.clone();
    url.pathname = "/api/serve-app";
    url.searchParams.set("slug", subdomain);
    return NextResponse.rewrite(url);
  }

  // --- Normal app routing: auth protection ---
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
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public files (images, etc.)
     *
     * This broader matcher is needed for subdomain routing to work.
     * The middleware function itself handles the logic for which paths
     * need auth protection vs subdomain routing.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
