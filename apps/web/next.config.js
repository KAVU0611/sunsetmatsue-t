const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Ensure tracing roots resolve inside the monorepo to avoid lockfile root warnings.
  outputFileTracingRoot: path.join(__dirname, "..", "..")
};

module.exports = nextConfig;
