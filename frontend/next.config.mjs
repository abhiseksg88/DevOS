/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // Allows production builds to successfully complete even if your project has ESLint errors.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Allows production builds to successfully complete even if your project has Type errors.
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
    ],
  },
};

export default nextConfig;
