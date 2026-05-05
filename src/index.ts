import { createRuntime } from './runtime.js';

let shuttingDown = false;

async function main(): Promise<void> {
  const runtime = await createRuntime();
  runtime.startHttp();

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    runtime.logger.info({ signal }, 'shutdown requested');
    try {
      await runtime.stop();
      process.exit(0);
    } catch (error) {
      runtime.logger.error({ error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  // Logger construction can fail if config parsing fails, so keep this plain.
  console.error(error);
  process.exit(1);
});

