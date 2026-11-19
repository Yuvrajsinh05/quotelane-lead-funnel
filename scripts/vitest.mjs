// Launch Vitest from the true-case project path.
// On Windows a lower-case drive letter in the cwd ("c:\..." — VS Code's default terminal)
// makes Vitest load two copies of itself and fail with "failed to find the current suite".
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const cwd = realpathSync.native(process.cwd());
const bin = join(cwd, "node_modules", "vitest", "vitest.mjs");
const { status } = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(status ?? 1);
