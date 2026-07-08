import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');

/**
 * Slice the final multi-stage build (the "runner" stage) — that is what ships
 * in the runtime image, so only COPY directives inside it matter.
 */
function runnerStage(text: string): string {
    const fromIndices = [...text.matchAll(/^FROM\s/gm)].map((m) => m.index ?? 0);
    return text.slice(fromIndices[fromIndices.length - 1]);
}

describe('Dockerfile runner stage runtime dependencies', () => {
    it('copies bcryptjs so seed-admin.js can require() it at runtime', () => {
        // seed-admin.js does `require('bcryptjs')`, whose "main" is umd/index.js.
        // The Next.js standalone trace ships only the ESM entry, so the package
        // must be copied explicitly into the runner image (regression guard).
        const stage = runnerStage(dockerfile);
        const copiesBcryptjs = /^COPY\b[^\n]*?\s\/app\/node_modules\/bcryptjs\s+\.\/node_modules\/bcryptjs\s*$/m.test(stage);

        expect(
            copiesBcryptjs,
            "Runner stage must COPY /app/node_modules/bcryptjs to ./node_modules/bcryptjs, " +
                'otherwise seed-admin.js fails with MODULE_NOT_FOUND at container startup.',
        ).toBe(true);
    });
});
