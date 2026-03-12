/**
 * Server / API Endpoint Tests
 * Ref: 15_DEPLOYMENT_AND_RUNBOOK §6.2, 13_CONTENT_OPS_PIPELINE §6.5.1
 *
 * Endpoints:
 *   GET  /health         → 200 + HealthResponse
 *   GET  /status         → 200 + StatusResponse
 *   GET  /queue/summary  → 200 + QueueSummaryResponse
 *   POST /run            → 200|409 + RunResponse
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from './server';
import type { Server } from 'http';

// We test using the app directly without starting a server
// by using the express app request handler

describe('Server Endpoints', () => {
    const app = createApp();

    // Note: We test the Express app object directly.
    // For full integration, we'd use supertest but we keep deps minimal.
    // Instead we verify the app has the expected routes.

    it('app has GET /health route', () => {
        const routes = (app as any)._router?.stack
            ?.filter((r: any) => r.route)
            ?.map((r: any) => ({
                path: r.route.path,
                methods: Object.keys(r.route.methods),
            }));

        const healthRoute = routes?.find((r: any) => r.path === '/health');
        expect(healthRoute).toBeDefined();
        expect(healthRoute?.methods).toContain('get');
    });

    it('app has GET /status route', () => {
        const routes = (app as any)._router?.stack
            ?.filter((r: any) => r.route)
            ?.map((r: any) => ({
                path: r.route.path,
                methods: Object.keys(r.route.methods),
            }));

        const statusRoute = routes?.find((r: any) => r.path === '/status');
        expect(statusRoute).toBeDefined();
        expect(statusRoute?.methods).toContain('get');
    });

    it('app has GET /queue/summary route', () => {
        const routes = (app as any)._router?.stack
            ?.filter((r: any) => r.route)
            ?.map((r: any) => ({
                path: r.route.path,
                methods: Object.keys(r.route.methods),
            }));

        const queueRoute = routes?.find((r: any) => r.path === '/queue/summary');
        expect(queueRoute).toBeDefined();
        expect(queueRoute?.methods).toContain('get');
    });

    it('app has POST /run route', () => {
        const routes = (app as any)._router?.stack
            ?.filter((r: any) => r.route)
            ?.map((r: any) => ({
                path: r.route.path,
                methods: Object.keys(r.route.methods),
            }));

        const runRoute = routes?.find((r: any) => r.path === '/run');
        expect(runRoute).toBeDefined();
        expect(runRoute?.methods).toContain('post');
    });

    it('POST /run uses config.defaultLanguage for new queue items', async () => {
        const { loadConfig } = await import('./config');
        const { getDb, runMigrations } = await import('./db/migrate');
        const { PublishQueueRepo } = await import('./db/repositories');

        // Set shared memory DB and language BEFORE creating app so config captures them
        process.env.DB_PATH = 'file:memdb_server_test?mode=memory&cache=shared';
        process.env.DEFAULT_LANGUAGE = 'fr'; // set language to french for test

        // Mock runPipeline to prevent actual execution
        const { vi } = await import('vitest');
        const runner = await import('./runner');
        vi.spyOn(runner, 'runPipeline').mockResolvedValue({ run_id: 'test-run-id', status_counts: {} } as any);

        // Pre-create and migrate the shared DB so the app finds tables
        const sharedDb = getDb(process.env.DB_PATH);
        runMigrations(sharedDb);

        // Create app AFTER setting env so config picks up the shared memory URI + language
        const testApp = createApp();

        const server = testApp.listen(0);
        const port = (server.address() as any).port;

        try {
            const res = await fetch(`http://localhost:${port}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyword: 'test keyword behavior' })
            });

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.status).toBe('started');

            // Verify the DB insertion has the correct language
            const dbItems = sharedDb.prepare('SELECT * FROM publish_queue WHERE picked_keyword = ?').all('test keyword behavior') as any[];
            expect(dbItems.length).toBe(1);
            expect(dbItems[0].language).toBe('fr');

        } finally {
            server.close();
            sharedDb.close();
        }
    });
});
