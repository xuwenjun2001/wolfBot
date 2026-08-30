import { createSidecarServer, SIDECAR_HOST, SIDECAR_PORT } from './server.js';

const server = createSidecarServer();
server.listen(SIDECAR_PORT, SIDECAR_HOST, () => {
  process.stdout.write(`wolfbot-agent-sidecar listening on http://${SIDECAR_HOST}:${SIDECAR_PORT}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
