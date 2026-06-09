/**
 * Shared helpers for the Lovart plugin.
 *
 * Strategy is `UI` — Lovart is a React SPA, login state lives in cookies,
 * and project / account data is rendered in DOM. No public API.
 *
 * Selectors of note (verified 2026-06):
 *   - Avatar trigger in the top nav: [data-testid="avatar-trigger"]
 *   - User popover that opens from the trigger: [data-testid="avatar-popover-content"]
 *   - Projects grid: [role=grid] containing [role=gridcell] cards
 *   - Individual card text format: "项目名\n更新于 MMM D, YYYY"
 *
 * Project canvas URLs are JS-routed (no static <a href>), so reaching the
 * canvas requires an extra click — we don't return project ids from
 * `projects` here; agents can grab the name and feed it to follow-up
 * commands once `canvas <id|search>` lands.
 */
import { AuthRequiredError } from '@jackwener/opencli/errors';
import zlib from 'zlib';

export const LOVART_DOMAIN = 'www.lovart.ai';
export const LOVART_HOMEPAGE = 'https://www.lovart.ai/zh/home';
export const LOVART_PROJECTS = 'https://www.lovart.ai/zh/projects';

/**
 * Bridge wraps primitive `page.evaluate` returns as `{ session, data: <value> }`
 * so unwrap before inspecting the result.
 */
export function unwrapEvaluateResult<T = unknown>(value: unknown): T {
    if (value && typeof value === 'object' && 'session' in value && 'data' in value) {
        return (value as { data: T }).data;
    }
    return value as T;
}

const POPOVER_TIMEOUT_MS = 5000;

export interface LovartMe {
    name: string;
    email: string;
    plan: string;
    credits: string;
    profile_url: string;
    signout_visible: boolean;
}

export interface LovartProject {
    name: string;
    updated: string;
    id: string;
    url: string;
    picCount: number;
    isFavorite: boolean;
    projectType: number;
}

/**
 * Open the avatar popover and return a single identity row.
 *
 * Throws AuthRequiredError when the avatar trigger is missing (not logged in)
 * or the popover never appears.
 */
export async function readLovartMe(page: any): Promise<LovartMe[]> {
    await page.goto(LOVART_HOMEPAGE);
    await page.wait({ selector: '[data-testid="primaryColumn"], body', timeoutMs: 8000 });

    const trigger = unwrapEvaluateResult<boolean>(await page.evaluate(
        `(() => !!document.querySelector('[data-testid="avatar-trigger"]'))()`
    ));
    if (!trigger) {
        throw new AuthRequiredError(LOVART_DOMAIN, 'Lovart avatar trigger not found. Are you logged in to lovart.ai?');
    }

    await page.click('[data-testid="avatar-trigger"]');

    let raw: string[] | null = null;
    for (let i = 0; i < POPOVER_TIMEOUT_MS / 250; i++) {
        raw = unwrapEvaluateResult<string[] | null>(await page.evaluate(
            `(() => {
                const pop = document.querySelector('[data-testid="avatar-popover-content"]');
                if (!pop) return null;
                const lines = (pop.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
                return lines;
            })()`
        ));
        if (Array.isArray(raw) && raw.length) break;
        await page.wait(0.25);
    }

    if (!Array.isArray(raw) || raw.length === 0) {
        throw new AuthRequiredError(LOVART_DOMAIN, 'Lovart avatar popover did not open. Are you logged in?');
    }

    return [parseMeRows(raw)];
}

/**
 * Parse the popover innerText into a single identity row.
 *
 * The popover layout (verified 2026-06) is roughly:
 *   0: nickname
 *   1: email
 *   2: plan name (e.g. "Ultimate", "Free")
 *   3: credits (numeric string, e.g. "15160")
 *   4: 查看我的权益   (link)
 *   5: 创建团队       (link, optional)
 *   6: 账户管理       (link)
 *   7: 使用指南       (link)
 *   8: 联系我们       (link)
 *   9: locale label   (e.g. "简体中文")
 *  10: footer logo
 *  11: 退出登录       (sign-out, optional)
 */
export function parseMeRows(lines: string[]): LovartMe {
    if (!Array.isArray(lines) || !lines.length) {
        throw new AuthRequiredError(LOVART_DOMAIN, 'Lovart popover returned no content.');
    }
    const name = lines[0] || '';
    const email = (lines[1] || '').includes('@') ? lines[1] : '';
    let plan = '';
    let credits = '';
    for (let i = 0; i < lines.length; i++) {
        if (/^\d+$/.test(lines[i])) {
            credits = lines[i];
            for (let j = 0; j < i; j++) {
                if (lines[j] && lines[j] !== name && lines[j] !== email) {
                    plan = lines[j];
                    break;
                }
            }
            break;
        }
    }
    return {
        name,
        email,
        plan,
        credits,
        profile_url: `${LOVART_DOMAIN}/zh/profile`,
        signout_visible: lines.includes('退出登录'),
    };
}

