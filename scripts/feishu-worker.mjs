// Feishu 数字员工常驻启动器（测试工程师员工）
// 用法：node scripts/feishu-worker.mjs
// 前置：FEISHU_APP_ID / FEISHU_APP_SECRET / SENSENOVA_API_KEY 已设为用户级环境变量
// 说明：从注册表 HKCU\Environment 读取用户级环境变量并注入进程，
//       兼容从 IDE 沙箱启动时进程环境块不含新增用户变量的场景。
//       以 RPC 模式常驻运行 pi（print 模式在初始消息后会 dispose session，
//       导致扩展上下文失效，无法继续处理飞书消息）。
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readUserEnv(name) {
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      windowsHide: true,
    });
    const m = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

const VARS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_ENCRYPT_KEY",
  "FEISHU_VERIFICATION_TOKEN",
  "SENSENOVA_API_KEY",
];
for (const name of VARS) {
  const val = process.env[name] ?? readUserEnv(name);
  if (val) process.env[name] = val;
}

if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  console.warn(
    "[feishu-worker] WARN: FEISHU_APP_ID / FEISHU_APP_SECRET missing; feishu-bot will be disabled",
  );
}
if (!process.env.SENSENOVA_API_KEY) {
  console.warn("[feishu-worker] WARN: SENSENOVA_API_KEY missing; model calls will fail");
}

console.log("[feishu-worker] starting pi in rpc mode with feishu-bot (sensenova) ...");

// RPC 模式是 headless 常驻设计（session 不会在消息后 dispose，扩展上下文持续有效）。
// stdin 必须保持打开：RPC 模式在 stdin EOF 时会 shutdown 退出。
const child = spawn(
  process.execPath,
  [
    "packages/coding-agent/dist/cli.js",
    "--mode",
    "rpc",
    "--model",
    "sensenova/sensenova-6.8-flash-lite",
    "--approve",
  ],
  { cwd: repo, stdio: ["pipe", "inherit", "inherit"] },
);

child.on("exit", (code, signal) => {
  console.log(`[feishu-worker] pi exited (code=${code}, signal=${signal})`);
  process.exit(code ?? 0);
});
