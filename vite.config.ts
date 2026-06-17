import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Local dev: forward API calls to the Pages Functions backend (`wrangler pages dev`),
      // which holds the Zilliz secrets + Workers AI binding. `npm run dev` runs both; Vite is
      // the front door (HMR) and proxies `/api` to wrangler. (`npm run dev:vite` has no
      // backend, so `/api` calls fail there — UI-only mode.)
      "/api": "http://localhost:8788",
    },
  },
});