/**
 * Fetch every Lovart project via the canva API. Walks the
 * `hasMore` cursor in 30-row pages so we don't depend on the grid
 * being painted in the DOM. The `usertoken` cookie is the auth —
 * the adapter rides it via the JWT `token` header the studio
 * frontend uses.
 *
 * Project URL pattern: `https://www.lovart.ai/canvas?projectId=<id>`
 * (32-char hex, same shape as the link we already saw on click).
 */
export async function readLovartProjects(page: any, { limit = 200 }: { limit?: number } = {}): Promise<LovartProject[]> {
    await page.goto(LOVART_PROJECTS);
    await page.wait({ selector: 'body', timeoutMs: 8000 });

    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 200;
    const rows = await fetchAllProjects(page, safeLimit);
    return rows;
}

interface LovartListItem {
    projectId: string;
    projectName: string;
    projectCoverList: string[];
    picCount: number;
    isFavorite: number;
    projectType: number;
    updateTime: number; // ms epoch
    createTime: number | null;
}

const LIST_PAGE_SIZE = 30;
const LIST_BODY = JSON.stringify({ page: 1, pageSize: LIST_PAGE_SIZE });

async function fetchAllProjects(page: any, limit: number): Promise<LovartProject[]> {
    const collected: LovartProject[] = [];
    let pageNum = 1;
    // Cap inner pages to avoid loops if the server misbehaves.
    while (collected.length < limit && pageNum < 50) {
        const payload = JSON.stringify({ page: pageNum, pageSize: LIST_PAGE_SIZE });
        const result = unwrapEvaluateResult<{
            ok: boolean;
            items?: LovartListItem[];
            total?: number;
            hasMore?: boolean;
            error?: string;
            status?: number;
        }>(await page.evaluate(`
            (async () => {
                const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || '';
                if (!tok) return { ok: false, error: 'usertoken cookie missing' };
                let resp;
                try {
                    resp = await fetch('/api/canva/project/lovartProjectList?timestamp=' + Date.now(), {
                        method: 'POST',
                        headers: { 'token': tok, 'x-language': 'zh', 'Content-Type': 'application/json' },
                        body: ${JSON.stringify(payload)},
                        credentials: 'include',
                    });
                } catch (e) {
                    return { ok: false, error: 'fetch failed: ' + String(e && e.message || e) };
                }
                if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status, status: resp.status };
                let body;
                try { body = await resp.json(); } catch (e) { return { ok: false, error: 'malformed JSON' }; }
                if (body?.code !== 0 && body?.code !== '0') {
                    return { ok: false, error: 'API code ' + body?.code + ' ' + (body?.msg || '') };
                }
                return {
                    ok: true,
                    items: Array.isArray(body?.data?.data) ? body.data.data : [],
                    total: body?.data?.total || 0,
                    hasMore: Boolean(body?.data?.hasMore),
                };
            })()
        `));

        if (!result || !result.ok) {
            throw new AuthRequiredError(LOVART_DOMAIN, result?.error || 'Lovart projects API failed.');
        }
        const items = Array.isArray(result.items) ? result.items : [];
        for (const it of items) {
            if (!it?.projectId || !it?.projectName) continue;
            collected.push(mapListItem(it));
            if (collected.length >= limit) break;
        }
        if (!result.hasMore || items.length === 0) break;
        pageNum++;
    }
    return collected;
}

function mapListItem(it: LovartListItem): LovartProject {
    return {
        id: it.projectId,
        name: it.projectName,
        url: `https://www.lovart.ai/canvas?projectId=${it.projectId}`,
        picCount: it.picCount || 0,
        isFavorite: Boolean(it.isFavorite),
        projectType: it.projectType || 0,
        updated: formatDate(it.updateTime),
    };
}

function formatDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// SHAKKERDATA decompression (gzip + base64)
// ---------------------------------------------------------------------------

/**
 * Decompress Lovart's canvas blob (SHAKKERDATA://<base64-gzip>).
 * Returns the parsed JSON object, or null on failure.
 */
export function decompressCanvasData(raw: string): LovartCanvasDataV1 | null {
    if (!raw || !raw.startsWith('SHAKKERDATA://')) return null;
    try {
        const b64 = raw.slice('SHAKKERDATA://'.length);
        const compressed = Buffer.from(b64, 'base64');
        const decompressed = zlibGunzip(compressed);
        const text = new TextDecoder('utf-8', { fatal: false }).decode(decompressed);
        return JSON.parse(text) as LovartCanvasDataV1;
    } catch {
        return null;
    }
}

