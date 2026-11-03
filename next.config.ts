import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } },
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // camera/mic for the table, bluetooth for GoDice, motion for shake-to-roll
        { key: "Permissions-Policy", value: "camera=(self), microphone=(self), bluetooth=(self), accelerometer=(self)" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Robots-Tag", value: "noindex" },
      ],
    }];
  },
};

export default nextConfig;
