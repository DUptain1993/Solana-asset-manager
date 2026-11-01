import { spawn } from "node:child_process";

const procs = [
  { name: "server", child: spawn("node", ["server.js"], { stdio: "inherit" }) },
  { name: "bot", child: spawn("node", ["bot.js"], { stdio: "inherit" }) },
];

let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const { name, child } of procs) {
    try { child.kill("SIGTERM"); } catch {}
    console.error(`[supervisor] sent SIGTERM to ${name}`);
  }
  setTimeout(() => process.exit(code), 800);
}

for (const { name, child } of procs) {
  child.on("exit", (code, signal) => {
    console.error(`[supervisor] ${name} exited code=${code} signal=${signal}`);
    shutdown(code ?? 1);
  });
  child.on("error", (err) => {
    console.error(`[supervisor] ${name} spawn error:`, err.message);
    shutdown(1);
  });
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

console.log("[supervisor] both processes running");
