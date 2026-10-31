import { spawnSync } from "node:child_process";

// Points this clone's git hooks at .githooks, so the pre-push check runs for
// everyone who installs the repository, agents included: a hook runs whether
// or not the pusher read the contributing notes. It runs from the root
// package's `prepare` script, does nothing outside a git checkout or in CI,
// and never fails an install.
if (process.env.CI) process.exit(0);
const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] });
if (inside.status !== 0 || inside.stdout.toString().trim() !== "true") process.exit(0);
const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
if (result.status !== 0) console.error("Could not set core.hooksPath; run: git config core.hooksPath .githooks");
