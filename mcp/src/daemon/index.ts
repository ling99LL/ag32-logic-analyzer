import { startDaemonServer } from "./server.js";

process.title = "AG32 Logic Studio Daemon";

void startDaemonServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
