import type { Server } from 'node:http';
import type { BrainEngine } from '../../src/core/engine';
import { createEngine } from '../../src/core/engine-factory';
import { loadConfig, loadConfigWithEngine, toEngineConfig } from '../../src/core/config';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config';
import { configureGateway, reconfigureGatewayWithEngine } from '../../src/core/ai/gateway';
import { runServeHttp } from '../../src/commands/serve-http';

/** HTTP owns its engine. Unlike one-shot CLI calls, it closes both on shutdown. */
export async function runHttpWorker() {
  const config = loadConfig();
  if (!config || config.engine !== 'pglite') throw new Error('Existing brain configuration is required');
  configureGateway(buildGatewayConfig(config));
  const engine: BrainEngine = await createEngine(toEngineConfig(config));
  let server: Server | undefined;
  let closing = false;
  let connected = false;
  let booted!: () => void;
  const boot = new Promise<void>(resolve => { booted = resolve; });
  const close = async () => {
    if (closing) return;
    closing = true;
    await boot; // Never disconnect an engine while its connect/startup is pending.
    if (server) {
      await new Promise<void>(resolve => {
        const deadline = setTimeout(() => server?.closeAllConnections(), 20_000);
        server!.close(() => { clearTimeout(deadline); resolve(); });
        server!.closeIdleConnections();
      });
    }
    if (connected) await engine.disconnect();
    process.exit(0);
  };
  const signal = () => { void close().catch(() => process.exit(1)); };
  process.on('SIGTERM', signal);
  process.on('SIGINT', signal);
  try {
    await engine.connect(toEngineConfig(config));
    connected = true;
    // Preserve DB-plane search/model config. Never run initSchema or migrations.
    const merged = await loadConfigWithEngine(engine, config);
    if (merged) {
      if (merged.embedding_multimodal !== undefined) process.env.GBRAIN_EMBEDDING_MULTIMODAL = String(merged.embedding_multimodal);
      if (merged.embedding_image_ocr !== undefined) process.env.GBRAIN_EMBEDDING_IMAGE_OCR = String(merged.embedding_image_ocr);
      if (merged.embedding_image_ocr_model !== undefined) process.env.GBRAIN_EMBEDDING_IMAGE_OCR_MODEL = merged.embedding_image_ocr_model;
    }
    configureGateway(buildGatewayConfig(merged ?? config));
    await reconfigureGatewayWithEngine(engine);
    if (!closing) {
      server = await runServeHttp(engine, {
        port: 3131, tokenTtl: 3600, enableDcr: false, bind: '0.0.0.0', publicUrl: process.env.GBRAIN_PUBLIC_URL,
        suppressBootstrapToken: true,
      });
      server.on('error', signal);
    }
  } catch (error) {
    booted();
    if (connected) await engine.disconnect();
    throw new Error('HTTP initialization failed', { cause: error });
  }
  booted();
}

if (import.meta.main) runHttpWorker().catch(() => {
  console.error('HTTP worker initialization failed');
  process.exit(1);
});
