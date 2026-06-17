// Full-stack local dev: Vite (HMR) as the front door, with `/api` proxied to a Pages
// Functions backend (`wrangler pages dev`) that holds the Workers AI binding + Zilliz secrets.
//
// Why this shape? Current wrangler rejects `pages dev -- vite` when the config sets
// `pages_build_output_dir` ("Cannot specify both a directory and a proxy command"), and
// `pages deploy` NEEDS `pages_build_output_dir` to apply the `[ai]` binding from wrangler.toml.
// Rather than drop the binding from config (which would break prod), we run wrangler in plain
// directory mode as an API-only backend and let Vite be the front door — Vite proxies `/api`
// to it (see vite.config.ts). Open the Vite URL printed below.
import { spawn } from "node:child_process";

const VITE_PORT = 5173;
const API_PORT = 8788;
const procs = [];

function run(cmd, args) {
  const p = spawn(cmd, args, { stdio: "inherit", shell: false });
  procs.push(p);
  return p;
}

// Functions + bindings backend. Serves `public/` as harmless static (Vite is the real front
// door); directory mode sidesteps the proxy-command conflict above.
run("npx", ["wrangler", "pages", "dev", "public", "--port", String(API_PORT)]);
// Front door: full HMR. vite.config.ts proxies /api -> the backend on API_PORT.
run("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"]);

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) p.kill("SIGTERM");
  process.exit(code);
};

for (const p of procs) p.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