function zlibGunzip(buf: Buffer): Buffer {
    // Detect if gzip-wrapped (magic bytes 1f 8b) or raw deflate
    if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
    return zlib.inflateSync(buf);
}

/**
 * Valid kinds accepted by the `--list` flag of `project`.
 * Kept as a Set so membership checks are O(1).
 */
export const LIST_KINDS: ReadonlySet<string> = new Set(['all', 'image', 'video', 'upload']);

/**
 * `all-tree` is a separate kind that returns the canvas as a structured
 * tree (containers + their children) instead of a flat list. Rows carry
 * a `parent` field so callers can rebuild the tree from any output format.
 */
export const LIST_KIND_TREE = 'all-tree';

/**
 * Map of common plural spellings to the canonical singular kind.
 * Lets users type `--list images` (or `videos` / `uploads`) without
 * having to remember the singular form.
 */
export const LIST_ALIASES: Readonly<Record<string, string>> = {
    images: 'image',
    videos: 'video',
    uploads: 'upload',
    trees: 'all-tree',
    tree: 'all-tree',
};

/**
 * Normalize a raw `--list` value to a canonical kind, or '' when the
 * input is missing / unrecognized. Returning '' lets the caller treat
 * it as "summary only" without further branching.
 */
export function resolveListKind(raw: unknown): string {
    const v = String(raw ?? '').toLowerCase();
    if (!v) return '';
    const normalized = LIST_ALIASES[v] ?? v;
    return LIST_KINDS.has(normalized) ? normalized : '';
}

// ---------------------------------------------------------------------------
// Project detail (queryProject)
// ---------------------------------------------------------------------------

export interface LovartAsset {
    shapeId: string;
    url: string;
    w: number;
    h: number;
    /** 'gen-image' | 'gen-video' | 'user-image' | 'user-video' */
    kind: string;
}

export interface LovartProjectDetail {
    projectId: string;
    projectName: string;
    url: string;
    projectType: number;
    version: string;
    isValidProject: boolean;
    isTitleChanged: boolean;
    isNewProject: boolean;
    canvasDataV1: LovartCanvasDataV1 | null;
    genImages: LovartAsset[];
    genVideos: LovartAsset[];
    userImages: LovartAsset[];
    groupCount: number;
}

export interface LovartCanvasDataV1 {
    tldrawSnapshot?: TldrawSnapshot;
    [key: string]: unknown;
}

export interface TldrawSnapshot {
    document: TldrawDocument;
    store?: unknown;
    session?: TldrawSession;
}

export interface TldrawDocument {
    records: Record<string, TldrawShape>;
    schema?: unknown;
}

export interface TldrawSession {
    pageStates: TldrawPageState[];
}

export interface TldrawPageState {
    id: string;
    camera?: { x: number; y: number; z: number };
    editingId?: string | null;
}

export interface TldrawShape {
    id: string;
    type: string;
    props?: {
        url?: string;
        coverUrl?: string;
        w?: number;
        h?: number;
        [key: string]: unknown;
    };
    parentId?: string;
}

/**
 * Fetch `usertoken` from the current page's cookies and call the
 * `canva/project/queryProject` API directly from node (no page.goto needed).
 *
 * Auth: `usertoken` cookie forwarded as `token` header.
 * The API retries once on 401 because Lovart sometimes sends a stale cookie.
 */
async function queryProjectFromNode(
    page: any,
    projectId: string,
): Promise<{
    ok: boolean;
    data?: {
        canvas: string | null;
        projectId: string;
        projectName: string;
        projectType: number;
        version: string;
        userId: string;
        validProjectId: string;
    };
    error?: string;
}> {
    const wrapped = await page.evaluate(`
        (async () => {
            const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || '';
            if (!tok) return { ok: false, error: 'usertoken cookie missing' };
            const body = JSON.stringify({ projectId: ${JSON.stringify(projectId)} });
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const resp = await fetch('/api/canva/project/queryProject', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'token': tok,
                            'x-language': 'zh',
                        },
                        body,
                        credentials: 'include',
                    });
                    const json = await resp.json();
                    if (json?.code === 0 || json?.code === '0') {
                        return { ok: true, data: json.data };
                    }
                    if (json?.code === 401 && attempt === 0) continue;
                    return { ok: false, error: 'API code ' + json?.code + ' ' + (json?.msg || ''), data: json?.data };
                } catch (e) {
                    return { ok: false, error: 'fetch failed: ' + String(e && e.message || e) };
                }
            }
        })()
    `);
    return unwrapEvaluateResult(wrapped);
}

