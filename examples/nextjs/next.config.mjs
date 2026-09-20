import path from "node:path";

/** @type {import("next").NextConfig} */
const nextConfig = {
  turbopack: {
    root: path.resolve(import.meta.dirname, "../.."),
  },
  // `npm run build` runs the example-local typecheck first. Next's internal
  // parser cannot consume --showConfig when the shared source self-references
  // the repository package from outside this app directory.
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
