/**
 * Vitest suite for the Lovart opencli plugin.
 *
 * Pattern mirrors `clis/hackernews/hackernews.test.js` in upstream OpenCLI:
 *   - side-effect import each command .js so `cli({...})` registers it,
 *   - read metadata back via `getRegistry().get(...)` to lock the schema,
 *   - call `cmd.func(page, kwargs)` directly with a mocked `page`.
 *
 * Run with: `npm test`
 */
import { describe, expect, it, vi } from 'vitest';
import zlib from 'zlib';
import { getRegistry } from '@jackwener/opencli/registry';
import { AuthRequiredError } from '@jackwener/opencli/errors';
import {
    unwrapEvaluateResult,
    parseMeRows,
    decompressCanvasData,
    parseCanvasAssets,
    resolveListKind,
} from '../lib/utils.js';
import '../me.js';
import '../projects.js';
import '../detail.js';
import '../version.js';

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe('unwrapEvaluateResult', () => {
    it('returns the value as-is when it is not a bridge wrapper', () => {
        expect(unwrapEvaluateResult(42)).toBe(42);
        expect(unwrapEvaluateResult('hello')).toBe('hello');
        expect(unwrapEvaluateResult(null)).toBeNull();
    });

    it('unwraps the { session, data } bridge shape', () => {
        expect(unwrapEvaluateResult({ session: 's1', data: { ok: true } })).toEqual({ ok: true });
    });
});

describe('parseMeRows', () => {
    it('extracts name, email, plan, credits from a typical popover payload', () => {
        const out = parseMeRows([
            'Alice',
            'alice@example.com',
            'Pro',
            '120',
            '简体中文',
            '退出登录',
        ]);
        expect(out).toMatchObject({
            name: 'Alice',
            email: 'alice@example.com',
            plan: 'Pro',
            credits: '120',
            signout_visible: true,
        });
    });

    it('returns empty email when line 2 is not an email', () => {
        const out = parseMeRows(['Alice', 'Pro', '50', '简体中文']);
        expect(out.email).toBe('');
        expect(out.plan).toBe('Pro');
        expect(out.credits).toBe('50');
    });

    it('throws AuthRequiredError when popover is empty (not logged in)', () => {
        expect(() => parseMeRows([])).toThrow(AuthRequiredError);
    });

    it('marks signout_visible=false when the sign-out row is missing', () => {
        const out = parseMeRows(['Alice', 'alice@example.com', 'Free', '10', '简体中文']);
        expect(out.signout_visible).toBe(false);
    });
});

describe('decompressCanvasData', () => {
    function makeShakkerdata(obj) {
        const json = JSON.stringify(obj);
        const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
        return 'SHAKKERDATA://' + gz.toString('base64');
    }

    it('decompresses a gzip-wrapped payload and returns the parsed JSON', () => {
        const payload = { tldrawSnapshot: { document: { store: {} } } };
        const out = decompressCanvasData(makeShakkerdata(payload));
        expect(out).toEqual(payload);
    });

    it('returns null for the empty / non-prefix string', () => {
        expect(decompressCanvasData('')).toBeNull();
        expect(decompressCanvasData('not shakkerdata')).toBeNull();
    });

    it('returns null (does not throw) for corrupted base64', () => {
        expect(decompressCanvasData('SHAKKERDATA://!!!not-base64!!!')).toBeNull();
    });
});

describe('parseCanvasAssets', () => {
    function makeStore(shapes) {
        return {
            tldrawSnapshot: {
                document: {
                    store: Object.fromEntries(
                        shapes.map((s, i) => [`shape:${i}`, s]),
                    ),
                },
            },
        };
    }

    it('returns four empty buckets for null input', () => {
        const out = parseCanvasAssets(null);
        expect(out).toEqual({ genImages: [], genVideos: [], userImages: [], groupCount: 0 });
    });

    it('buckets c-image shapes by URL path (generator vs user)', () => {
        const data = makeStore([
            { id: 's1', type: 'c-image', props: { url: 'https://a.lovart.ai/artifacts/generator/a.png', w: 100, h: 200 } },
            { id: 's2', type: 'c-image', props: { url: 'https://a.lovart.ai/artifacts/user/b.png', w: 50, h: 60 } },
            { id: 's3', type: 'c-image', props: { url: 'https://a.lovart.ai/artifacts/agent/c.png', w: 10, h: 10 } },
        ]);
        const out = parseCanvasAssets(data);
        expect(out.genImages).toHaveLength(1);
        expect(out.genImages[0].kind).toBe('gen-image');
        expect(out.userImages).toHaveLength(1);
        expect(out.userImages[0].kind).toBe('user-image');
        // /artifacts/agent/ is intentionally skipped
    });

    it('captures c-video MP4 URLs and skips coverUrl-only entries', () => {
        const data = makeStore([
            { id: 'v1', type: 'c-video', props: { url: 'https://a.lovart.ai/artifacts/generator/v.mp4', w: 720, h: 1280 } },
            { id: 'v2', type: 'c-video', props: { url: 'https://a.lovart.ai/artifacts/user/v2.mp4', w: 1280, h: 720 } },
        ]);
        const out = parseCanvasAssets(data);
        expect(out.genVideos).toHaveLength(2);
        expect(out.genVideos.map(v => v.url)).toEqual([
            'https://a.lovart.ai/artifacts/generator/v.mp4',
            'https://a.lovart.ai/artifacts/user/v2.mp4',
        ]);
    });

    it('counts c-group shapes without producing assets', () => {
        const data = makeStore([
            { id: 'g1', type: 'c-group' },
            { id: 'g2', type: 'c-group' },
        ]);
        const out = parseCanvasAssets(data);
        expect(out.groupCount).toBe(2);
        expect(out.genImages).toHaveLength(0);
    });
});

