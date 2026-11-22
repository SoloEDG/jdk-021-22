// 无头验证运行器：用 esbuild 把 TS 测试入口打包为 ESM 后动态导入执行。
// 测试代码位于 tools/tests，与业务源码 src 分离；不依赖浏览器或 localStorage。
import { build } from "esbuild";
import { pathToFileURL, fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const suites = process.argv.slice(2);
const entries = suites.length
  ? suites.map((s) => `${here}tests/${s}.ts`)
  : [`${here}tests/entry.ts`, `${here}tests/e2e.ts`];

for (const entry of entries) {
  const outfile = `${here}.build/${entry.split("/").pop()?.replace(".ts", "")}.mjs`;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
  });
  console.log(`\n=== ${entry.split("/").pop()} ===`);
  try {
    await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(`${here}.build`, { recursive: true, force: true });
  }
}
