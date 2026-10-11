// Builds dist/helper.exe: bundle -> Node SEA blob -> inject into a copy of node.exe.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["helper.mjs"], bundle: true, platform: "node", format: "cjs", outfile: "dist/helper.cjs", target: "node22" });
writeFileSync("dist/sea-config.json", JSON.stringify({ main: "dist/helper.cjs", output: "dist/sea.blob", disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", "dist/sea-config.json"], { stdio: "inherit" });
copyFileSync(process.execPath, "dist/helper.exe");
execFileSync("npx", ["postject", "dist/helper.exe", "NODE_SEA_BLOB", "dist/sea.blob",
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit", shell: true });
console.log("built dist/helper.exe");