/**
 * Call `canva/project/queryProject` and parse the canvasDataV1 JSON blob.
 *
 * No browser navigation needed — extracts the usertoken from the current page
 * and calls the API directly from node.
 */
export async function readLovartProject(
    page: any,
    projectId: string,
): Promise<LovartProjectDetail> {
    const result = await queryProjectFromNode(page, projectId);

    if (!result || !result.ok) {
        throw new AuthRequiredError(
            LOVART_DOMAIN,
            result?.error || 'Lovart queryProject API failed.',
        );
    }

    const d = result.data!;
    // canvas field may be:
    //   - null/empty  → new or empty project
    //   - SHAKKERDATA://<base64-gzip> → compressed canvas JSON
    //   - plain JSON  → already-parsed canvasDataV1 (fallback)
    const raw = d.canvas ?? '';

    let canvasDataV1: LovartCanvasDataV1 | null = null;
    if (raw) {
        if (raw.startsWith('SHAKKERDATA://')) {
            canvasDataV1 = decompressCanvasData(raw);
        } else {
            try {
                canvasDataV1 = JSON.parse(raw) as LovartCanvasDataV1;
            } catch {
                // Non-fatal
            }
        }
    }

    // If API didn't return canvas, try localStorage (tldraw persistence)
    if (!canvasDataV1) {
        canvasDataV1 = await readCanvasFromLocalStorage(page, projectId);
    }

    // Extract assets from canvas JSON; DOM fallback only if canvas is empty
    const { genImages, genVideos, userImages, groupCount } = parseCanvasAssets(canvasDataV1);

    let allAssets = [...genImages, ...genVideos, ...userImages];
    if (allAssets.length === 0) {
        allAssets = await readImagesFromDOM(page, projectId).then(imgs =>
            imgs.map(img => ({ shapeId: '', url: img.url, w: img.w, h: img.h,
                kind: img.type === 'generator' ? 'gen-image' : img.type === 'user' ? 'user-image' : 'gen-image' })),
        );
    }

    return {
        projectId: d.projectId || projectId,
        projectName: d.projectName ?? '',
        url: `https://www.lovart.ai/canvas?projectId=${d.projectId || projectId}`,
        projectType: d.projectType ?? 3,
        version: d.version ?? '',
        isValidProject: false,
        isTitleChanged: false,
        isNewProject: false,
        canvasDataV1,
        genImages,
        genVideos,
        userImages,
        groupCount,
    };
}

/**
 * Read the canvas snapshot from localStorage. Lovart uses tldraw's
 * `storeWithStatus` persistence — the snapshot key includes the projectId.
 */
async function readCanvasFromLocalStorage(
    page: any,
    projectId: string,
): Promise<LovartCanvasDataV1 | null> {
    const raw = unwrapEvaluateResult<string | null>(await page.evaluate(
        (pid: string) => {
            try {
                // Try the tldraw localStorage key pattern
                const key = 'tldraw/' + pid;
                let raw = localStorage.getItem(key);
                if (!raw) {
                    // Wildcard search for any key containing the projectId
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        if (k && k.includes(pid)) {
                            raw = localStorage.getItem(k);
                            break;
                        }
                    }
                }
                return raw ?? null;
            } catch {
                return null;
            }
        },
        projectId,
    ));

    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && (parsed as any).tldrawSnapshot) {
            return parsed as LovartCanvasDataV1;
        }
    } catch {
        // Not JSON
    }
    return null;
}

async function readImagesFromDOM(
    page: any,
    projectId: string,
): Promise<LovartAsset[]> {
    const images: LovartAsset[] = [];

    const imgResults = unwrapEvaluateResult<Array<{ src: string; width: number; height: number }>>(
        await page.evaluate(`
            () => {
                const imgs = Array.from(document.querySelectorAll('img'));
                return imgs.map(img => ({
                    src: img.currentSrc || img.src,
                    width: img.naturalWidth || img.width || 0,
                    height: img.naturalHeight || img.height || 0,
                }));
            }
        `),
    );

    if (Array.isArray(imgResults)) {
        for (const img of imgResults) {
            if (!img.src || !img.src.startsWith('http')) continue;
            let kind: LovartAsset['kind'] = 'gen-image';
            if (img.src.includes('/artifacts/generator/')) kind = 'gen-image';
            else if (img.src.includes('/artifacts/user/')) kind = 'user-image';
            else if (img.src.includes('/artifacts/agent/')) kind = 'gen-image';
            else continue;

            images.push({ shapeId: '', url: img.src, w: img.width, h: img.height, kind });
        }
    }

    return images;
}

