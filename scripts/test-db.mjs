#!/usr/bin/env node
/**
 * One entry point for the Docker-backed test database.
 *
 * Why a Node script instead of npm-script one-liners: it injects DATABASE_URL
 * into each child process's ENVIRONMENT (never onto a command line), so it works
 * identically on PowerShell and bash — no `$env:X=...` vs `X=... cmd` divergence,
 * and the connection string with its `://@?` characters never needs shell
 * quoting. It also keeps the test URL off the process list.
 *
 * Commands (run from the repo root, e.g. `npm run test:db:up`):
 *   up      Start the container, wait for health, apply migrations, seed
 *           (master data + the test requestor + synthetic consignees).
 *   reset   Truncate transactional tables + re-ensure the test fixtures,
 *           WITHOUT restarting the container (fast between manual runs).
 *   seed    Re-run the seed + seed-test only (idempotent upserts).
 *   down    Stop and remove the container (tmpfs data is discarded).
 *   api     Run the API dev server pointed at the TEST DB — the sanctioned way
 *           to drive the local Playwright e2e suite without touching prod.
 *
 * The canonical test connection string is below; override it by exporting
 * TEST_DATABASE_URL (e.g. to use a different host port).
 */
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const API_DIR = path.join(ROOT, "api");
const COMPOSE_FILE = path.join(ROOT, "docker-compose.test.yml");

// Local, throwaway, non-secret. Host port 55432 (see docker-compose.test.yml).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://uwc:uwc@localhost:55432/uwc_test?schema=public";

// Belt-and-suspenders: this orchestrator must NEVER drive a remote/prod DB.
assertLocalhost(TEST_DATABASE_URL);

const childEnv = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };

function assertLocalhost(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    fail(`TEST_DATABASE_URL is not a valid URL: ${url}`);
  }
  const local = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
  const prodMarkers = ["rlwy.net", "railway.internal", "railway.app"];
  if (!local.includes(host) || prodMarkers.some((m) => host.includes(m))) {
    fail(
      `Refusing to run the test-DB orchestrator against a non-local host "${host}".\n` +
        `  The test database must be local (${local.join(", ")}). Got: ${url}`
    );
  }
}

function fail(msg) {
  console.error(`\n✖ test-db: ${msg}\n`);
  process.exit(1);
}

/** Run a command to completion, inheriting stdio. Exits the process on failure. */
function run(cmd, args, opts = {}) {
  const label = [cmd, ...args].join(" ");
  console.log(`\n▸ ${label}`);
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: true, // resolve docker / npx / npm on Windows + POSIX alike
    env: childEnv,
    ...opts,
  });
  if (res.status !== 0) {
    fail(`command failed (exit ${res.status ?? "signal"}): ${label}`);
  }
}

function compose(...args) {
  run("docker", ["compose", "-f", COMPOSE_FILE, ...args]);
}

function up() {
  // --wait blocks until the healthcheck reports healthy (or times out).
  compose("up", "-d", "--wait");
  migrate();
  seed();
  console.log(
    `\n✔ Test DB ready at ${TEST_DATABASE_URL}\n  Run integration tests:  npm run test:integration\n`
  );
}

function migrate() {
  // `migrate deploy` applies committed migrations only — no prompts, no new
  // migration generation, no dev-seed side effect. The right command for a
  // fresh container. (Do NOT use `migrate dev` here.)
  run("npx", ["prisma", "migrate", "deploy"], { cwd: API_DIR });
}

function seed() {
  run("npx", ["tsx", "prisma/seed.ts"], { cwd: API_DIR });
  run("npx", ["tsx", "prisma/seed-test.ts"], { cwd: API_DIR });
}

function reset() {
  // No container restart — just wipe transactional rows and re-ensure fixtures.
  run("npx", ["tsx", "prisma/reset-test.ts"], { cwd: API_DIR });
}

function down() {
  compose("down", "-v");
  console.log("\n✔ Test DB stopped and removed.\n");
}

function api() {
  // Long-running: the API dev server against the TEST DB. This is how local
  // Playwright e2e is meant to run — the API talks to Docker, never prod.
  console.log(`\n▸ API dev server → ${TEST_DATABASE_URL}\n  (Ctrl-C to stop)\n`);
  const child = spawn("npx", ["tsx", "watch", "src/index.ts"], {
    stdio: "inherit",
    shell: true,
    env: childEnv,
    cwd: API_DIR,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

const cmd = process.argv[2];
switch (cmd) {
  case "up":
    up();
    break;
  case "reset":
    reset();
    break;
  case "seed":
    seed();
    break;
  case "down":
    down();
    break;
  case "api":
    api();
    break;
  default:
    fail(`unknown command "${cmd ?? ""}". Use: up | reset | seed | down | api`);
}
