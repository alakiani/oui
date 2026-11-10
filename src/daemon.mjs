// The long-running process: the kitchen, the expediter and the HTTP server.
// `oui up` starts it in the background; everything else is a client.

import fs from "node:fs";
import { P, OUI_BIN, home, readJson, writeJsonAtomic } from "./paths.mjs";
import { Kitchen } from "./kitchen.mjs";
import { Expediter } from "./expediter.mjs";
import { createServer } from "./server.mjs";

export async function runDaemon({ port } = {}) {
  const kitchen = new Kitchen();
  const expo = new Expediter(kitchen);
  let server;
  const shutdown = () => {
    expo.stop();
    kitchen.save();
    const info = readJson(P.daemon(), {});
    writeJsonAtomic(P.daemon(), { ...info, pid: null, token: null, stoppedAt: Date.now() }, 0o600);
    server?.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  server = createServer(kitchen, expo, shutdown);
  const want = Number(port ?? process.env.OUI_PORT ?? kitchen.config.port);
  await new Promise((resolve, reject) => {
    server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`Port ${want} is in use. Another Oui Chef may be running (oui status), or set "port" in ${P.config()}.`) : e));
    server.listen(want, "127.0.0.1", resolve);
  });
  kitchen.port = server.address().port;
  // The mod and the CLI find the daemon here. Paths are absolute so a GUI app with a bare PATH can still run oui.
  writeJsonAtomic(P.daemon(), { pid: process.pid, port: kitchen.port, token: kitchen.chefToken, node: process.execPath, oui: OUI_BIN, home: home(), startedAt: Date.now(), version: readJson(new URL("../package.json", import.meta.url).pathname, {}).version }, 0o600);
  try {
    fs.chmodSync(P.daemon(), 0o600);
  } catch {}
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`Oui Chef is up: http://127.0.0.1:${kitchen.port}  (home ${home()}, harness ${kitchen.config.harness})`);
  expo.kick();
  return { kitchen, expo, server, shutdown };
}