/**
 * Parse all canvas assets from a tldrawSnapshot into typed buckets.
 *
 * Shape types in Lovart's canvas:
 *   c-image  → image shape
 *     - /artifacts/generator/ → genImages
 *     - /artifacts/user/      → userImages
 *     - /artifacts/agent/     → skipped (UI assets)
 *   c-video  → video shape
 *     - props.url (.mp4)      → genVideos
 *     - props.coverUrl         → skipped (poster, not a separate asset)
 *   c-group  → group container (counted, no URL)
 *
 * tldraw v2 shape store: document.store = { 'shape:<id>': { id, type, props, ... } }
 */
export function parseCanvasAssets(canvasDataV1: LovartCanvasDataV1 | null): {
    genImages: LovartAsset[];
    genVideos: LovartAsset[];
    userImages: LovartAsset[];
    groupCount: number;
} {
    const genImages: LovartAsset[] = [];
    const genVideos: LovartAsset[] = [];
    const userImages: LovartAsset[] = [];
    let groupCount = 0;

    if (!canvasDataV1) return { genImages, genVideos, userImages, groupCount };

    const store = (canvasDataV1 as any).tldrawSnapshot?.document?.store;
    if (!store || typeof store !== 'object') return { genImages, genVideos, userImages, groupCount };

    for (const [, raw] of Object.entries(store)) {
        if (!raw || typeof raw !== 'object') continue;
        const shape = raw as Record<string, unknown>;
        const stype = String(shape.type ?? '');
        const props = shape.props as Record<string, unknown> | undefined;

        if (stype === 'c-image') {
            const url = String(props?.url ?? '');
            if (!url) continue;
            const asset = { shapeId: String(shape.id), url, w: Number(props?.w ?? 0), h: Number(props?.h ?? 0), kind: 'gen-image' as const };
            if (url.includes('/artifacts/generator/')) genImages.push(asset);
            else if (url.includes('/artifacts/user/')) userImages.push({ ...asset, kind: 'user-image' as const });
            // agent assets skipped
        } else if (stype === 'c-video') {
            const mp4Url = String(props?.url ?? '');
            if (mp4Url) genVideos.push({ shapeId: String(shape.id), url: mp4Url, w: Number(props?.w ?? 0), h: Number(props?.h ?? 0), kind: 'gen-video' as const });
        } else if (stype === 'c-group') {
            groupCount++;
        }
    }

    return { genImages, genVideos, userImages, groupCount };
}

// ---------------------------------------------------------------------------
// Canvas tree (containers + children) — for --list all-tree
// ---------------------------------------------------------------------------

/**
 * A single row in the --list all-tree output.
 *
 * Every row carries a `parent` field. Containers (frames / groups) have
 * `parent: null` and are referenced by their `id` from the children they
 * contain. Top-level material shapes have `parent: null` too. This
 * means: walk the list, build a map by id, and rebuild the tree from
 * `parent` — works identically in json / yaml / csv / md output.
 */
/**
 * A single row in the --list all-tree output.
 *
 * Every field is a direct, traceable projection of the canvas data —
 * no derived emojis, no synthetic markers. Agents consuming this output
 * should be able to round-trip any value back to its source shape.
 *
 * Field → source mapping:
 *   id       → canvas `shape.<id>` (or the literal "summary" for the project header)
 *   parent   → canvas `shape.parentId` (or null when top-level or summary)
 *   type     → canvas `shape.type` — raw enum ('c-image' | 'c-video' | 'frame' | 'group');
 *             the synthetic value 'summary' marks the project header row
 *   source   → canvas `shape.meta.source` ('ai' | 'user') mapped to ('ai' | 'upload');
 *             containers and summary use '—'
 *   name     → canvas `shape.props.name` (containers) or `'(unnamed)'` fallback
 *   size     → canvas `shape.props.{w,h}` joined as 'WxH' (rounded); containers and summary use '—'
 *   duration → canvas `shape.props.duration` (seconds, as a number) for video rows; null otherwise.
 *             Raw number — not a string with units — so callers can do arithmetic without parsing.
 *   task     → first 8 chars of canvas `shape.props.generatorTaskId`, or '—'
 *   url      → canvas `shape.props.url` (or `props.originalUrl` for the cover image of videos), or '—'
 */
