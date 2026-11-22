// Extension Doctor — panel, diagnosis, report, AI analysis, hotfixes.
// probe.js MUST be the first import: it wraps MutationObserver/timers before other extensions load.
import { probe } from './probe.js';

const MODULE = 'extensionDoctor';
const FOLDER = probe?.SELF_FOLDER || 'ST-ExtensionDoctor';
const EXT_PATH = `third-party/${FOLDER}`;
const KEY_STORAGE = 'extensionDoctor.directKey';
const T = probe?.orig || { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, setInterval: window.setInterval, clearInterval: window.clearInterval };

const ctx = () => SillyTavern.getContext();
const libs = () => SillyTavern.libs || {};

const DEFAULTS = {
    loopDetect: true,
    rateThreshold: 30,
    duration: 30,
    throttleMs: 200,
    ai: { mode: 'current', profileId: '', profileModel: '', directUrl: '', directModel: '', rememberKey: false, maxTokens: 4000, timeoutSec: 180 },
    hotfixes: [],
};

let memKey = ''; // direct-input API key held in memory only (never in extensionSettings)

// ------------------------------------------------------------------ helpers

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = structuredClone(DEFAULTS);
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = structuredClone(v);
    for (const [k, v] of Object.entries(DEFAULTS.ai)) if (s.ai[k] === undefined) s.ai[k] = v;
    // Defensive: a key must never live in settings.json.
    if ('directKey' in s.ai) delete s.ai.directKey;
    return s;
}
const save = () => ctx().saveSettingsDebounced();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(ms < 10 ? 1 : 0)}ms`);
const fmtN = n => Number(n || 0).toLocaleString('ko-KR');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

async function copyText(text) {
    try {
        if (window.isSecureContext && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            toastr.success('복사했어요.');
            return;
        }
    } catch { /* fall through to legacy path */ }
    // http:// (insecure context) fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) toastr.success('복사했어요.');
    else toastr.error('복사하지 못했어요. 브라우저가 막았을 수 있어요.');
}

// ------------------------------------------------------------------ owner names

const nameCache = new Map();
const nameLoading = new Map();

function ownerLabel(owner) {
    if (owner === 'core') return 'ST 코어';
    if (owner === 'unknown' || !owner) return '알 수 없음';
    if (owner === probe?.SELF) return 'Extension Doctor';
    const folder = owner.startsWith('third-party/') ? owner.slice(12) : owner;
    const dn = nameCache.get(owner);
    if (!dn || dn === folder) return folder;
    return `${dn} (${folder})`;
}

function ensureNames(owners) {
    const list = [...new Set(owners)].filter(o => o && o !== 'core' && o !== 'unknown' && !nameCache.has(o));
    return Promise.all(list.map(o => {
        if (nameLoading.has(o)) return nameLoading.get(o);
        const p = fetch(`/scripts/extensions/${o}/manifest.json`)
            .then(r => (r.ok ? r.json() : null))
            .then(m => { nameCache.set(o, m?.display_name || o.replace(/^third-party\//, '')); })
            .catch(() => { nameCache.set(o, o.replace(/^third-party\//, '')); });
        nameLoading.set(o, p);
        return p;
    }));
}

// ------------------------------------------------------------------ alerts (always-on loop detection)

function onProbeAlert(a) {
    const owners = a.type === 'pingpong' ? [a.a, a.b] : [a.owner];
    ensureNames(owners).then(() => {
        const msg = a.type === 'pingpong'
            ? `⚠️ 루프 의심: ${ownerLabel(a.a)} ↔ ${ownerLabel(a.b)} (초당 ${fmtN(a.perSec)}회)`
            : `⚠️ 감시자 과다 호출: ${ownerLabel(a.owner)} — 대상 ${a.target} (초당 ${fmtN(a.perSec)}회)`;
        console.warn('[ExtensionDoctor]', msg, a);
        lastAlerts.unshift({ ...a, msg, at: Date.now() });
        lastAlerts.length = Math.min(lastAlerts.length, 20);
        const html = `<div class="xdoc-toast"><div class="xdoc-toast-msg">${esc(msg)}</div>
            <div class="xdoc-toast-btns">
              <button type="button" class="menu_button" data-xdoc="view">진단 보기</button>
              <button type="button" class="menu_button" data-xdoc="fix">임시 보정 적용하시겠습니까?</button>
            </div></div>`;
        const $t = toastr.warning(html, 'Extension Doctor', { timeOut: 20000, extendedTimeOut: 10000, escapeHtml: false, tapToDismiss: false, closeButton: true });
        $t?.on?.('click', 'button[data-xdoc]', ev => {
            ev.stopPropagation();
            const act = ev.currentTarget.dataset.xdoc;
            toastr.clear($t);
            if (act === 'view') showQuickReport(a);
            else offerObserverHotfix(a);
        });
    });
}
const lastAlerts = [];

// ------------------------------------------------------------------ DOM counting

function describeEl(el) {
    if (!el || el.nodeType !== 1) return '?';
    if (el.id) return `#${el.id}`;
    const cls = [...el.classList].slice(0, 2).map(c => `.${c}`).join('');
    return el.tagName.toLowerCase() + cls;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');

