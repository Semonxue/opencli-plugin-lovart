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

// ---------------------------------------------------------------------------
// Project detail (queryProject)
// ---------------------------------------------------------------------------

export interface LovartProjectImage {
    shapeId: string;
    url: string;
    w: number;
    h: number;
    /** 'generator' = AI-generated, 'user' = uploaded, 'agent' = avatar/UI */
    type: 'generator' | 'user' | 'agent';
}

export interface LovartProjectDetail {
    projectId: string;
    projectName: string;
    projectType: number;
    version: string;
    isValidProject: boolean;
    isTitleChanged: boolean;
    isNewProject: boolean;
    /** canvasDataV1 if the canvas was non-empty, null otherwise */
    canvasDataV1: LovartCanvasDataV1 | null;
    images: LovartProjectImage[];
    videoCount: number;
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
 * Call `canva/project/queryProject` and parse the canvasDataV1 JSON blob.
 *
 * Auth: `usertoken` cookie forwarded as `token` header (same as `projects`).
 * The API retries once on 401 because Lovart sometimes sends a stale cookie
 * that gets refreshed by the first 401.
 */
export async function readLovartProject(
    page: any,
    projectId: string,
): Promise<LovartProjectDetail> {
    // Navigate to the canvas page — Lovart's queryProject API only returns
    // canvas data when the session is on the canvas route (set-cookie + session state).
    const canvasUrl = `https://www.lovart.ai/canvas?projectId=${projectId}`;
    await page.goto(canvasUrl);
    // Wait for the canvas page to fully load
    await page.wait({ selector: 'body', timeoutMs: 8000 });
    // Give the studio time to hydrate
    await page.wait(3000);

    // Try the API first, then fall back to reading from localStorage/tldraw state
    const result = unwrapEvaluateResult<{
        ok: boolean;
        data: {
            canvas: string | null;
            projectId: string;
            projectName: string;
            projectType: number;
            version: string;
            userId: string;
            validProjectId: string;
        };
        error?: string;
    }>(await page.evaluate(
        `
        (async () => {
            const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || '';
            if (!tok) return { ok: false, error: 'usertoken cookie missing' };

            // Retry-once pattern mirrors what the studio frontend does (code 401).
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const resp = await fetch('/api/canva/project/queryProject', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'token': tok,
                            'x-language': 'zh',
                        },
                        body: JSON.stringify({ projectId: ${JSON.stringify(projectId)} }),
                        credentials: 'include',
                    });
                    const body = await resp.json();
                    if (body?.code === 0 || body?.code === '0') {
                        return { ok: true, data: body.data };
                    }
                    if (body?.code === 401 && attempt === 0) continue; // retry once
                    return { ok: false, error: 'API code ' + body?.code + ' ' + (body?.msg || ''), data: body?.data };
                } catch (e) {
                    return { ok: false, error: 'fetch failed: ' + String(e && e.message || e) };
                }
            }
        })()
    `,
    ));

    if (!result || !result.ok) {
        throw new AuthRequiredError(
            LOVART_DOMAIN,
            result?.error || 'Lovart queryProject API failed.',
        );
    }

    const d = result.data;
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

    // Extract images from canvas JSON; fall back to DOM scraping if needed
    let images: LovartProjectImage[] = canvasDataV1
        ? parseLovartProjectImages(canvasDataV1)
        : [];

    if (images.length === 0) {
        images = await readImagesFromDOM(page, projectId);
    }

    // Get video and group counts from the snapshot
    const { videoCount, groupCount } = countCanvasVideosAndGroups(canvasDataV1);

    return {
        projectId: d.projectId || projectId,
        projectName: d.projectName ?? '',
        projectType: d.projectType ?? 3,
        version: d.version ?? '',
        // isValidProject / isTitleChanged are not in the queryProject data payload;
        // the frontend derives them from session state not available here.
        isValidProject: false,
        isTitleChanged: false,
        isNewProject: false,
        canvasDataV1,
        images,
        videoCount,
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
): Promise<LovartProjectImage[]> {
    const images: LovartProjectImage[] = [];

    // Collect all image URLs from <img> tags rendered by the tldraw canvas
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
            // Determine type from URL path
            let type: LovartProjectImage['type'] = 'unknown';
            if (img.src.includes('/artifacts/generator/')) type = 'generator';
            else if (img.src.includes('/artifacts/user/')) type = 'user';
            else if (img.src.includes('/artifacts/agent/')) type = 'agent';
            else continue; // skip non-artifact images

            images.push({
                shapeId: '',
                url: img.src,
                w: img.width,
                h: img.height,
                type,
            });
        }
    }