export interface CanvasTreeRow {
    /** Shape id (`shape:...`) for shapes, or the literal string "summary" for the project header row */
    id: string;
    /** null for summary / top-level containers / top-level materials; otherwise the container shape id */
    parent: string | null;
    /** 'summary' | 'frame' | 'group' | 'c-image' | 'c-video' — raw canvas type (no decoration) */
    type: 'summary' | 'frame' | 'group' | 'c-image' | 'c-video';
    /** 'ai' | 'upload' | '—' */
    source: 'ai' | 'upload' | '—';
    /** Container or material name; '(unnamed)' fallback when canvas props.name is missing */
    name: string;
    /** 'WxH' for materials, '—' for containers */
    size: string;
    /** Video duration in seconds (raw number) or null for non-video / container / summary rows */
    duration: number | null;
    /** First 8 chars of generatorTaskId, or '—' */
    task: string;
    /** Full URL (no truncation) or '—' */
    url: string;
}

export interface CanvasTree {
    /** Project summary row, always first */
    summary: CanvasTreeRow;
    /** Containers (frame + group) and their children, plus top-level materials — all in render order */
    rows: CanvasTreeRow[];
    /** Counts for the summary */
    counts: {
        aiImages: number;
        aiVideos: number;
        uploads: number;
        containers: number;
        frameChildren: number;
    };
}

/**
 * Build the structured tree rows from a parsed canvas snapshot.
 *
 * Render order:
 *   1) summary row (parent: null, kind: 'summary')
 *   2) for each container (frame / group) sorted by y then x:
 *        - the container row (parent: null)
 *        - its child shapes sorted by y then x, with parent set to the container id
 *   3) top-level materials (parentId === 'page:page'), sorted by y then x
 *
 * Two shapes that share the same generatorTaskId are placed next to each
 * other when possible; the second one gets a `⚝` shareMarker so it's
 * visible in the md/table output.
 */