describe('resolveListKind', () => {
    it('returns "" for empty / nullish input (caller treats it as summary-only)', () => {
        expect(resolveListKind('')).toBe('');
        expect(resolveListKind(undefined)).toBe('');
        expect(resolveListKind(null)).toBe('');
    });

    it('passes through canonical singular forms unchanged', () => {
        expect(resolveListKind('all')).toBe('all');
        expect(resolveListKind('image')).toBe('image');
        expect(resolveListKind('video')).toBe('video');
        expect(resolveListKind('upload')).toBe('upload');
    });

    it('maps common plural spellings to the canonical kind', () => {
        expect(resolveListKind('images')).toBe('image');
        expect(resolveListKind('videos')).toBe('video');
        expect(resolveListKind('uploads')).toBe('upload');
    });

    it('is case-insensitive', () => {
        expect(resolveListKind('IMAGE')).toBe('image');
        expect(resolveListKind('Videos')).toBe('video');
    });

    it('returns "" (silent fallback) for unknown values', () => {
        expect(resolveListKind('xyz')).toBe('');
        expect(resolveListKind('alll')).toBe('');
    });
});

// ---------------------------------------------------------------------------
// 2. Command metadata — lock the public schema so accidental edits surface.
// ---------------------------------------------------------------------------

describe('lovart/version metadata', () => {
    it('exposes name + version columns and uses PUBLIC strategy (no browser)', () => {
        const cmd = getRegistry().get('lovart/version');
        expect(cmd).toBeDefined();
        expect(cmd.columns).toEqual(['name', 'version']);
        expect(cmd.strategy).toBe('public');
        expect(cmd.browser).toBe(false);
    });
});

describe('lovart/project metadata', () => {
    const cmd = getRegistry().get('lovart/project');

    it('is registered with the expected columns', () => {
        expect(cmd.columns).toEqual(['type', 'size', 'info', 'url']);
    });

    it('declares the documented args (--list, --canvas, --export-canvas, --limit, --export-page)', () => {
        const names = (cmd.args || []).map((a) => a.name);
        expect(names).toEqual(expect.arrayContaining([
            'projectId', 'list', 'canvas', 'export-canvas', 'limit', 'export-page',
        ]));
    });

    it('--list is a string (so empty value is accepted as "summary only")', () => {
        const listArg = cmd.args.find((a) => a.name === 'list');
        expect(listArg.type).toBe('string');
        expect(listArg.default).toBe('');
    });

    it('--limit defaults to 10', () => {
        const limitArg = cmd.args.find((a) => a.name === 'limit');
        expect(limitArg.default).toBe(10);
    });
});

// ---------------------------------------------------------------------------
// 3. Command behaviour with a mocked page
// ---------------------------------------------------------------------------

function pageEvaluateOnce(impl) {
    return { evaluate: vi.fn().mockImplementation(impl) };
}

describe('lovart/project error path', () => {
    it('throws AuthRequiredError when usertoken cookie is missing', async () => {
        const cmd = getRegistry().get('lovart/project');
        const page = pageEvaluateOnce(() =>
            Promise.resolve({ ok: false, error: 'usertoken cookie missing' }),
        );
        await expect(cmd.func(page, { projectId: 'a1b2c3d4e5f6789012345678abcdef01' }))
            .rejects.toBeInstanceOf(AuthRequiredError);
    });
});

describe('lovart/version command', () => {
    it('returns the manifest version without touching a page', async () => {
        const cmd = getRegistry().get('lovart/version');
        const rows = await cmd.func(undefined, {});
        const { version } = JSON.parse(await import('fs/promises').then(m => m.readFile('./opencli-plugin.json', 'utf-8')));
        expect(rows).toEqual([{ name: 'lovart', version }]);
    });
});