    return images;
}

/**
 * Extract image/video shapes from a canvasDataV1 tldrawSnapshot.
 *
 * Confirmed canvas structure (verified 2026-06):
 *   document.store = { 'shape:<id>': { id, type, props, ... } }
 *   document.records = {}  ← NOT the shape storage (tldraw v2 changed this)
 *
 * Shape types:
 *   "c-image"  → props.url           (AI-generated or user-uploaded image)
 *   "c-video"  → props.url + props.coverUrl  (video + poster frame)
 *   "c-group"  → group container shape (no URL)
 *
 * Artifacts URL paths:
 *   /artifacts/generator/  → type: 'generator'
 *   /artifacts/user/       → type: 'user'
 *   /artifacts/agent/      → type: 'agent'
 */
export function parseLovartProjectImages(canvasDataV1: LovartCanvasDataV1): LovartProjectImage[] {
    const snapshot = canvasDataV1?.tldrawSnapshot;
    if (!snapshot) return [];

    // tldraw v2: shapes live in document.store, not document.records
    const store = (snapshot as any).document?.store;
    if (!store || typeof store !== 'object') return [];

    const images: LovartProjectImage[] = [];

    for (const [shapeId, raw] of Object.entries(store)) {
        if (!raw || typeof raw !== 'object') continue;
        const shape = raw as Record<string, unknown>;
        const stype = String(shape.type ?? '');

        if (stype === 'c-image') {
            const props = shape.props as Record<string, unknown> | undefined;
            const url = String(props?.url ?? '');
            if (!url) continue;
            images.push({
                shapeId: String(shape.id ?? shapeId),
                url,
                w: Number(props?.w ?? 0),
                h: Number(props?.h ?? 0),
                type: inferImageType(url),
            });
        } else if (stype === 'c-video') {
            const props = shape.props as Record<string, unknown> | undefined;
            const coverUrl = String(props?.coverUrl ?? '');
            if (coverUrl) {
                // Video poster frame — also count as an image
                images.push({
                    shapeId: String(shape.id ?? shapeId),
                    url: coverUrl,
                    w: Number(props?.w ?? 0),
                    h: Number(props?.h ?? 0),
                    type: inferImageType(coverUrl),
                });
            }
        }
    }

    return images;
}

function inferImageType(url: string): LovartProjectImage['type'] {
    if (url.includes('/artifacts/generator/')) return 'generator';
    if (url.includes('/artifacts/user/')) return 'user';
    if (url.includes('/artifacts/agent/')) return 'agent';
    return 'unknown';
}

/**
 * Count c-video and c-group shapes from the canvas snapshot.
 * Returns { videoCount, groupCount }.
 */
export function countCanvasVideosAndGroups(canvasDataV1: LovartCanvasDataV1 | null): { videoCount: number; groupCount: number } {
    if (!canvasDataV1) return { videoCount: 0, groupCount: 0 };
    const store = (canvasDataV1 as any).tldrawSnapshot?.document?.store;
    if (!store || typeof store !== 'object') return { videoCount: 0, groupCount: 0 };

    let videoCount = 0;
    let groupCount = 0;
    for (const raw of Object.values(store)) {
        if (!raw || typeof raw !== 'object') continue;
        const stype = String((raw as Record<string, unknown>).type ?? '');
        if (stype === 'c-video') videoCount++;
        else if (stype === 'c-group') groupCount++;
    }
    return { videoCount, groupCount };
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
