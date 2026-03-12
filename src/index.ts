/**
 * Main barrel export for wp-content-autopilot.
 */

// Types
export * from './types';

// Config
export { loadConfig, type PipelineConfig } from './config';

// DB
export { getDb, runMigrations } from './db/migrate';
export {
    PublishQueueRepo,
    ContentIndexRepo,
    SettingsRepo,
    LocalDbRepo,
    AuditLogRepo,
} from './db/repositories';

// Services
export { WpClient, type WpPostPayload, type WpPostResponse } from './services/wp-client';
export { RankMathService, type RankMathMeta } from './services/rankmath';
export { WriterService } from './services/writer';

// Gates
export { runGates, normalizeKeyword, type GateContext, type GateEngineResult } from './gates/engine';

// Stages
export { runStage0 } from './stages/stage0';
export { runStage1 } from './stages/stage1';
export { runStage2 } from './stages/stage2';
export { runStage3 } from './stages/stage3';
export { runStage3_5 } from './stages/stage3_5';
export { runStage4 } from './stages/stage4';
export { runStage5 } from './stages/stage5';
export { runStage6 } from './stages/stage6';

// Runner
export { runPipeline, type RunResult } from './runner';

// Server
export { createApp } from './server';

// Logger
export { logger, createLogger } from './logger';
