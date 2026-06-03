import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, "..");
const logsDir = path.join(siteRoot, "logs");
const dataDir = path.join(siteRoot, "data");
const timeoutMs = Number(process.env.DASHBOARD_UPDATE_TIMEOUT_MS || 10 * 60 * 1000);
const maxAttempts = Number(process.env.DASHBOARD_UPDATE_ATTEMPTS || 2);
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const logFile = path.join(logsDir, `dashboard-update-${stamp}.log`);

function appendLine(stream, value) {
  stream.write(`${value}\n`);
}

function writeChunk(stream, chunk, output) {
  stream.write(chunk);
  output.write(chunk);
}

function runAttempt(attempt, stream) {
  return new Promise((resolve) => {
    appendLine(stream, `attempt=${attempt}`);
    appendLine(stream, `startedAt=${new Date().toISOString()}`);
    appendLine(stream, `timeoutMs=${timeoutMs}`);

    const child = spawn(process.execPath, ["scripts/build-dashboard.mjs"], {
      cwd: siteRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      appendLine(stream, "timeout=true");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => writeChunk(stream, chunk, process.stdout));
    child.stderr.on("data", (chunk) => writeChunk(stream, chunk, process.stderr));
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const finishedAt = new Date();
      appendLine(stream, `finishedAt=${finishedAt.toISOString()}`);
      appendLine(stream, `exitCode=${code}`);
      if (signal) appendLine(stream, `signal=${signal}`);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        finishedAt
      });
    });
  });
}

await mkdir(logsDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

const stream = createWriteStream(logFile, { flags: "a" });
appendLine(stream, "dashboard update run");
appendLine(stream, `siteRoot=${siteRoot}`);

let result;
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  result = await runAttempt(attempt, stream);
  if (result.ok) break;
  if (attempt < maxAttempts) appendLine(stream, `retryNextAttempt=${attempt + 1}`);
}

const finishedAt = new Date();
const status = {
  ok: Boolean(result?.ok),
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  attempts: result?.ok ? undefined : maxAttempts,
  logFile: path.relative(siteRoot, logFile)
};

const statusFile = status.ok ? "last-run.json" : "last-error.json";
await writeFile(path.join(dataDir, statusFile), `${JSON.stringify(status, null, 2)}\n`, "utf8");
appendLine(stream, `status=${status.ok ? "ok" : "failed"}`);
appendLine(stream, `statusFile=data/${statusFile}`);
stream.end();

if (!status.ok) {
  console.error(`Dashboard update failed. See ${logFile}`);
  try {
    const logText = await readFile(logFile, "utf8");
    console.error("----- dashboard update log -----");
    console.error(logText);
    console.error("----- end dashboard update log -----");
  } catch (error) {
    console.error(`Could not read log file: ${error.message}`);
  }
  process.exit(1);
}

console.log(`Dashboard update succeeded. See ${logFile}`);