function guessPanelOwner(el, knownExt) {
    const hay = norm(`${el.id} ${el.className}`);
    if (!hay) return null;
    let best = null; let bestLen = 0;
    for (const name of knownExt) {
        const folder = norm(name.replace(/^third-party\//, '').replace(/^(sillytavern|st)[-_]?/i, ''));
        if (folder.length >= 4 && hay.includes(folder) && folder.length > bestLen) { best = name; bestLen = folder.length; }
    }
    return best;
}

function countDom(knownExt = []) {
    const count = el => el.getElementsByTagName('*').length + 1;
    const panels = [];
    for (const id of ['extensions_settings', 'extensions_settings2']) {
        const panel = document.getElementById(id);
        if (!panel) continue;
        for (const child of panel.children) {
            let owner = probe?.panelOwners?.get(child) || null;
            let guessed = false;
            if (!owner || owner === 'core' || owner === 'unknown') {
                const g = guessPanelOwner(child, knownExt);
                if (g) { owner = g; guessed = true; }
            }
            panels.push({ owner: owner || 'unknown', sel: describeEl(child), n: count(child), guessed });
        }
    }
    const areas = [];
    const chat = document.getElementById('chat');
    if (chat) areas.push({ label: '채팅 (#chat)', n: count(chat) });
    for (const child of document.body.children) {
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
        areas.push({ label: describeEl(child), n: count(child) });
    }
    areas.sort((a, b) => b.n - a.n);
    return {
        panels: panels.sort((a, b) => b.n - a.n),
        areas: areas.slice(0, 10),
        iframes: document.querySelectorAll('iframe').length,
        total: document.getElementsByTagName('*').length,
    };
}

// ------------------------------------------------------------------ static code scan

const fileCache = new Map(); // url -> text
let scanCache = null;
let extList = null;

async function fetchText(url) {
    if (fileCache.has(url)) return fileCache.get(url);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    const text = await r.text();
    fileCache.set(url, text);
    return text;
}

async function discoverExtensions() {
    if (extList) return extList;
    try {
        const r = await fetch('/api/extensions/discover');
        extList = r.ok ? await r.json() : [];
    } catch { extList = []; }
    return extList;
}

function skipString(text, i) {
    const q = text[i];
    for (let j = i + 1; j < text.length; j++) {
        const c = text[j];
        if (c === '\\') { j++; continue; }
        if (c === q) return j;
        if (q === '`' && c === '$' && text[j + 1] === '{') { const k = matchBracket(text, j + 1); if (k < 0) return text.length; j = k; continue; }
        if (q !== '`' && c === '\n') return j;
    }
    return text.length;
}

/** Returns index of the bracket matching text[openIdx] (approximate JS tokenizer: strings, comments). */
function matchBracket(text, openIdx, limit = 80000) {
    let depth = 0;
    const end = Math.min(text.length, openIdx + limit);
    for (let i = openIdx; i < end; i++) {
        const ch = text[i];
        if (ch === '"' || ch === '\'' || ch === '`') { i = skipString(text, i); continue; }
        if (ch === '/' && text[i + 1] === '/') { const j = text.indexOf('\n', i); if (j < 0) return -1; i = j; continue; }
        if (ch === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); if (j < 0) return -1; i = j + 1; continue; }
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function splitArgs(text, open, close) {
    const args = []; let depth = 0; let start = open + 1;
    for (let i = open + 1; i < close; i++) {
        const ch = text[i];
        if (ch === '"' || ch === '\'' || ch === '`') { i = skipString(text, i); continue; }
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
    }
    args.push(text.slice(start, close).trim());
    return args;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lineIndex(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return pos => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
}

function resolveCallbackBody(text, expr) {
    if (/^(async\s*)?(function\b|\(|[\w$]+\s*=>)/.test(expr)) return expr;
    const m = expr.match(/([\w$]+)$/);
    if (!m) return expr;
    const name = escapeRe(m[1]);
    const re = new RegExp(`(?:function\\s+${name}\\s*\\(|\\b${name}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)|^\\s*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{)`, 'm');
    const d = re.exec(text);
    if (!d) return expr;
    const brace = text.indexOf('{', d.index);
    if (brace < 0) return expr;
    const end = matchBracket(text, brace);
    return end > 0 ? text.slice(brace, end + 1) : expr;
}

const LAYOUT_RE = /getComputedStyle|getBoundingClientRect|\.offset(?:Width|Height|Top|Left)\b|\.scroll(?:Height|Width)\b|\.client(?:Height|Width)\b/g;

function scanText(ext, file, text) {
    const issues = [];
    const lineOf = lineIndex(text);
    const lines = text.split('\n');
    const minified = lines.length < 60 && lines.some(l => l.length > 3000);
    const add = (pos, severity, kind, msg) => issues.push({ ext, file, line: lineOf(pos), pos, severity, kind, msg });

    // MutationObserver creations
    const moRe = /new\s+(?:window\.)?MutationObserver\s*\(/g;
    let m;
    let guard = 0;
    while ((m = moRe.exec(text)) && guard++ < 200) {
        const open = m.index + m[0].length - 1;
        const close = matchBracket(text, open);
        if (close < 0) continue;
        const cbExpr = text.slice(open + 1, close).trim();
        const body = resolveCallbackBody(text, cbExpr);

        // target expression
        let targetExpr = null; let optsExpr = '';
        const after = text.slice(close + 1, close + 20);
        const chained = /^\s*\.observe\s*\(/.exec(after);
        let obsOpen = -1;
        if (chained) obsOpen = close + 1 + chained[0].length - 1;
        else {
            const before = text.slice(Math.max(0, m.index - 120), m.index);
            const v = before.match(/([\w$.]+)\s*=\s*$/);
            if (v) {
                const oRe = new RegExp(`${escapeRe(v[1])}\\s*\\.\\s*observe\\s*\\(`, 'g');
                oRe.lastIndex = close;
                const o = oRe.exec(text);
                if (o) obsOpen = o.index + o[0].length - 1;
            }
        }
        if (obsOpen > 0) {
            const obsClose = matchBracket(text, obsOpen);
            if (obsClose > 0) {
                const args = splitArgs(text, obsOpen, obsClose);
                targetExpr = args[0] || null;
                optsExpr = args[1] || '';
            }
        }

        const subtree = /subtree\s*:\s*(true|!0)/.test(optsExpr);
        if (targetExpr && /^(document\.body|document\.documentElement|document|\$\(\s*['"]body['"]\s*\)\s*\[0\]|document\.querySelector\(\s*['"](body|html)['"]\s*\))$/.test(targetExpr) && subtree) {
            add(m.index, 'high', 'body-subtree', `문서 전체(${targetExpr})를 subtree로 감시 — 화면의 모든 변경마다 콜백이 불림`);
        }
        const layoutHits = (body.match(LAYOUT_RE) || []).length;
        if (layoutHits) add(m.index, layoutHits >= 3 ? 'high' : 'mid', 'layout-in-observer', `감시자 콜백 안에서 레이아웃 강제 계산(getComputedStyle/getBoundingClientRect 등) ${layoutHits}회`);
        if (targetExpr && /^[\w$.]+$/.test(targetExpr) && !/^document/.test(targetExpr)) {
            const mutRe = new RegExp(`${escapeRe(targetExpr)}\\s*\\.\\s*(append|appendChild|prepend|insertBefore|insertAdjacentHTML|insertAdjacentElement|replaceChildren|replaceWith|innerHTML|textContent|outerHTML|setAttribute|removeAttribute|classList|style)\\b`);
            if (mutRe.test(body)) {
                const guarded = /\.disconnect\s*\(/.test(body);
                add(m.index, guarded ? 'low' : 'mid', 'self-mutation', `감시 대상(${targetExpr})을 콜백 안에서 직접 수정 — 자기 유발 루프 위험${guarded ? ' (disconnect로 보호 중)' : ''}`);
            }
        }
    }

    // fast setInterval
    const siRe = /\bsetInterval\s*\(/g;
    guard = 0;
    while ((m = siRe.exec(text)) && guard++ < 300) {
        const open = m.index + m[0].length - 1;
        const close = matchBracket(text, open);
        if (close < 0) continue;
        const args = splitArgs(text, open, close);
        const last = args.length > 1 ? args[args.length - 1] : '';
        const n = /^\d+$/.test(last) ? Number(last) : NaN;
        if (n < 100) add(m.index, n < 50 ? 'high' : 'mid', 'fast-interval', `setInterval 주기 ${n}ms (100ms 미만)`);
    }
    return { issues, minified };
}

async function staticScan() {
    if (scanCache) return scanCache;
    const list = await discoverExtensions();
    const disabled = new Set(ctx().extensionSettings.disabledExtensions || []);
    const result = { issues: [], minified: [], scanned: 0, files: 0, errors: [] };
    for (const ext of list) {
        const name = ext.name;
        if (!name.startsWith('third-party/') || name === probe?.SELF || disabled.has(name)) continue;
        let manifest;
        try { manifest = JSON.parse(await fetchText(`/scripts/extensions/${name}/manifest.json`)); } catch { continue; }
        if (!manifest?.js) continue;
        result.scanned++;
        const base = `/scripts/extensions/${name}/`;
        const queue = [{ url: new URL(manifest.js, location.origin + base).pathname, depth: 0 }];
        const seen = new Set();
        while (queue.length && seen.size < 12) {
            const { url, depth } = queue.shift();
            if (seen.has(url) || !url.startsWith(base)) continue;
            seen.add(url);
            let text;
            try { text = await fetchText(url); } catch (e) { result.errors.push(`${url}: ${e.message}`); continue; }
            result.files++;
            const { issues, minified } = scanText(name, url, text);
            result.issues.push(...issues);
            if (minified) result.minified.push(url);
            if (depth < 2) {
                const impRe = /(?:import|export)\s*(?:[^'"`;]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
                let im;
                while ((im = impRe.exec(text))) {
                    const rel = im[1] || im[2];
                    const abs = new URL(rel, location.origin + url).pathname;
                    if (abs.endsWith('.js') || abs.endsWith('.mjs')) queue.push({ url: abs, depth: depth + 1 });
                }
            }
        }
    }
    scanCache = result;
    return result;
}

// ------------------------------------------------------------------ report building

function diffBy(a = [], b = [], key) {
    const m = new Map(a.map(x => [key(x), x]));
    return b.map(x => ({ cur: x, prev: m.get(key(x)) || null }));
}

const WHOLE_PAGE = ['html', 'body', 'document'];

/**
 * Conflict candidates: two extensions observing the same element, or one observing (subtree) an ancestor of the
 * other's target. Whole-page observers overlap with everything, so they only count when the two extensions
 * actually triggered each other (`interacting`: set of "a|b" sorted owner pairs).
 */
function findConflicts(observers, interacting = new Set()) {
    const byEl = new Map();
    const live = observers.filter(o => o.connected && probe.isExtOwner(o.owner));
    const pairKey = (a, b) => [a, b].sort().join('|');
    for (const o of live) for (const t of o.targets) {
        if (!t.el || WHOLE_PAGE.includes(t.sel)) continue;
        if (!byEl.has(t.el)) byEl.set(t.el, { sel: t.sel, owners: new Set() });
        byEl.get(t.el).owners.add(o.owner);
    }
    const out = [];
    for (const v of byEl.values()) if (v.owners.size >= 2) out.push({ target: v.sel, owners: [...v.owners], how: '같은 요소 감시' });
    // subtree containment (skip whole-document observers: they overlap with everything)
    for (const a of live) for (const ta of a.targets) {
        if (!ta.el || !ta.subtree) continue;
        for (const b of live) {
            if (b.owner === a.owner) continue;
            if (WHOLE_PAGE.includes(ta.sel) && !interacting.has(pairKey(a.owner, b.owner))) continue;
            for (const tb of b.targets) {
                if (!tb.el || tb.el === ta.el || WHOLE_PAGE.includes(tb.sel) || !(ta.el === document ? document.contains(tb.el) : ta.el.contains?.(tb.el))) continue;
                const key = pairKey(a.owner, b.owner) + tb.sel;
                if (out.some(x => x.key === key)) continue;
                out.push({ key, target: `${ta.sel} ⊃ ${tb.sel}`, owners: [a.owner, b.owner], how: `${ownerLabel(a.owner)}의 하위 전체 감시가 ${ownerLabel(b.owner)}의 감시 대상을 포함` });
            }
        }
    }
    return out.slice(0, 20);
}

function buildReport(start, end, extra = {}) {
    const durSec = Math.max(1, (end.at - (start?.at ?? 0)) / 1000);
    const rows = new Map();
    const row = o => {
        if (!rows.has(o)) rows.set(o, { owner: o, cpuMs: 0, loafMs: 0, obsCalls: 0, obsMs: 0, dom: 0, listeners: 0, observers: 0, intervals: 0 });
        return rows.get(o);
    };

    for (const { cur, prev } of diffBy(start?.owners, end.owners, x => x.owner)) {
        const r = row(cur.owner);
        r.cpuMs += cur.cbMs - (prev?.cbMs || 0);
        r.listeners = cur.listeners; r.observers = cur.observers; r.intervals = cur.intervals;
    }
    const obsDiff = diffBy(start?.observers, end.observers, x => x.id).map(({ cur, prev }) => ({
        ...cur, dCalls: cur.calls - (prev?.calls || 0), dMs: cur.totalMs - (prev?.totalMs || 0), dRecords: cur.records - (prev?.records || 0), dSkipped: cur.skipped - (prev?.skipped || 0),
    }));
    for (const o of obsDiff) { const r = row(o.owner); r.obsCalls += o.dCalls; r.obsMs += o.dMs; }
    for (const f of extra.frames?.owners || []) row(f.owner).loafMs += f.ms;
    for (const p of extra.dom?.panels || []) row(p.owner).dom += p.n;

    const edgeDiff = diffBy(start?.edges, end.edges, x => `${x.from}>${x.to}`).map(({ cur, prev }) => ({ ...cur, d: cur.count - (prev?.count || 0) }));
    const edgeMap = new Map(edgeDiff.map(e => [`${e.from}>${e.to}`, e]));
    const loops = []; const seen = new Set();
    const minCount = Math.max(5, durSec * 1);
    for (const e of edgeDiff) {
        if (!probe.isExtOwner(e.from) || !probe.isExtOwner(e.to) || e.from === e.to || e.d < minCount) continue;
        const back = edgeMap.get(`${e.to}>${e.from}`);
        if (!back || back.d < minCount) continue;
        const k = [e.from, e.to].sort().join('|');
        if (seen.has(k)) continue;
        seen.add(k);
        loops.push({ a: e.from, b: e.to, ab: e.d, ba: back.d, perSec: (e.d + back.d) / durSec, observerIds: [...new Set([...e.obs, ...back.obs])] });
    }
    loops.sort((x, y) => y.perSec - x.perSec);

    const hotObservers = obsDiff.filter(o => o.owner !== probe.SELF && o.dCalls > 0).sort((a, b) => b.dMs - a.dMs || b.dCalls - a.dCalls).slice(0, 15);
    const intervals = end.intervals.filter(i => i.owner !== probe.SELF).map(i => {
        const prev = start?.intervals?.find(p => p.id === i.id);
        return { ...i, dCalls: i.calls - (prev?.calls || 0), dMs: i.totalMs - (prev?.totalMs || 0) };
    }).sort((a, b) => b.dMs - a.dMs).slice(0, 15);
    const evs = diffBy(start?.events, end.events, x => `${x.owner}|${x.event}`).map(({ cur, prev }) => ({ ...cur, dCalls: cur.calls - (prev?.calls || 0), dMs: cur.totalMs - (prev?.totalMs || 0) }))
        .filter(e => e.owner !== probe.SELF && e.dCalls > 0).sort((a, b) => b.dMs - a.dMs).slice(0, 15);

    const ranking = [...rows.values()].filter(r => r.owner !== probe.SELF && (r.cpuMs + r.loafMs > 0.5 || r.obsCalls || r.dom || r.listeners || r.observers))
        .sort((a, b) => (b.cpuMs + b.loafMs) - (a.cpuMs + a.loafMs) || b.dom - a.dom).slice(0, 30);

    return {
        kind: extra.kind || 'diagnosis', durSec, stopped: !!extra.stopped, alert: extra.alert || null,
        ranking, loops, conflicts: findConflicts(end.observers, new Set(edgeDiff.filter(e => e.d > 0 && e.from !== e.to).map(e => [e.from, e.to].sort().join('|')))),
        hotObservers, intervals, events: evs,
        frames: extra.frames || null, dom: extra.dom || null, scan: extra.scan || null,
    };
}

function allOwnersIn(report) {
    const s = new Set();
    report.ranking.forEach(r => s.add(r.owner));
    report.loops.forEach(l => { s.add(l.a); s.add(l.b); });
    report.conflicts.forEach(c => c.owners.forEach(o => s.add(o)));
    report.hotObservers.forEach(o => s.add(o.owner));
    report.intervals.forEach(o => s.add(o.owner));
    report.events.forEach(o => s.add(o.owner));
    report.dom?.panels.forEach(p => s.add(p.owner));
    report.frames?.top.forEach(f => s.add(f.owner));
    report.scan?.issues.forEach(i => s.add(i.ext));
    if (report.alert) [report.alert.a, report.alert.b, report.alert.owner].forEach(o => o && s.add(o));
    return [...s];
}

const SEV = { high: '높음', mid: '중간', low: '낮음' };
const shortFile = url => String(url || '').replace(/^.*\/scripts\/extensions\/(third-party\/)?[^/]+\//, '');
const siteStr = site => (site ? `${shortFile(site.url)}:${site.line}` : '');

function reportToText(r) {
    const L = [];
    L.push(`[Extension Doctor 리포트] ${r.kind === 'diagnosis' ? `진단 ${r.durSec.toFixed(0)}초${r.stopped ? ' (중간 중지)' : ''}` : `페이지 로드 후 누적 ${r.durSec.toFixed(0)}초`}`);
    L.push(`ST ${ctx().getVersion?.()?.pkgVersion || ''} / ${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] || ''}`);
    if (r.alert) L.push(`\n경고: ${r.alert.msg || r.alert.type}`);
    L.push('\n## 확장별 순위 (CPU ms = 감시자/타이머/이벤트 콜백 실측, 멈춤 = 긴 프레임 귀속)');
    for (const x of r.ranking) L.push(`- ${ownerLabel(x.owner)}: CPU ${fmtMs(x.cpuMs)}, 멈춤 ${fmtMs(x.loafMs)}, 감시자 호출 ${fmtN(x.obsCalls)}회 (평균 ${x.obsCalls ? fmtMs(x.obsMs / x.obsCalls) : '-'}), 패널 DOM ${fmtN(x.dom)}, 리스너 ${x.listeners}/감시자 ${x.observers}/인터벌 ${x.intervals}`);
    L.push('\n## 루프 / 충돌');
    if (!r.loops.length && !r.conflicts.length) L.push('- 없음');
    for (const l of r.loops) L.push(`- 루프 의심: ${ownerLabel(l.a)} ↔ ${ownerLabel(l.b)} — ${ownerLabel(l.a)}→${ownerLabel(l.b)} ${fmtN(l.ab)}회, 반대 ${fmtN(l.ba)}회 (초당 ${l.perSec.toFixed(1)}회)`);
    for (const c of r.conflicts) L.push(`- 충돌 후보: ${c.owners.map(ownerLabel).join(' / ')} — ${c.target} (${c.how})`);
    L.push('\n## 많이 불린 감시자');
    for (const o of r.hotObservers) L.push(`- ${ownerLabel(o.owner)} [${o.targets.map(t => t.sel + (t.subtree ? ' (subtree)' : '')).join(', ') || '?'}] ${fmtN(o.dCalls)}회, ${fmtMs(o.dMs)}, 변경 ${fmtN(o.dRecords)}건${o.dSkipped ? `, 보정으로 건너뜀 ${fmtN(o.dSkipped)}` : ''} ${siteStr(o.site)}`);
    if (r.intervals.length) {
        L.push('\n## 인터벌');
        for (const i of r.intervals) L.push(`- ${ownerLabel(i.owner)} 주기 ${i.delay}ms, ${fmtN(i.dCalls)}회, ${fmtMs(i.dMs)} ${siteStr(i.site)}`);
    }
    if (r.events.length) {
        L.push('\n## 이벤트 리스너 (소요 시간 순)');
        for (const e of r.events) L.push(`- ${ownerLabel(e.owner)} ${e.event}: ${fmtN(e.dCalls)}회, ${fmtMs(e.dMs)} (최대 ${fmtMs(e.maxMs)})`);
    }
    if (r.frames) {
        L.push(`\n## 멈춤 구간 Top 10 (${r.frames.type === 'loaf' ? 'long-animation-frame' : r.frames.type === 'longtask' ? 'longtask — 귀속 불가' : '미지원'}) 총 ${r.frames.count}회 / ${fmtMs(r.frames.totalMs)}`);
        for (const f of r.frames.top) L.push(`- ${fmtMs(f.duration)} @${(f.start / 1000).toFixed(1)}s — ${ownerLabel(f.owner)} ${f.script || ''}`);
    }
    if (r.dom) {
        L.push(`\n## DOM (전체 ${fmtN(r.dom.total)}개, iframe ${r.dom.iframes}개)`);
        for (const p of r.dom.panels.slice(0, 15)) L.push(`- 설정 패널 ${ownerLabel(p.owner)}${p.guessed ? ' (추정)' : ''} ${p.sel}: ${fmtN(p.n)}`);
        for (const a of r.dom.areas) L.push(`- 영역 ${a.label}: ${fmtN(a.n)}`);
    }
    if (r.scan) {
        L.push(`\n## 코드 점검 (확장 ${r.scan.scanned}개, 파일 ${r.scan.files}개)`);
        for (const i of r.scan.issues) L.push(`- [${SEV[i.severity]}] ${ownerLabel(i.ext)} ${shortFile(i.file)}:${i.line} — ${i.msg}`);
        if (r.scan.minified.length) L.push(`- 압축된 파일(정밀 점검 불가): ${r.scan.minified.map(shortFile).join(', ')}`);
    }
    return L.join('\n');
}

function table(headers, rows) {
    if (!rows.length) return '<div class="xdoc-empty">없음</div>';
    return `<div class="xdoc-table-wrap"><table class="xdoc-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function reportToHtml(r) {
    const head = r.kind === 'diagnosis'
        ? `진단 ${r.durSec.toFixed(0)}초${r.stopped ? ' (중간 중지)' : ''}`
        : `페이지 로드 후 누적 ${r.durSec.toFixed(0)}초 (긴 프레임·코드 점검은 [진단 시작]에서)`;
    const parts = [];
    parts.push(`<div class="xdoc-report-head"><b>Extension Doctor 리포트</b> <span class="xdoc-muted">${esc(head)}</span>
      <div class="xdoc-report-btns">
        <button type="button" class="menu_button" data-xdoc="copy"><i class="fa-solid fa-copy"></i> 복사(텍스트)</button>
        <button type="button" class="menu_button" data-xdoc="ai"><i class="fa-solid fa-robot"></i> AI 분석</button>
      </div></div>`);
    if (r.alert) parts.push(`<div class="xdoc-alert">${esc(r.alert.msg || '')}</div>`);

    parts.push('<h4>루프 / 충돌</h4>');
    parts.push(table(['종류', '확장', '내용', ''], [
        ...r.loops.map((l, i) => ['<b class="xdoc-bad">루프 의심</b>', `${esc(ownerLabel(l.a))} ↔ ${esc(ownerLabel(l.b))}`,
            `→ ${fmtN(l.ab)}회 / ← ${fmtN(l.ba)}회 (초당 ${l.perSec.toFixed(1)}회)`, `<button type="button" class="menu_button xdoc-small" data-xdoc="fix-loop" data-i="${i}">임시 보정</button>`]),
        ...r.conflicts.map(c => ['충돌 후보', esc(c.owners.map(ownerLabel).join(' / ')), `${esc(c.target)} — ${esc(c.how)}`, '']),
    ]));

    parts.push('<h4>확장별 순위</h4>');
    parts.push(table(['확장', 'CPU', '멈춤 귀속', '감시자 호출', '평균', '패널 DOM', '리스너/감시자/인터벌'],
        r.ranking.map(x => [esc(ownerLabel(x.owner)), fmtMs(x.cpuMs), r.frames?.type === 'loaf' ? fmtMs(x.loafMs) : '-', fmtN(x.obsCalls), x.obsCalls ? fmtMs(x.obsMs / x.obsCalls) : '-', fmtN(x.dom), `${x.listeners}/${x.observers}/${x.intervals}`])));

    parts.push('<h4>많이 불린 감시자</h4>');
    parts.push(table(['확장', '감시 대상', '호출', '시간', '변경 수', '위치', ''],
        r.hotObservers.map(o => [esc(ownerLabel(o.owner)), esc(o.targets.map(t => t.sel + (t.subtree ? ' (subtree)' : '')).join(', ') || '?'), fmtN(o.dCalls), fmtMs(o.dMs), fmtN(o.dRecords) + (o.dSkipped ? ` <span class="xdoc-muted">(건너뜀 ${fmtN(o.dSkipped)})</span>` : ''), esc(siteStr(o.site)),
            `<button type="button" class="menu_button xdoc-small" data-xdoc="fix-obs" data-id="${o.id}">보정</button>`])));

    if (r.frames) {
        const label = r.frames.type === 'loaf' ? '' : r.frames.type === 'longtask' ? ' <span class="xdoc-muted">(이 브라우저는 long-animation-frame 미지원 — 귀속 불가)</span>' : ' <span class="xdoc-muted">(미지원)</span>';
        parts.push(`<h4>멈춤 구간 Top 10 <span class="xdoc-muted">총 ${r.frames.count}회 / ${fmtMs(r.frames.totalMs)}</span>${label}</h4>`);
        parts.push(table(['길이', '시점', '확장', '스크립트'], r.frames.top.map(f => [fmtMs(f.duration), `${(f.start / 1000).toFixed(1)}s`, esc(ownerLabel(f.owner)), esc(f.script || '')])));
    }
    if (r.dom) {
        parts.push(`<h4>DOM <span class="xdoc-muted">전체 ${fmtN(r.dom.total)}개 · iframe ${r.dom.iframes}개</span></h4>`);
        parts.push(table(['확장 설정 패널', '컨테이너', '요소 수'], r.dom.panels.slice(0, 15).map(p => [esc(ownerLabel(p.owner)) + (p.guessed ? ' <span class="xdoc-muted">(추정)</span>' : ''), esc(p.sel), fmtN(p.n)])));
        parts.push(table(['상위 영역', '요소 수'], r.dom.areas.map(a => [esc(a.label), fmtN(a.n)])));
    }
    if (r.intervals.length) {
        parts.push('<h4>인터벌</h4>');
        parts.push(table(['확장', '주기', '호출', '시간', '위치'], r.intervals.map(i => [esc(ownerLabel(i.owner)), `${i.delay}ms`, fmtN(i.dCalls), fmtMs(i.dMs), esc(siteStr(i.site))])));
    }
    if (r.events.length) {
        parts.push('<h4>ST 이벤트 리스너</h4>');
        parts.push(table(['확장', '이벤트', '호출', '시간', '최대', ''], r.events.map((e, i) => [esc(ownerLabel(e.owner)), esc(e.event), fmtN(e.dCalls), fmtMs(e.dMs), fmtMs(e.maxMs),
            `<button type="button" class="menu_button xdoc-small" data-xdoc="fix-ev" data-i="${i}">건너뛰기</button>`])));
    }
    if (r.scan) {
        parts.push(`<h4>코드 점검 <span class="xdoc-muted">확장 ${r.scan.scanned}개 · 파일 ${r.scan.files}개</span></h4>`);
        parts.push(table(['위험도', '확장', '위치', '내용'], r.scan.issues.map(i => [`<span class="xdoc-sev-${i.severity}">${SEV[i.severity]}</span>`, esc(ownerLabel(i.ext)), esc(`${shortFile(i.file)}:${i.line}`), esc(i.msg)])));
        if (r.scan.minified.length) parts.push(`<div class="xdoc-muted">압축된 파일(정밀 점검 불가): ${esc(r.scan.minified.map(shortFile).join(', '))}</div>`);
    }
    return parts.join('\n');
}

async function showReport(r) {
    await ensureNames(allOwnersIn(r));
    const { Popup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'xdoc-report';
    root.innerHTML = reportToHtml(r);
    root.addEventListener('click', ev => {
        const b = ev.target.closest('button[data-xdoc]');
        if (!b) return;
        const act = b.dataset.xdoc;
        if (act === 'copy') copyText(reportToText(r));
        else if (act === 'ai') runAiAnalysis(r);
        else if (act === 'fix-loop') { const l = r.loops[Number(b.dataset.i)]; offerObserverHotfix({ type: 'pingpong', a: l.a, b: l.b, observerIds: l.observerIds, perSec: Math.round(l.perSec) }); }
        else if (act === 'fix-obs') { const o = r.hotObservers.find(x => String(x.id) === b.dataset.id); if (o) offerObserverHotfix({ type: 'rate', owner: o.owner, observerId: o.id, target: o.targets[0]?.sel || '*' }); }
        else if (act === 'fix-ev') { const e = r.events[Number(b.dataset.i)]; if (e) offerEventHotfix(e); }
    });
    new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '닫기' }).show();
}

async function showQuickReport(alert = null) {
    const list = await discoverExtensions();
    const r = buildReport(null, probe.snapshot(), { kind: 'cumulative', alert, dom: countDom(list.map(x => x.name)) });
    showReport(r);
}

// ------------------------------------------------------------------ diagnosis

let diag = null;

function setDiagUi() {
    const btn = document.getElementById('xdoc_start');
    const st = document.getElementById('xdoc_status');
    if (!btn || !st) return;
    if (diag) {
        const left = Math.max(0, Math.ceil((diag.endAt - Date.now()) / 1000));
        btn.innerHTML = '<i class="fa-solid fa-stop"></i> 중지';
        st.textContent = diag.finishing ? '리포트 만드는 중… (코드 점검 포함)' : `기록 중… 남은 시간 ${left}초`;
    } else {
        btn.innerHTML = '<i class="fa-solid fa-stethoscope"></i> 진단 시작';
        st.textContent = '';
    }
}

function startDiagnosis(sec) {
    if (diag) return;
    if (!probe) { toastr.error('프로브가 설치되지 않아 진단할 수 없어요. 콘솔 오류를 확인해 주세요.'); return; }
    const s = settings();
    const dur = clamp(Number(sec ?? s.duration) || 30, 10, 60);
    const types = PerformanceObserver.supportedEntryTypes || [];
    const type = types.includes('long-animation-frame') ? 'loaf' : types.includes('longtask') ? 'longtask' : 'none';
    const frames = [];
    let po = null;
    if (type !== 'none') {
        // Skip idle frames (background tab / hidden window stretch frames to ~1s with no script and no blocking).
        po = new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
                if (type === 'loaf' && !(e.blockingDuration > 0) && !e.scripts?.length) continue;
                frames.push(e);
            }
        });
        try { po.observe({ type: type === 'loaf' ? 'long-animation-frame' : 'longtask', buffered: false }); } catch { po = null; }
    }
    diag = { start: probe.snapshot(), type, frames, po, endAt: Date.now() + dur * 1000, finishing: false };
    diag.tick = T.setInterval.call(window, setDiagUi, 500);
    diag.timer = T.setTimeout.call(window, () => finishDiagnosis(false), dur * 1000);
    setDiagUi();
    toastr.info(`${dur}초 동안 기록해요. 평소처럼 ST를 사용하세요.`, 'Extension Doctor');
}

function summarizeFrames(type, entries, t0) {
    if (type === 'none') return { type, count: 0, totalMs: 0, top: [], owners: [] };
    const owners = new Map();
    const top = [];
    let totalMs = 0;
    for (const e of entries) {
        totalMs += e.duration;
        let owner = 'unknown'; let script = '';
        if (type === 'loaf' && e.scripts?.length) {
            for (const s of e.scripts) {
                const o = probe.ownerFromUrl(s.sourceURL) || (s.sourceURL ? 'core' : 'unknown');
                owners.set(o, (owners.get(o) || 0) + s.duration);
            }
            const main = [...e.scripts].sort((a, b) => b.duration - a.duration)[0];
            owner = probe.ownerFromUrl(main.sourceURL) || (main.sourceURL ? 'core' : 'unknown');
            script = `${main.sourceFunctionName || main.invoker || ''} @ ${shortFile(main.sourceURL) || '?'}`;
        }
        top.push({ duration: e.duration, start: e.startTime - t0, owner, script });
    }
    top.sort((a, b) => b.duration - a.duration);
    return { type, count: entries.length, totalMs, top: top.slice(0, 10), owners: [...owners].map(([owner, ms]) => ({ owner, ms })) };
}

async function finishDiagnosis(stopped) {
    if (!diag || diag.finishing) return;
    const d = diag;
    d.finishing = true;
    T.clearTimeout.call(window, d.timer);
    try { d.po?.takeRecords?.().forEach(e => d.frames.push(e)); } catch { /* ignore */ }
    d.po?.disconnect();
    const end = probe.snapshot();
    setDiagUi();
    try {
        const list = await discoverExtensions();
        const dom = countDom(list.map(x => x.name));
        let scan = null;
        try { scan = await staticScan(); } catch (e) { console.error('[ExtensionDoctor] scan failed', e); }
        const frames = summarizeFrames(d.type, d.frames, d.start.at);
        const r = buildReport(d.start, end, { kind: 'diagnosis', stopped, frames, dom, scan });
        lastReport = r;
        await showReport(r);
    } catch (e) {
        console.error('[ExtensionDoctor]', e);
        toastr.error(`리포트를 만들지 못했어요: ${e.message}`);
    } finally {
        T.clearInterval.call(window, d.tick);
        diag = null;
        setDiagUi();
    }
}
let lastReport = null;

// ------------------------------------------------------------------ hotfixes

const KIND_LABEL = {
    throttle: r => `호출 간격 제한 ${r.interval}ms (루프 시 최대 2초)`,
    ignorePartner: r => `상대(${(r.partners || []).map(ownerLabel).join(', ')}) 변경 무시`,
    pause: () => '감시자 일시정지',
    skip: () => '이벤트 핸들러 건너뛰기',
};
const ruleLabel = r => `${ownerLabel(r.owner)} — ${r.scope === 'event' ? `이벤트 ${r.event}` : `감시 대상 ${r.target}`}: ${KIND_LABEL[r.kind]?.(r) || r.kind}`;
const newId = () => `hf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function persistRules() {
    settings().hotfixes = probe.rules.filter(r => r.persist).map(({ id, scope, kind, owner, target, event, interval, partners }) => ({ id, scope, kind, owner, target, event, interval, partners, persist: true }));
    save();
    renderHotfixList();
}

async function offerObserverHotfix(alert) {
    const snap = probe.snapshot();
    let recs = [];
    if (alert.type === 'pingpong') recs = snap.observers.filter(o => alert.observerIds?.includes(o.id) && (o.owner === alert.a || o.owner === alert.b));
    else recs = snap.observers.filter(o => o.id === alert.observerId);
    if (!recs.length) { toastr.warning('보정할 감시자를 찾지 못했어요. 이미 사라졌을 수 있어요.'); return; }
    await ensureNames(recs.map(r => r.owner).concat(alert.a || [], alert.b || []));

    const isPP = alert.type === 'pingpong';
    const targets = [];
    for (const o of recs) for (const t of (o.targets.length ? o.targets : [{ sel: '*' }])) {
        if (!targets.some(x => x.owner === o.owner && x.sel === t.sel)) targets.push({ owner: o.owner, sel: t.sel });
    }
    const s = settings();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const el = document.createElement('div');
    el.className = 'xdoc-fix';
    el.innerHTML = `
      <h3>임시 보정 적용하시겠습니까?</h3>
      <p>${isPP ? `<b>${esc(ownerLabel(alert.a))}</b>와(과) <b>${esc(ownerLabel(alert.b))}</b>가 서로의 변경에 반응하며 계속 다시 그리고 있어요.` : `<b>${esc(ownerLabel(alert.owner))}</b>의 감시자가 너무 자주 불리고 있어요.`}</p>
      <div class="xdoc-muted">대상 감시자:</div>
      <ul>${targets.map(t => `<li>${esc(ownerLabel(t.owner))} — <code>${esc(t.sel)}</code></li>`).join('')}</ul>
      <label class="radio_label"><input type="radio" name="xdoc_fix_kind" value="throttle" checked> <b>호출 간격 제한</b> (권장)</label>
      <div class="xdoc-desc">감시자 호출 사이를 최소 <input type="number" class="text_pole xdoc-num" id="xdoc_fix_interval" min="16" max="5000" value="${s.throttleMs}">ms 띄우고, 그 사이 변경은 모아서 한 번에 전달해요. 변경이 쉬지 않고 계속 들어오면(루프) 간격을 최대 2초까지 늘려요. 기능은 그대로이고, 루프 중에는 화면 갱신이 최대 2초 늦어질 수 있어요.</div>
      ${isPP ? `<label class="radio_label"><input type="radio" name="xdoc_fix_kind" value="ignorePartner"> <b>상대 확장의 변경 무시</b></label>
      <div class="xdoc-desc">한쪽이 다른 쪽이 만든 변경에는 반응하지 않게 해서 루프를 완전히 끊어요. 한쪽에만 적용해도 충분해요. 부작용: 상대가 목록을 다시 그린 뒤 이쪽의 배치/표시가 갱신되지 않아 어긋날 수 있어요(그럴 땐 해제).</div>` : ''}
      <label class="radio_label"><input type="radio" name="xdoc_fix_kind" value="pause"> <b>감시자 일시정지</b></label>
      <div class="xdoc-desc xdoc-warn">⚠️ 콜백을 아예 건너뛰어요. 그 확장의 자동 갱신 기능이 멈춰요(예: 목록을 바꿔도 폴더/그룹 표시가 안 바뀜).</div>
      ${isPP ? `<div class="xdoc-row">적용할 쪽: <select id="xdoc_fix_side" class="text_pole">
        <option value="both">양쪽 모두</option>
        <option value="a">${esc(ownerLabel(alert.a))}만</option>
        <option value="b">${esc(ownerLabel(alert.b))}만</option></select></div>` : ''}
      <div class="xdoc-row">적용 범위:
        <label class="radio_label"><input type="radio" name="xdoc_fix_scope" value="once" checked> 이번만 (새로고침하면 해제)</label>
        <label class="radio_label"><input type="radio" name="xdoc_fix_scope" value="persist"> 기억하기 (다음에도 적용)</label></div>
      <div class="xdoc-muted">다른 확장의 파일은 건드리지 않아요. 설정 패널의 "적용 중인 보정"에서 언제든 해제할 수 있어요.</div>`;
    const res = await new Popup(el, POPUP_TYPE.CONFIRM, '', { okButton: '적용', cancelButton: '취소', wide: true, allowVerticalScrolling: true }).show();
    if (res !== POPUP_RESULT.AFFIRMATIVE) return;

    const kind = el.querySelector('input[name="xdoc_fix_kind"]:checked')?.value || 'throttle';
    const persist = el.querySelector('input[name="xdoc_fix_scope"]:checked')?.value === 'persist';
    const interval = clamp(Number(el.querySelector('#xdoc_fix_interval')?.value) || 200, 16, 5000);
    const side = el.querySelector('#xdoc_fix_side')?.value || 'both';
    const chosen = targets.filter(t => !isPP || side === 'both' || (side === 'a' ? t.owner === alert.a : t.owner === alert.b));
    let n = 0;
    for (const t of chosen) {
        const exists = probe.rules.find(r => r.scope === 'observer' && r.owner === t.owner && r.target === t.sel && r.kind === kind);
        if (exists) continue;
        const partners = kind === 'ignorePartner' ? [t.owner === alert.a ? alert.b : alert.a] : undefined;
        probe.addRule({ id: newId(), scope: 'observer', kind, owner: t.owner, target: t.sel, interval, partners, persist });
        n++;
    }
    if (kind === 'throttle') { settings().throttleMs = interval; }
    persistRules();
    probe.resetAlertCooldown?.();
    toastr.success(`보정 ${n}개를 적용했어요.${persist ? ' (기억됨)' : ' (새로고침하면 해제)'}`);
}

async function offerEventHotfix(e) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const el = document.createElement('div');
    el.className = 'xdoc-fix';
    el.innerHTML = `<h3>이벤트 리스너 건너뛰기를 적용하시겠습니까?</h3>
      <p><b>${esc(ownerLabel(e.owner))}</b>가 ST 이벤트 <code>${esc(e.event)}</code>에 등록한 핸들러를 실행하지 않아요.</p>
      <div class="xdoc-desc xdoc-warn">⚠️ 그 확장이 이 이벤트에 의존하는 기능(예: 메시지 수신 시 처리)이 동작하지 않아요.</div>
      <div class="xdoc-row">적용 범위:
        <label class="radio_label"><input type="radio" name="xdoc_fix_scope" value="once" checked> 이번만</label>
        <label class="radio_label"><input type="radio" name="xdoc_fix_scope" value="persist"> 기억하기</label></div>`;
    const res = await new Popup(el, POPUP_TYPE.CONFIRM, '', { okButton: '적용', cancelButton: '취소' }).show();
    if (res !== POPUP_RESULT.AFFIRMATIVE) return;
    const persist = el.querySelector('input[name="xdoc_fix_scope"]:checked')?.value === 'persist';
    if (!probe.rules.some(r => r.scope === 'event' && r.owner === e.owner && r.event === e.event)) {
        probe.addRule({ id: newId(), scope: 'event', kind: 'skip', owner: e.owner, event: e.event, persist });
    }
    persistRules();
    toastr.success('적용했어요.');
}

async function renderHotfixList() {
    const box = document.getElementById('xdoc_hotfix_list');
    if (!box || !probe) return;
    const rules = probe.rules;
    await ensureNames(rules.map(r => r.owner).concat(rules.flatMap(r => r.partners || [])));
    if (!rules.length) { box.innerHTML = '<div class="xdoc-muted">적용 중인 보정이 없어요.</div>'; return; }
    box.innerHTML = rules.map(r => `<div class="xdoc-hf">
        <span>${esc(ruleLabel(r))} <span class="xdoc-muted">${r.persist ? '(기억됨)' : '(이번만)'}</span></span>
        <button type="button" class="menu_button xdoc-small" data-hf="${esc(r.id)}">해제</button></div>`).join('');
}

// ------------------------------------------------------------------ AI analysis

const AI_SYSTEM = `너는 SillyTavern 브라우저 확장(바닐라 JS)의 성능·충돌 디버깅 전문가다.
사용자가 보낸 진단 리포트와 코드 발췌만 근거로 분석한다. 추측은 "추정"이라고 밝힌다.
응답 형식(마크다운, 한국어):
## 원인
- 무엇이 왜 느리거나 루프를 도는지 쉬운 말로 설명.
## 수정안
확장마다 다음 형식:
### <확장 이름>
- 파일: <경로>, 줄: <대략 위치>
- 바꾸기 전:
\`\`\`js
<원래 코드>
\`\`\`
- 바꾼 후:
\`\`\`js
<수정 코드>
\`\`\`
- 이유: <한두 줄>
## 당장 할 수 있는 일
- 코드 수정 없이 사용자가 할 수 있는 일(설정, 확장 끄기 등).
수정안은 텍스트 제안일 뿐이며 사용자가 확장 제작자에게 전달한다.`;

function excerpt(text, line, col, radius) {
    const lines = text.split('\n');
    const L = lines[line - 1] ?? '';
    if (L.length > 1500) { // minified: character window around the column
        const c = clamp((col || 1) - 1, 0, L.length);
        return { from: line, to: line, code: L.slice(Math.max(0, c - 1500), c + 1500), lines: 1 };
    }
    const from = Math.max(1, line - radius); const to = Math.min(lines.length, line + radius);
    return { from, to, code: lines.slice(from - 1, to).join('\n'), lines: to - from + 1 };
}

async function collectCode(r) {
    const focus = new Set();
    r.loops.forEach(l => { focus.add(l.a); focus.add(l.b); });
    r.ranking.slice(0, 3).forEach(x => probe.isExtOwner(x.owner) && focus.add(x.owner));
    r.scan?.issues.filter(i => i.severity !== 'low').forEach(i => focus.add(i.ext));
    const loopIds = new Set(r.loops.flatMap(l => l.observerIds));
    const snap = probe.snapshot();

    const out = [];
    for (const owner of [...focus].slice(0, 6)) {
        const sites = [];
        snap.observers.filter(o => o.owner === owner && o.site && (loopIds.has(o.id) || r.hotObservers.some(h => h.id === o.id))).forEach(o => sites.push({ ...o.site, why: `감시자 생성 (${o.targets.map(t => t.sel).join(', ')})` }));
        r.intervals.filter(i => i.owner === owner && i.site).forEach(i => sites.push({ ...i.site, why: `setInterval ${i.delay}ms` }));
        r.scan?.issues.filter(i => i.ext === owner).forEach(i => sites.push({ url: location.origin + i.file, line: i.line, col: 1, why: i.msg }));
        let budget = 150;
        const parts = [];
        const seen = new Set();
        for (const s of sites) {
            if (budget <= 0) break;
            const path = new URL(s.url, location.origin).pathname;
            const key = `${path}:${Math.round(s.line / 20)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            let text;
            try { text = await fetchText(path); } catch { continue; }
            const radius = Math.max(5, Math.min(30, Math.floor(budget / 2) - 1));
            const ex = excerpt(text, s.line, s.col, radius);
            budget -= ex.lines;
            parts.push({ file: shortFile(path), from: ex.from, to: ex.to, why: s.why, code: ex.code, lines: ex.lines });
        }
        if (parts.length) out.push({ owner, parts, lines: parts.reduce((a, p) => a + p.lines, 0) });
    }
    return out;
}

function aiDestination() {
    const a = settings().ai;
    if (a.mode === 'profile') {
        let name = a.profileId;
        try { name = ctx().ConnectionManagerRequestService.getProfile(a.profileId)?.name || name; } catch { /* missing */ }
        return `ST 연결 프로필 "${name || '(선택 안 됨)'}"${a.profileModel ? `, 모델 ${a.profileModel}` : ''}`;
    }
    if (a.mode === 'direct') {
        let host = a.directUrl;
        try { host = new URL(a.directUrl).host; } catch { /* keep raw */ }
        return `직접 입력 ${host || '(URL 없음)'} / 모델 ${a.directModel || '(없음)'} — ST 서버를 거쳐 전송`;
    }
    return `현재 채팅 연결 (${ctx().mainApi})`;
}

function getDirectKey() {
    if (memKey) return memKey;
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}

async function callAi(system, user, signal) {
    const a = settings().ai;
    const c = ctx();
    const maxTokens = clamp(Number(a.maxTokens) || 4000, 256, 64000);
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    if (a.mode === 'profile') {
        const svc = c.ConnectionManagerRequestService;
        if (!a.profileId) throw new Error('연결 프로필을 선택해 주세요.');
        const prompt = svc.constructPrompt ? svc.constructPrompt(messages, a.profileId) : messages;
        const res = await svc.sendRequest(a.profileId, prompt, maxTokens, { stream: false, signal, extractData: true, includePreset: true }, a.profileModel ? { model: a.profileModel } : {});
        return typeof res === 'string' ? res : (res?.content ?? '');
    }
    if (a.mode === 'direct') {
        const key = getDirectKey();
        if (!a.directUrl) throw new Error('API URL을 입력해 주세요.');
        if (!a.directModel) throw new Error('모델 이름을 입력해 주세요.');
        // custom source + custom_include_headers: the backend spreads these headers after its own Authorization,
        // so the key is used for this request only and never written to secrets/settings (chat-completions.js).
        const res = await c.ChatCompletionService.processRequest({
            stream: false,
            messages,
            model: a.directModel,
            chat_completion_source: 'custom',
            custom_url: a.directUrl.replace(/\/+$/, ''),
            max_tokens: maxTokens,
            custom_include_headers: key ? JSON.stringify({ Authorization: `Bearer ${key}` }) : '',
        }, {}, true, signal);
        return typeof res === 'string' ? res : (res?.content ?? '');
    }
    // current chat connection
    const res = await c.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens });
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return res;
}

function renderMarkdown(md) {
    const { showdown, DOMPurify } = { showdown: libs().showdown || window.showdown, DOMPurify: libs().DOMPurify || window.DOMPurify };
    const conv = new showdown.Converter({ tables: true, ghCodeBlocks: true, strikethrough: true, simpleLineBreaks: true, openLinksInNewWindow: true });
    const html = DOMPurify.sanitize(conv.makeHtml(md), { FORBID_TAGS: ['style', 'iframe', 'form', 'input'], FORBID_ATTR: ['style'] });
    const wrap = document.createElement('div');
    wrap.className = 'xdoc-ai-md';
    wrap.innerHTML = html;
    wrap.querySelectorAll('pre').forEach(pre => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu_button xdoc-copy-code';
        btn.innerHTML = '<i class="fa-solid fa-copy"></i> 복사';
        btn.addEventListener('click', () => copyText(pre.querySelector('code')?.textContent ?? pre.textContent));
        pre.before(btn);
    });
    return wrap;
}

let aiRunning = null;

async function runAiAnalysis(r) {
    if (aiRunning) { toastr.warning('AI 분석이 이미 진행 중이에요.'); return; }
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    let code;
    try { code = await collectCode(r); } catch (e) { code = []; console.error(e); }
    const summary = reportToText(r).slice(0, 9000);
    const codeText = code.map(c => `### ${ownerLabel(c.owner)}\n` + c.parts.map(p => `파일 ${p.file} (줄 ${p.from}–${p.to}) — ${p.why}\n\`\`\`js\n${p.code}\n\`\`\``).join('\n')).join('\n\n');
    const user = `# 진단 리포트\n${summary}\n\n# 지목된 코드 발췌 (확장당 최대 150줄)\n${codeText || '(발췌 없음)'}`;
    const approxTokens = Math.round((AI_SYSTEM.length + user.length) / 3);

    const confirmEl = document.createElement('div');
    confirmEl.className = 'xdoc-fix';
    confirmEl.innerHTML = `<h3>AI 분석 — 보낼 내용 확인</h3>
      <p>보낼 곳: <b>${esc(aiDestination())}</b></p>
      <ul><li>진단 리포트 요약 (텍스트 ${fmtN(summary.length)}자)</li>
      ${code.map(c => `<li>${esc(ownerLabel(c.owner))} — 코드 ${c.lines}줄 (${esc(c.parts.map(p => `${p.file}:${p.from}-${p.to}`).join(', '))})</li>`).join('') || '<li>코드 발췌 없음</li>'}</ul>
      <p>대략 <b>${fmtN(approxTokens)} 토큰</b> + 응답 최대 ${fmtN(settings().ai.maxTokens)} 토큰. 전체 파일은 보내지 않아요.</p>
      ${settings().ai.mode === 'current' ? '<div class="xdoc-muted">현재 채팅 연결을 쓰면 그 API의 요금이 들어요.</div>' : ''}`;
    const ok = await new Popup(confirmEl, POPUP_TYPE.CONFIRM, '', { okButton: '보내기', cancelButton: '취소', wide: true, allowVerticalScrolling: true }).show();
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;

    const controller = new AbortController();
    const a = settings().ai;
    const timeoutMs = clamp(Number(a.timeoutSec) || 180, 15, 900) * 1000;
    const view = document.createElement('div');
    view.className = 'xdoc-ai';
    view.innerHTML = `<div class="xdoc-ai-status"><i class="fa-solid fa-spinner fa-spin"></i> AI 분석 중… <span class="xdoc-muted">${esc(aiDestination())}</span>
        <button type="button" class="menu_button xdoc-small" data-xdoc="stop">중지</button></div><div class="xdoc-ai-body"></div>`;
    const stop = (why) => {
        if (controller.signal.aborted) return;
        controller.abort(why);
        if (a.mode === 'current') { try { ctx().stopGeneration(); } catch { /* ignore */ } }
    };
    view.querySelector('[data-xdoc="stop"]').addEventListener('click', () => stop('user'));
    const popup = new Popup(view, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '닫기', onClosing: () => { stop('closed'); return true; } });
    popup.show();
    aiRunning = controller;
    const timer = T.setTimeout.call(window, () => stop('timeout'), timeoutMs);
    try {
        const text = await Promise.race([
            callAi(AI_SYSTEM, user, controller.signal),
            new Promise((_, rej) => controller.signal.addEventListener('abort', () => rej(new DOMException(String(controller.signal.reason || 'aborted'), 'AbortError')), { once: true })),
        ]);
        if (!text || !String(text).trim()) throw new Error('빈 응답을 받았어요.');
        view.querySelector('.xdoc-ai-status').innerHTML = `<b>AI 분석 결과</b> <span class="xdoc-muted">${esc(aiDestination())}</span> <button type="button" class="menu_button xdoc-small" data-xdoc="copyall"><i class="fa-solid fa-copy"></i> 전체 복사</button>`;
        view.querySelector('[data-xdoc="copyall"]').addEventListener('click', () => copyText(String(text)));
        view.querySelector('.xdoc-ai-body').replaceChildren(renderMarkdown(String(text)));
    } catch (e) {
        const reason = controller.signal.reason;
        const msg = reason === 'timeout' ? `시간 초과 (${timeoutMs / 1000}초)` : reason === 'user' ? '중지했어요.' : reason === 'closed' ? '창을 닫아 중지했어요.' : (e?.cause?.message || e?.message || String(e));
        if (reason !== 'closed') view.querySelector('.xdoc-ai-status').innerHTML = `<span class="xdoc-bad">AI 분석 실패: ${esc(msg)}</span>`;
        if (reason !== 'user' && reason !== 'closed') toastr.error(`AI 분석 실패: ${msg}`, 'Extension Doctor');
        console.error('[ExtensionDoctor] AI', e);
    } finally {
        T.clearTimeout.call(window, timer);
        aiRunning = null;
    }
}

// ------------------------------------------------------------------ settings panel

function refreshProfiles() {
    const sel = document.getElementById('xdoc_profile');
    if (!sel) return;
    const a = settings().ai;
    let profiles = [];
    let err = '';
    try { profiles = ctx().ConnectionManagerRequestService.getSupportedProfiles(); } catch (e) { err = e.message; }
    sel.innerHTML = `<option value="">${err ? '연결 관리자(Connection Manager)가 꺼져 있어요' : '— 프로필 선택 —'}</option>`
        + profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.model ? ` (${esc(p.model)})` : ''}</option>`).join('');
    sel.value = profiles.some(p => p.id === a.profileId) ? a.profileId : '';
}

function showAiMode() {
    const mode = settings().ai.mode;
    document.querySelectorAll('.xdoc-ai-mode').forEach(el => { el.style.display = el.dataset.mode === mode ? '' : 'none'; });
    if (mode === 'profile') refreshProfiles();
}

async function initPanel() {
    const html = await ctx().renderExtensionTemplateAsync(EXT_PATH, 'settings');
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    $(target).append(html);
    const s = settings();
    const $root = $('#xdoc_settings');

    $('#xdoc_duration').val(s.duration);
    $('#xdoc_duration_val').text(`${s.duration}초`);
    $('#xdoc_loop').prop('checked', s.loopDetect);
    $('#xdoc_threshold').val(s.rateThreshold);
    $(`input[name="xdoc_ai_mode"][value="${s.ai.mode}"]`).prop('checked', true);
    $('#xdoc_profile_model').val(s.ai.profileModel);
    $('#xdoc_direct_url').val(s.ai.directUrl);
    $('#xdoc_direct_model').val(s.ai.directModel);
    $('#xdoc_remember_key').prop('checked', s.ai.rememberKey);
    $('#xdoc_direct_key').val(getDirectKey());
    $('#xdoc_max_tokens').val(s.ai.maxTokens);
    $('#xdoc_timeout').val(s.ai.timeoutSec);
    if (!window.isSecureContext) $('#xdoc_http_note').show();
    refreshProfiles();
    showAiMode();
    renderHotfixList();

    $root.on('click', '#xdoc_start', () => (diag ? finishDiagnosis(true) : startDiagnosis()));
    $root.on('click', '#xdoc_quick', () => showQuickReport(lastAlerts[0] || null));
    $root.on('input', '#xdoc_duration', function () { s.duration = Number(this.value); $('#xdoc_duration_val').text(`${s.duration}초`); save(); });
    $root.on('change', '#xdoc_loop', function () { s.loopDetect = this.checked; probe.config.loopDetect = this.checked; save(); });
    $root.on('change', '#xdoc_threshold', function () { s.rateThreshold = clamp(Number(this.value) || 30, 5, 1000); this.value = s.rateThreshold; probe.config.rateThreshold = s.rateThreshold; save(); });
    $root.on('change', 'input[name="xdoc_ai_mode"]', function () { s.ai.mode = this.value; showAiMode(); save(); });
    $root.on('mousedown focus', '#xdoc_profile', function () {
        // Rebuild only if the profile list changed, so an open dropdown is not reset while the user picks.
        try {
            const ids = ctx().ConnectionManagerRequestService.getSupportedProfiles().map(p => p.id).join(',');
            const cur = [...this.options].map(o => o.value).filter(Boolean).join(',');
            if (ids !== cur) refreshProfiles();
        } catch { /* connection manager disabled */ }
    });
    $root.on('click', '#xdoc_profile_refresh', refreshProfiles);
    $root.on('change', '#xdoc_profile', function () { s.ai.profileId = this.value; save(); });
    $root.on('change', '#xdoc_profile_model', function () { s.ai.profileModel = this.value.trim(); save(); });
    $root.on('change', '#xdoc_direct_url', function () { s.ai.directUrl = this.value.trim(); save(); });
    $root.on('change', '#xdoc_direct_model', function () { s.ai.directModel = this.value.trim(); save(); });
    $root.on('change', '#xdoc_max_tokens', function () { s.ai.maxTokens = clamp(Number(this.value) || 4000, 256, 64000); this.value = s.ai.maxTokens; save(); });
    $root.on('change', '#xdoc_timeout', function () { s.ai.timeoutSec = clamp(Number(this.value) || 180, 15, 900); this.value = s.ai.timeoutSec; save(); });
    $root.on('input', '#xdoc_direct_key', function () {
        memKey = this.value;
        try { if (s.ai.rememberKey) localStorage.setItem(KEY_STORAGE, memKey); } catch { /* storage blocked */ }
    });
    $root.on('change', '#xdoc_remember_key', function () {
        s.ai.rememberKey = this.checked;
        try {
            if (this.checked && memKey) localStorage.setItem(KEY_STORAGE, memKey);
            if (!this.checked) localStorage.removeItem(KEY_STORAGE);
        } catch { /* storage blocked */ }
        save();
    });
    $root.on('click', 'button[data-hf]', function () {
        probe.removeRule(this.dataset.hf);
        persistRules();
        toastr.info('보정을 해제했어요.');
    });
}

function registerCommand() {
    try {
        const { SlashCommandParser, SlashCommand } = ctx();
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'doctor',
            callback: () => { startDiagnosis(); return ''; },
            helpString: 'Extension Doctor 진단을 시작합니다 (설정한 시간 동안 기록 후 리포트 표시).',
        }));
    } catch (e) { console.warn('[ExtensionDoctor] slash command not registered', e); }
}

// ------------------------------------------------------------------ boot

if (probe) {
    // Register the alert handler immediately (synchronously, before later extensions load).
    probe.onAlert(onProbeAlert);
    try {
        const s = settings();
        probe.config.loopDetect = s.loopDetect;
        probe.config.rateThreshold = s.rateThreshold;
        if (!probe.rules.length && s.hotfixes.length) probe.setRules(s.hotfixes.map(r => ({ ...r, persist: true })));
        probe.wrapEventSource();
    } catch (e) { console.error('[ExtensionDoctor]', e); }
}

jQuery(async () => {
    try {
        await initPanel();
        registerCommand();
    } catch (e) {
        console.error('[ExtensionDoctor] init failed', e);
    }
});