export function parseCanvasTree(
    canvasDataV1: LovartCanvasDataV1 | null,
    projectName: string,
    projectId: string,
    projectType: number,
    projectUrl: string,
): CanvasTree {
    const store = (canvasDataV1 as any)?.tldrawSnapshot?.document?.store;
    const rows: CanvasTreeRow[] = [];

    const summary: CanvasTreeRow = {
        id: 'summary',
        parent: null,
        type: 'summary',
        source: '—',
        size: '—',
        name: projectName || '—',
        duration: null,
        task: '—',
        url: projectUrl || '—',
    };

    if (!store || typeof store !== 'object') {
        return {
            summary,
            rows: [summary],
            counts: { aiImages: 0, aiVideos: 0, uploads: 0, containers: 0, frameChildren: 0 },
        };
    }

    // Build a quick id -> raw map once.
    const byId: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(store)) {
        if (v && typeof v === 'object') byId[k] = v as Record<string, unknown>;
    }

    // Identify containers: 'frame' (Lovart hard container, children use parentId)
    // and 'group' (tldraw native, children may or may not be inside via parentId).
    const containers: Array<{ id: string; raw: Record<string, unknown>; kind: 'frame' | 'group' }> = [];
    for (const [id, raw] of Object.entries(byId)) {
        const t = String(raw.type ?? '');
        if (t === 'frame' || t === 'group') {
            containers.push({ id, raw, kind: t as 'frame' | 'group' });
        }
    }

    // Sort containers by (y, x)
    const sortByPos = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
        const ay = Number(a.y ?? 0), by = Number(b.y ?? 0);
        if (ay !== by) return ay - by;
        return Number(a.x ?? 0) - Number(b.x ?? 0);
    };
    containers.sort((a, b) => sortByPos(a.raw, b.raw));

    // Build rows
    let aiImages = 0, aiVideos = 0, uploads = 0, frameChildren = 0;
    const lastTaskPerContainer = new Map<string, string>();

    for (const { id, raw, kind } of containers) {
        const props = (raw.props as Record<string, unknown> | undefined) ?? {};
        const w = Number(props.w ?? 0), h = Number(props.h ?? 0);
        const name = String(props.name ?? '—').trim() || '—';
        const containerRow: CanvasTreeRow = {
            id,
            parent: null,
            type: kind,
            source: '—',
            size: w > 0 && h > 0 ? `${Math.round(w)}×${Math.round(h)}` : '—',
            name,
            duration: null,
            task: '—',
            url: '—',
        };
        rows.push(containerRow);

        // Find children: shapes whose parentId === this container id.
        const children: Record<string, unknown>[] = [];
        for (const [cid, cs] of Object.entries(byId)) {
            if (cs.parentId === id) children.push(cs as Record<string, unknown>);
        }
        children.sort(sortByPos);

        for (const cs of children) {
            const ct = String(cs.type ?? '');
            const cp = (cs.props as Record<string, unknown> | undefined) ?? {};
            const cName = String(cp.name ?? '').trim() || '(unnamed)';
            const cUrl = String(cp.url ?? '');
            const cTask = String(cp.generatorTaskId ?? '');
            const cw = Number(cp.w ?? 0), ch = Number(cp.h ?? 0);
            const source = String((cs.meta as any)?.source ?? '—');
            const dur = cp.duration != null ? Number(cp.duration) : null;

            let rowKind: 'c-image' | 'c-video' = 'c-image';
            if (ct === 'c-video') rowKind = 'c-video';
            else if (ct === 'c-image') rowKind = 'c-image';
            else continue; // skip non-material children

            // For media: only count if the URL matches a real artifact path.
            // (Defensive: tldraw can carry editor-internal shapes too.)
            const isGenerator = cUrl.includes('/artifacts/generator/');
            const isUser = cUrl.includes('/artifacts/user/');
            if (!isGenerator && !isUser && rowKind === 'c-image') continue;

            if (isGenerator && rowKind === 'c-image') aiImages++;
            else if (isGenerator && rowKind === 'c-video') aiVideos++;
            else if (isUser) uploads++;

            if (kind === 'frame') frameChildren++;

            // Track task ids so the caller can detect shared-task groups;
            // no synthetic visual marker is added to rows.
            if (cTask) lastTaskPerContainer.set(id, cTask);

            const url = cUrl || '—';
            const size = cw > 0 && ch > 0 ? `${Math.round(cw)}×${Math.round(ch)}` : '—';

            rows.push({
                id: String(cs.id ?? `${id}:${rows.length}`),
                parent: id,
                type: rowKind,
                source,
                size,
                name: cName,
                duration: rowKind === 'c-video' ? dur : null,
                task: cTask ? cTask.slice(0, 8) : '—',
                url,
            });
        }
    }

    // Top-level materials: parentId === 'page:page' AND type is c-image / c-video
    const topLevel: Record<string, unknown>[] = [];
    for (const cs of Object.values(byId)) {
        if (cs.parentId !== 'page:page') continue;
        const ct = String(cs.type ?? '');
        if (ct !== 'c-image' && ct !== 'c-video') continue;
        topLevel.push(cs);
    }
    topLevel.sort(sortByPos);

    let lastTopTask = '';
    for (const cs of topLevel) {
        const ct = String(cs.type ?? '');
        const cp = (cs.props as Record<string, unknown> | undefined) ?? {};
        const cName = String(cp.name ?? '').trim() || '(unnamed)';
        const cUrl = String(cp.url ?? '');
        const cTask = String(cp.generatorTaskId ?? '');
        const cw = Number(cp.w ?? 0), ch = Number(cp.h ?? 0);
        const source = String((cs.meta as any)?.source ?? '—');
        const dur = cp.duration != null ? Number(cp.duration) : null;

        const isGenerator = cUrl.includes('/artifacts/generator/');
        const isUser = cUrl.includes('/artifacts/user/');
        if (!isGenerator && !isUser && ct === 'c-image') continue;

        if (isGenerator && ct === 'c-image') aiImages++;
        else if (isGenerator && ct === 'c-video') aiVideos++;
        else if (isUser) uploads++;

        // Track task ids so the caller can detect shared-task groups;
        // no synthetic visual marker is added to rows.
        if (cTask) lastTopTask = cTask;

        const url = cUrl || '—';
        const size = cw > 0 && ch > 0 ? `${Math.round(cw)}×${Math.round(ch)}` : '—';

        rows.push({
            id: String(cs.id ?? `top:${rows.length}`),
            parent: null,
            type: ct === 'c-video' ? 'c-video' : 'c-image',
            source,
            size,
            name: cName,
            duration: ct === 'c-video' ? dur : null,
            task: cTask ? cTask.slice(0, 8) : '—',
            url,
        });
    }

    const counts = {
        aiImages,
        aiVideos,
        uploads,
        containers: containers.length,
        frameChildren,
    };
    return { summary, rows: [summary, ...rows], counts };
}


/**
 * Dump every scrapable piece of canvas page state to a JSON file.
 *
 * This is a debug/analysis tool — it collects:
 *   1. localStorage keys+values (filtered to lovart domain)
 *   2. sessionStorage keys+values
 *   3. window variables that look like state (REDUX, __INITIAL_STATE__, etc.)
 *   4. DOM snapshot: tag counts, data attributes, aria labels
 *   5. The raw queryProject API response (full body)
 *   6. Network request metadata (via Performance API)
 */
