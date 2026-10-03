import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root to this repository; a lockfile in a parent
  // directory would otherwise be picked up as the root.
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
