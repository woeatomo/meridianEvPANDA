import "./envcrypt.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

// The standalone wallet-triggered bot is the app — there is no mode toggle.
// Entries come only from smart-wallet convergence; the LLM/server-driven
// flow lives on the `legacy` branch.

// Start when this file is the entry point. Check both argv[1] (node index.js,
// npm start — also under pm2, where pm_exec_path points at npm) and
// pm_exec_path (pm2 start index.js, where argv[1] is pm2's container).
const isEntry = p => !!p && pathToFileURL(path.resolve(p)).href === import.meta.url;
if (isEntry(process.argv[1]) || isEntry(process.env.pm_exec_path)) {
  const { startStandalone } = await import("./standalone/runtime.js");
  await startStandalone();
}