export async function dumpLovartProjectPage(
    page: any,
    projectId: string,
    outputPath: string,
): Promise<void> {
    const canvasUrl = `https://www.lovart.ai/canvas?projectId=${projectId}`;
    await page.goto(canvasUrl);
    await page.wait({ selector: 'body', timeoutMs: 8000 });
    await page.wait(3000); // let studio hydrate

    const fs = await import('fs');

    const dump = unwrapEvaluateResult<Record<string, unknown>>(await page.evaluate(
        (pid: string) => {
            const result: Record<string, unknown> = {};

            // --- localStorage ---
            const ls: Record<string, string> = {};
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i) || '';
                    const v = localStorage.getItem(k) || '';
                    ls[k] = v.length > 2000 ? v.slice(0, 2000) + '... [TRUNCATED]' : v;
                }
            } catch { ls['_error'] = 'inaccessible'; }
            result['localStorage'] = ls;

            // --- sessionStorage ---
            const ss: Record<string, string> = {};
            try {
                for (let i = 0; i < sessionStorage.length; i++) {
                    const k = sessionStorage.key(i) || '';
                    const v = sessionStorage.getItem(k) || '';
                    ss[k] = v.length > 2000 ? v.slice(0, 2000) + '... [TRUNCATED]' : v;
                }
            } catch { ss['_error'] = 'inaccessible'; }
            result['sessionStorage'] = ss;

            // --- window globals that look like state ---
            const stateGlobals: Record<string, unknown> = {};
            const stateKeys = [
                '__REDUX__', '__STATE__', '__INITIAL_STATE__',
                '__NEXT_DATA__', '__NUXT__', '__TLDRAW__',
                'reduxStore', 'store', '__canvas__',
                '__tldraw__', '__lovart__', '__studio__',
            ];
            for (const key of stateKeys) {
                try {
                    const val = (window as any)[key];
                    if (val !== undefined) {
                        const str = typeof val === 'string' ? val : JSON.stringify(val);
                        stateGlobals[key] = str.length > 3000 ? str.slice(0, 3000) + '... [TRUNCATED]' : str;
                    }
                } catch { /* skip */ }
            }
            result['stateGlobals'] = stateGlobals;

            // --- DOM snapshot ---
            const allEls = document.querySelectorAll('*');
            const tagCounts: Record<string, number> = {};
            allEls.forEach(el => {
                const tag = el.tagName.toLowerCase();
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });

            const dataAttrs = new Set<string>();
            const ariaAttrs = new Set<string>();
            allEls.forEach(el => {
                Array.from(el.attributes).forEach(attr => {
                    if (attr.name.startsWith('data-')) dataAttrs.add(attr.name);
                    if (attr.name.startsWith('aria-')) ariaAttrs.add(attr.name);
                });
            });

            result['domStats'] = {
                totalElements: allEls.length,
                tagCounts,
                dataAttributes: Array.from(dataAttrs).sort(),
                ariaAttributes: Array.from(ariaAttrs).sort(),
                imgs: document.querySelectorAll('img').length,
                videos: document.querySelectorAll('video').length,
                iframes: document.querySelectorAll('iframe').length,
                svgs: document.querySelectorAll('svg').length,
                tldrawElements: Array.from(allEls)
                    .filter(el => Array.from(el.attributes).some(a => a.name.startsWith('data-tldraw')))
                    .map(el => ({
                        tag: el.tagName,
                        attrs: Array.from(el.attributes)
                            .map(a => ({ n: a.name, v: a.value.slice(0, 100) })),
                    })),
            };

            // --- Performance API entries (recent fetch/XHR) ---
            try {
                const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
                result['performanceEntries'] = entries
                    .filter(e => e.name.includes('lovart') || e.name.includes('canva') || e.name.includes('canas'))
                    .map(e => ({
                        name: e.name.slice(0, 200),
                        type: e.initiatorType,
                        duration: Math.round(e.duration),
                    }));
            } catch { result['performanceEntries'] = []; }

            return result;
        },
        projectId,
    ));

    // --- queryProject API (raw full response) ---
    const apiRaw = unwrapEvaluateResult<Record<string, unknown>>(await page.evaluate(
        async (pid: string) => {
            const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || '';
            if (!tok) return { error: 'no usertoken' };
            try {
                const resp = await fetch('/api/canva/project/queryProject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'token': tok, 'x-language': 'zh' },
                    body: JSON.stringify({ projectId: pid }),
                    credentials: 'include',
                });
                const body = await resp.json();
                return { status: resp.status, code: body?.code, msg: body?.msg, data: body?.data };
            } catch (e: any) {
                return { error: e?.message || String(e) };
            }
        },
        projectId,
    ));

    dump['queryProject_raw'] = apiRaw;

    fs.writeFileSync(outputPath, JSON.stringify(dump, null, 2), 'utf-8');
    console.error(`[dumpLovartProjectPage] Wrote ${outputPath}`);
}
