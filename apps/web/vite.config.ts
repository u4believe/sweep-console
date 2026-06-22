import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  // Upstream Umami host the first-party /insights path proxies to.
  const umamiHost = env.VITE_UMAMI_HOST || "https://cloud.umami.is";

  return {
    plugins: [
      nodePolyfills({
        // Circle SDK (firebase + jsonwebtoken) needs process, crypto, buffer, stream.
        globals: { process: true, Buffer: true, global: true },
      }),
      react(),
    ],
    define: {
      global: "globalThis",
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 3000,
      // Fail loudly if 3000 is taken instead of silently moving to 3001 — payment
      // links are generated against :3000 (NEXT_PUBLIC_APP_URL), so the dev port must
      // not drift, or those links point at a dead port.
      strictPort: true,
      host: true, // bind to 0.0.0.0 so WSL2 is accessible from Windows browser
      proxy: {
        // All /api/* requests are forwarded to Express, stripping the /api prefix
        "/api": {
          target: "http://localhost:4000",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        // First-party Umami proxy → both the tracker script and the event endpoint
        // are served from our own origin, so ad-blockers (which match the umami
        // domain / script name) don't block analytics. In PRODUCTION, replicate this
        // as a host rewrite: /insights/* → <umamiHost>/*
        "/insights": {
          target: umamiHost,
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/insights/, ""),
        },
      },
    },
  };
});
