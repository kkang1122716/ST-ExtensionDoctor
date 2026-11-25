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
    rateThreshold: 100,
    duration: 30,
    throttleMs: 200,
    debounceMs: 300,
    freezeAlert: true,
    freezeMs: 1500,
    toastSource: true,
    ai: { mode: 'current', profileId: '', profileModel: '', directUrl: '', directModel: '', rememberKey: false, maxTokens: 16000, timeoutSec: 180 },
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
    // 1.3.1: default freeze threshold 1s -> 1.5s (only if the user never changed it)
    if (!s.freezeV2) { if (Number(s.freezeMs) === 1000) s.freezeMs = 1500; s.freezeV2 = true; }
    // 1.4.2: default loop-rate threshold 30 -> 100 (only if the user never changed it)
    if (!s.rateV2) { if (Number(s.rateThreshold) === 30) s.rateThreshold = 100; s.rateV2 = true; }
    // v1.0.0 default (4000) was too small for thinking models; lift it once.
    if (!s.ai.tokensV2) { if (Number(s.ai.maxTokens) === 4000) s.ai.maxTokens = 16000; s.ai.tokensV2 = true; }
    // Defensive: a key must never live in settings.json.
    if ('directKey' in s.ai) delete s.ai.directKey;
    return s;
}
const save = () => ctx().saveSettingsDebounced();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(ms < 10 ? 1 : 0)}ms`);
const fmtN = n => Number(n || 0).toLocaleString('ko-KR');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

async function copyText(text, anchor = null) {
    try {
        if (window.isSecureContext && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            toastr.success('복사했어요.');
            return;
        }
    } catch { /* fall through to legacy path */ }
    // http:// (insecure context) fallback. ST popups are modal <dialog>s: everything outside the top dialog is
    // inert, so the helper textarea must live inside that dialog or select()/execCommand silently fail.
    const openDialogs = [...document.querySelectorAll('dialog[open]')];
    const parent = anchor?.closest?.('dialog') || openDialogs[openDialogs.length - 1] || document.body;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
    parent.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
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
        let msg;
        let canFix = true;
        if (a.type === 'pingpong') msg = `⚠️ 루프 의심: ${ownerLabel(a.a)} ↔ ${ownerLabel(a.b)} (초당 ${fmtN(a.perSec)}회)`;
        else if (a.type === 'freeze') {
            msg = `⚠️ 화면 ${(a.freeze.duration / 1000).toFixed(1)}초 멈춤: ${ownerLabel(a.owner)} — ${freezeWhat(a.freeze)}`;
            canFix = !!findDomRecsFor(a.owner, a.freeze.type, a.freeze.target).length;
        } else msg = `⚠️ 감시자 과다 호출: ${ownerLabel(a.owner)} — 대상 ${a.target} (초당 ${fmtN(a.perSec)}회)`;
        console.warn('[ExtensionDoctor]', msg, a);
        lastAlerts.unshift({ ...a, msg, at: Date.now() });
        lastAlerts.length = Math.min(lastAlerts.length, 20);
        const html = `<div class="xdoc-toast"><div class="xdoc-toast-msg">${esc(msg)}</div>
            <div class="xdoc-toast-btns">
              <button type="button" class="menu_button" data-xdoc="view">진단 보기</button>
              ${canFix ? '<button type="button" class="menu_button" data-xdoc="fix">임시 보정 적용하시겠습니까?</button>' : ''}
            </div></div>`;
        const $t = toastr.warning(html, 'Extension Doctor', { timeOut: 20000, extendedTimeOut: 10000, escapeHtml: false, tapToDismiss: false, closeButton: true });
        $t?.on?.('click', 'button[data-xdoc]', ev => {
            ev.stopPropagation();
            const act = ev.currentTarget.dataset.xdoc;
            toastr.clear($t);
            if (act === 'view') showQuickReport(a);
            else if (a.type === 'freeze') offerDomHotfix({ owner: a.owner, type: a.freeze.type, target: a.freeze.target });
            else offerObserverHotfix(a);
        });
    });
}

const EVENT_KO = {
    input: '글자 입력', beforeinput: '글자 입력', keydown: '키 누름', keyup: '키 뗌', keypress: '키 입력',
    scroll: '스크롤', wheel: '마우스 휠', mousemove: '마우스 이동', pointermove: '포인터 이동', touchmove: '터치 이동',
    resize: '창 크기 변경', selectionchange: '선택 변경', click: '클릭', pointerup: '클릭(뗌)', pointerdown: '클릭(누름)', change: '값 변경',
};
const eventKo = t => EVENT_KO[t] || t;

function freezeWhat(f) {
    if (f.type) return `${eventKo(f.type)} 반응${f.target ? ` (${f.target})` : ''}`;
    if (f.kind === 'observer') return '화면 감시자';
    if (f.kind === 'interval') return '반복 타이머';
    if (f.kind === 'event') return 'ST 이벤트 처리';
    if (f.kind === 'timer') return '타이머';
    if (/TimerHandler:setInterval/.test(f.invoker)) return '반복 타이머';
    if (/TimerHandler/.test(f.invoker)) return '타이머';
    if (/FrameRequestCallback/.test(f.invoker)) return '화면 그리기 콜백';
    if (/MutationObserver|MutationCallback/i.test(f.invoker)) return '화면 감시자';
    return f.fn ? `${f.fn}()` : (f.invoker || '스크립트');
}

/** DOM listener records of an extension for an event type; prefers the exact target when given. */
function findDomRecsFor(owner, type, target) {
    if (!probe || !type) return [];
    const all = probe.snapshot().dom.filter(d => d.owner === owner && d.type === type);
    const exact = target ? all.filter(d => d.target === target || d.target.endsWith(`→ ${target}`)) : [];
    return exact.length ? exact : all;
}
const lastAlerts = [];

// ------------------------------------------------------------------ error toast origin ("보낸 곳")

const toastLog = []; // recent error/warning toasts with their origin (this page session only)
const TOAST_LOG_MAX = 20;
let toastSourceOn = true;

function toastOriginLabel(src) {
    if (src.owner === 'core') return 'ST 본체 (채팅 생성 등 ST 자체 기능)';
    if (src.owner === 'unknown' || !src.owner) return '알 수 없음';
    return ownerLabel(src.owner);
}

function toastOriginHtml(src) {
    const guess = src.how === 'api' ? ' <span class="xdoc-muted">(추정: 직전 API 요청 기준)</span>' : '';
    const a = src.api;
    const api = a ? `<div class="xdoc-toast-src-sub">${esc(a.url)}${a.status ? ` · ${a.status}` : a.ok === false ? ' · 연결 실패' : ''}</div>` : '';
    return `📍 보낸 곳: <b>${esc(toastOriginLabel(src))}</b>${guess}${api}`;
}

function tagToast($t, src, entry) {
    const el = $t?.[0] || $t;
    if (!el || typeof el.appendChild !== 'function') return;
    const div = document.createElement('div');
    div.className = 'xdoc-toast-src';
    div.title = '눌러서 자세히 보기 (어떻게 찾았는지, 코드 위치, 호출 흐름)';
    const fill = () => { div.innerHTML = `${toastOriginHtml(src)}<div class="xdoc-toast-src-more">🔍 눌러서 자세히 보기</div>`; };
    fill();
    div.addEventListener('click', ev => { ev.stopPropagation(); showToastDetail(entry); });
    (el.querySelector('.toast-message') || el).appendChild(div);
    if (probe.isExtOwner(src.owner) && !nameCache.has(src.owner)) ensureNames([src.owner]).then(fill);
}

const HOW_KO = {
    stack: '호출 흐름에서 이 코드가 직접 보였어요. (확실)',
    ctx: '이 확장이 등록한 콜백(타이머·이벤트 등)이 실행되는 중에 뜬 알림이에요. (확실)',
    api: '호출 흐름에서는 확장을 못 찾아서, 알림 직전 4초 안에 이 확장이 보낸 API 요청으로 짐작했어요. (추정)',
    core: '호출 흐름에 확장 코드가 하나도 없었어요. ST 자체 기능(메인 채팅 생성, 연결 확인 등)이 띄운 알림이에요.',
};
const howKo = t => (t.how === 'stack' && !probe.isExtOwner(t.owner) && t.owner !== probe.SELF ? HOW_KO.core : HOW_KO[t.how] || '');

const framePath = url => shortFile(String(url || '').replace(location.origin, ''));
function frameOwnerLabel(o) { return o === 'core' ? 'ST' : o === 'unknown' ? '?' : ownerLabel(o); }

function toastDetailText(t) {
    const L = [`[Extension Doctor] 오류 알림 상세 — ${fmtDate(t.at)}`, `알림: ${t.title ? `[${t.title}] ` : ''}${t.msg}`, `보낸 곳: ${toastOriginLabel(t)}`, `판단 근거: ${howKo(t)}`];
    if (t.api) L.push(`요청: ${t.api.url}${t.api.status ? ` (상태 ${t.api.status})` : t.api.ok === false ? ' (연결 실패)' : ''}`);
    if (t.site) L.push(`코드 위치: ${t.site.url}:${t.site.line}`);
    if (t.stack?.length) {
        L.push('호출 흐름 (위가 알림을 띄운 곳):');
        for (const f of t.stack) L.push(`  ${f.async ? 'async ' : ''}${f.fn || '(익명)'} — ${frameOwnerLabel(f.owner)} ${framePath(f.url)}:${f.line}`);
    }
    return L.join('\n');
}

/** Fetch a few lines around file:line (same-origin files only) so the user can see the code that sent the request. */
async function codeAround(site, radius = 6) {
    try {
        const u = new URL(site.url, location.href);
        if (u.origin !== location.origin) return null;
        const res = await fetch(u.href);
        if (!res.ok) return null;
        const lines = (await res.text()).split(/\r?\n/);
        const from = Math.max(1, site.line - radius); const to = Math.min(lines.length, site.line + radius);
        const out = [];
        for (let i = from; i <= to; i++) out.push({ n: i, text: lines[i - 1].length > 240 ? `${lines[i - 1].slice(0, 240)} …` : lines[i - 1], hit: i === site.line });
        return out;
    } catch { return null; }
}

async function showToastDetail(t) {
    if (!t) return;
    const owners = [t.owner, ...(t.stack || []).map(f => f.owner)];
    await ensureNames(owners);
    const { Popup, POPUP_TYPE } = ctx();
    const el = document.createElement('div');
    el.className = 'xdoc-report xdoc-toast-detail';
    const apiTxt = t.api ? `${t.api.url}${t.api.status ? ` · 상태 ${t.api.status}` : t.api.ok === false ? ' · 연결 실패' : ''}` : '';
    const stackRows = (t.stack || []).map(f => {
        const ext = probe.isExtOwner(f.owner) || f.owner === probe.SELF;
        return `<tr class="${ext ? 'xdoc-frame-ext' : ''}"><td>${f.async ? '<span class="xdoc-muted">async</span> ' : ''}${esc(f.fn || '(익명)')}</td><td>${ext ? `<b>${esc(frameOwnerLabel(f.owner))}</b>` : esc(frameOwnerLabel(f.owner))}</td><td>${esc(framePath(f.url))}:${f.line}</td></tr>`;
    }).join('');
    el.innerHTML = `<h3>오류 알림 상세</h3>
      <table class="xdoc-table"><tbody>
        <tr><th>언제</th><td>${esc(fmtDate(t.at))}</td></tr>
        <tr><th>알림</th><td>${esc(`${t.title ? `[${t.title}] ` : ''}${t.msg}`)}</td></tr>
        <tr><th>보낸 곳</th><td><b>${esc(toastOriginLabel(t))}</b></td></tr>
        <tr><th>판단 근거</th><td>${esc(howKo(t))}</td></tr>
        ${apiTxt ? `<tr><th>요청</th><td>${esc(apiTxt)}</td></tr>` : ''}
        ${t.site ? `<tr><th>코드 위치</th><td>${esc(t.site.url.replace(location.origin, ''))}:${t.site.line}</td></tr>` : ''}
      </tbody></table>
      ${t.site ? '<h4>그 위치의 코드</h4><div class="xdoc-code-around xdoc-muted">불러오는 중…</div>' : ''}
      ${stackRows ? `<h4>호출 흐름 <span class="xdoc-muted">위가 알림을 띄운 곳, 아래로 갈수록 그걸 부른 곳. 굵은 줄이 확장 코드예요.</span></h4>
        <table class="xdoc-table"><thead><tr><th>함수</th><th>누구</th><th>파일:줄</th></tr></thead><tbody>${stackRows}</tbody></table>` : ''}
      <div class="xdoc-actions"><button type="button" class="menu_button" data-xdoc="copy-toast"><i class="fa-solid fa-copy"></i> 상세 복사</button></div>`;
    el.querySelector('[data-xdoc="copy-toast"]').addEventListener('click', ev => copyText(toastDetailText(t), ev.currentTarget));
    new Popup(el, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, okButton: '닫기' }).show();
    if (t.site) {
        const box = el.querySelector('.xdoc-code-around');
        const lines = await codeAround(t.site);
        if (!lines) { box.textContent = '코드를 불러오지 못했어요.'; return; }
        box.classList.remove('xdoc-muted');
        box.innerHTML = `<pre>${lines.map(l => `<span class="${l.hit ? 'xdoc-code-hit' : ''}">${String(l.n).padStart(5)}  ${esc(l.text)}</span>`).join('\n')}</pre>`;
    }
}

/**
 * Mask things that look like secrets (API keys, bearer tokens, key=… query params) before text is stored,
 * shown in reports, copied, or sent to an AI. Error messages and extension code can contain them.
 */
const keepHead = m => `${m.slice(0, 4)}***`;
const SECRET_RULES = [
    [/\b(?:sk|pk|rk)-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g, keepHead], // OpenAI / Anthropic / OpenRouter style (sk-..., sk-ant-..., sk-or-v1-...)
    [/\bAIza[0-9A-Za-z_-]{30,}/g, keepHead], // Google
    [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, keepHead], // GitHub
    [/\bxai-[A-Za-z0-9]{20,}/g, keepHead],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (m, kind) => `${kind} ***`],
    [/([?&](?:key|api_key|apikey|token|access_token|password)=)[^&\s"'#]+/gi, (m, head) => `${head}***`],
    [/((?:api[_-]?key|apikey|secret|password|access[_-]?token|authorization)["']?\s*[:=]\s*["'])[^"'\n]{6,}(["'])/gi, (m, head, q) => `${head}***${q}`],
];
function redactSecrets(text) {
    let s = String(text ?? '');
    for (const [re, fn] of SECRET_RULES) s = s.replace(re, fn);
    return s;
}

const stripText = v => redactSecrets(String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 160);

/** Wrap toastr.error/warning so every error toast says which extension (or ST itself) caused it. */
function patchToasts() {
    const tr = window.toastr;
    if (!tr || tr.__xdocPatched || typeof probe?.toastSource !== 'function') return;
    for (const kind of ['error', 'warning']) {
        const original = tr[kind];
        if (typeof original !== 'function') continue;
        const wrapped = function (message, title) {
            let src = null;
            if (toastSourceOn) { try { src = probe.toastSource(wrapped); } catch { src = null; } }
            const $t = original.apply(this, arguments);
            if (src) {
                try {
                    const entry = { at: Date.now(), kind, title: stripText(title), msg: stripText(message), owner: src.owner, how: src.how, site: src.site,
                        api: src.api ? { url: src.api.url, status: src.api.status, ok: src.api.ok } : null, stack: src.stack || null };
                    tagToast($t, src, entry);
                    toastLog.unshift(entry);
                    if (toastLog.length > TOAST_LOG_MAX) toastLog.length = TOAST_LOG_MAX;
                    console.info('[ExtensionDoctor] 알림 보낸 곳:', toastOriginLabel(src), src.site ? `${src.site.url}:${src.site.line}` : '', src.api?.url || '');
                } catch { /* never break a toast */ }
            }
            return $t;
        };
        tr[kind] = wrapped;
    }
    tr.__xdocPatched = true;
}

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

    const domHandlers = diffBy(start?.dom, end.dom || [], x => x.key).map(({ cur, prev }) => ({
        ...cur, dCalls: cur.calls - (prev?.calls || 0), dMs: cur.totalMs - (prev?.totalMs || 0), dEvents: cur.events - (prev?.events || 0),
    })).filter(d => d.owner !== probe.SELF && d.dEvents > 0).sort((a, b) => b.dMs - a.dMs).slice(0, 15);
    const since = start?.at ?? 0;
    const bigFreezes = (end.freezes || []).filter(f => f.at >= since && f.owner !== probe.SELF).sort((a, b) => b.duration - a.duration).slice(0, 10);

    return {
        kind: extra.kind || 'diagnosis', durSec, stopped: !!extra.stopped, alert: extra.alert || null, at: Date.now(),
        ranking, loops, conflicts: findConflicts(end.observers, new Set(edgeDiff.filter(e => e.d > 0 && e.from !== e.to).map(e => [e.from, e.to].sort().join('|')))),
        hotObservers, intervals, events: evs, domHandlers, bigFreezes, freezeWatch: !!end.freezeWatch,
        toasts: toastLog.slice(0, 10),
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
    report.domHandlers?.forEach(o => s.add(o.owner));
    report.toasts?.forEach(o => s.add(o.owner));
    report.bigFreezes?.forEach(o => s.add(o.owner));
    report.compare?.exts.forEach(o => s.add(o.owner));
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
    if (r.compare) {
        const c = r.compare;
        L.push(`\n## 지난 진단(${fmtDate(c.prev.at)})과 비교`);
        for (const m of c.metrics) L.push(`- ${m.label}: ${fmtMetric(m, m.prev)} → ${fmtMetric(m, m.cur)} (${changeText(m.prev, m.cur)})`);
        for (const e of c.exts) L.push(`- ${ownerLabel(e.owner)}: 초당 ${e.prev.toFixed(1)}ms → ${e.cur.toFixed(1)}ms${e.note ? ` (${e.note})` : ''}`);
    }
    if (r.domHandlers?.length) {
        L.push('\n## 입력·스크롤 반응 코드 (확장이 단 것)');
        for (const d of r.domHandlers) L.push(`- ${ownerLabel(d.owner)} ${eventKo(d.type)} @ ${d.target}: 이벤트 ${fmtN(d.dEvents)}회, 실행 ${fmtN(d.dCalls)}회, ${fmtMs(d.dMs)} (최대 ${fmtMs(d.maxMs)}) ${siteStr(d.site)}`);
    }
    if (r.toasts?.length) {
        L.push('\n## 최근 오류 알림과 보낸 곳');
        for (const t of r.toasts) {
            L.push(`- ${fmtDate(t.at)} ${t.title ? `[${t.title}] ` : ''}${t.msg} → ${toastOriginLabel(t)}${t.how === 'api' ? ' (추정)' : ''}${t.api ? ` ${t.api.url}${t.api.status ? ` ${t.api.status}` : ''}` : ''} ${siteStr(t.site)}`);
        }
    }
    if (!r.frames && r.bigFreezes?.length) {
        L.push('\n## 최근 큰 멈춤');
        for (const f of r.bigFreezes) L.push(`- ${fmtMs(f.duration)} — ${ownerLabel(f.owner)} ${freezeWhat(f)} ${shortFile(f.file)}`);
    }
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
    if (r.restored) parts.push('<div class="xdoc-muted">새로고침 전에 만든 리포트예요. 표의 [보정] 버튼은 지금 화면에 없는 대상일 수 있으니, 다시 진단한 뒤 써 주세요.</div>');

    if (r.compare) {
        const c = r.compare;
        parts.push(`<h4>지난 진단과 비교 <span class="xdoc-muted">${esc(fmtDate(c.prev.at))} 진단 대비 · 초당 값으로 맞춰 비교</span></h4>`);
        parts.push(table(['항목', '지난번', '이번', '변화'], c.metrics.map(m => [esc(m.label), fmtMetric(m, m.prev), fmtMetric(m, m.cur), changeHtml(m.prev, m.cur)])));
        if (c.exts.length) {
            parts.push(table(['확장 (CPU+멈춤, 초당)', '지난번', '이번', '변화'], c.exts.map(e => [esc(ownerLabel(e.owner)) + (e.note ? ` <span class="xdoc-muted">(${esc(e.note)})</span>` : ''),
                `${e.prev.toFixed(1)}ms`, `${e.cur.toFixed(1)}ms`, changeHtml(e.prev, e.cur)])));
        }
    }

    if (r.toasts?.length) {
        parts.push('<h4>최근 오류 알림과 보낸 곳 <span class="xdoc-muted">이 페이지를 연 뒤 뜬 빨간·노란 알림</span></h4>');
        parts.push(table(['언제', '알림', '보낸 곳', '요청', ''], r.toasts.map((t, i) => [esc(fmtDate(t.at)), esc(`${t.title ? `[${t.title}] ` : ''}${t.msg}`),
            `<b>${esc(toastOriginLabel(t))}</b>${t.how === 'api' ? ' <span class="xdoc-muted">(추정)</span>' : ''}${t.site ? `<br><span class="xdoc-muted">${esc(siteStr(t.site))}</span>` : ''}`,
            t.api ? esc(`${t.api.url}${t.api.status ? ` · ${t.api.status}` : ''}`) : '',
            `<button type="button" class="menu_button xdoc-small" data-xdoc="toast-detail" data-i="${i}">자세히</button>`])));
    }

    if (!r.frames && r.bigFreezes?.length) {
        parts.push('<h4>최근 큰 멈춤 <span class="xdoc-muted">페이지를 연 뒤 0.2초 넘게 멈춘 순간</span></h4>');
        parts.push(table(['길이', '확장', '무엇을 하다가', ''], r.bigFreezes.map((f, i) => [fmtMs(f.duration), esc(ownerLabel(f.owner)), esc(`${freezeWhat(f)} ${shortFile(f.file)}`),
            f.type && probe.isExtOwner(f.owner) ? `<button type="button" class="menu_button xdoc-small" data-xdoc="fix-fz" data-i="${i}">보정</button>` : ''])));
    }

    if (r.domHandlers?.length) {
        parts.push('<h4>입력·스크롤 반응 코드 <span class="xdoc-muted">확장이 글자 입력·스크롤·마우스 이동 등에 단 코드</span></h4>');
        parts.push(table(['확장', '반응', '대상', '이벤트', '실행', '시간', '최대', ''], r.domHandlers.map((d, i) => [esc(ownerLabel(d.owner)), esc(eventKo(d.type)), esc(d.target),
            fmtN(d.dEvents), fmtN(d.dCalls), fmtMs(d.dMs), fmtMs(d.maxMs), `<button type="button" class="menu_button xdoc-small" data-xdoc="fix-dom" data-i="${i}">보정</button>`])));
    }

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
        if (act === 'copy') copyText(redactSecrets(reportToText(r)), b);
        else if (act === 'ai') runAiAnalysis(r);
        else if (act === 'fix-loop') { const l = r.loops[Number(b.dataset.i)]; offerObserverHotfix({ type: 'pingpong', a: l.a, b: l.b, observerIds: l.observerIds, perSec: Math.round(l.perSec) }); }
        else if (act === 'fix-obs') { const o = r.hotObservers.find(x => String(x.id) === b.dataset.id); if (o) offerObserverHotfix({ type: 'rate', owner: o.owner, observerId: o.id, target: o.targets[0]?.sel || '*' }); }
        else if (act === 'fix-ev') { const e = r.events[Number(b.dataset.i)]; if (e) offerEventHotfix(e); }
        else if (act === 'fix-dom') { const d = r.domHandlers[Number(b.dataset.i)]; if (d) offerDomHotfix({ owner: d.owner, type: d.type, target: d.target }); }
        else if (act === 'toast-detail') showToastDetail(r.toasts?.[Number(b.dataset.i)]);
        else if (act === 'fix-fz') { const f = r.bigFreezes[Number(b.dataset.i)]; if (f) offerDomHotfix({ owner: f.owner, type: f.type, target: f.target }); }
    });
    new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '닫기' }).show();
}

async function showQuickReport(alert = null) {
    const list = await discoverExtensions();
    const r = buildReport(null, probe.snapshot(), { kind: 'cumulative', alert, dom: countDom(list.map(x => x.name)) });
    showReport(r);
}

// ------------------------------------------------------------------ history (this browser only) & comparison

const HIST_KEY = 'extensionDoctor.history';
const LAST_KEY = 'extensionDoctor.lastReport';
const HIST_MAX = 10;

function loadHistory() {
    try { const v = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function storeHistory(list) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch { /* storage full or blocked */ }
}
function storeLastReport(r) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(r, (k, v) => (k === 'el' ? undefined : v))); } catch { /* too big or blocked: keep in memory only */ }
}
function loadLastReport() {
    try { const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); return v && Array.isArray(v.ranking) ? { ...v, restored: true } : null; } catch { return null; }
}

/** Compact, per-second numbers of a diagnosis so runs of different length can be compared. */
function summarizeReport(r) {
    const per = v => v / r.durSec;
    const ext = {};
    for (const x of r.ranking) if (probe.isExtOwner(x.owner)) ext[x.owner] = per(x.cpuMs + x.loafMs);
    return {
        at: r.at, durSec: r.durSec,
        cpuPerSec: per(r.ranking.reduce((a, x) => a + x.cpuMs, 0)),
        freezeMsPerMin: r.frames && r.frames.type !== 'none' ? per(r.frames.totalMs) * 60 : null,
        freezePerMin: r.frames && r.frames.type !== 'none' ? per(r.frames.count) * 60 : null,
        domTotal: r.dom?.total ?? null, iframes: r.dom?.iframes ?? null, loops: r.loops.length, ext,
    };
}

function buildCompare(prev, cur) {
    const metrics = [
        { label: '확장 콜백 CPU (초당)', unit: 'msps', prev: prev.cpuPerSec, cur: cur.cpuPerSec },
        { label: '멈춤 시간 (1분당)', unit: 'ms', prev: prev.freezeMsPerMin, cur: cur.freezeMsPerMin },
        { label: '멈춤 횟수 (1분당)', unit: 'n1', prev: prev.freezePerMin, cur: cur.freezePerMin },
        { label: '전체 화면 요소', unit: 'n', prev: prev.domTotal, cur: cur.domTotal },
        { label: 'iframe', unit: 'n', prev: prev.iframes, cur: cur.iframes },
        { label: '루프 의심', unit: 'n', prev: prev.loops, cur: cur.loops },
    ].filter(m => m.prev != null && m.cur != null);
    const owners = new Set([...Object.keys(prev.ext || {}), ...Object.keys(cur.ext || {})]);
    const exts = [...owners].map(o => {
        const p = prev.ext?.[o]; const c = cur.ext?.[o];
        return { owner: o, prev: p ?? 0, cur: c ?? 0, note: p == null ? '이번에 새로 보임' : c == null ? '이번엔 안 보임 (꺼짐?)' : '' };
    }).filter(e => e.note || Math.abs(e.cur - e.prev) >= 0.5)
        .sort((a, b) => Math.abs(b.cur - b.prev) - Math.abs(a.cur - a.prev)).slice(0, 10);
    return { prev: { at: prev.at }, metrics, exts };
}

function fmtMetric(m, v) {
    if (v == null) return '-';
    if (m.unit === 'msps') return `${v.toFixed(1)}ms`;
    if (m.unit === 'ms') return fmtMs(v);
    if (m.unit === 'n1') return `${v.toFixed(1)}회`;
    return fmtN(Math.round(v));
}
const fmtDate = at => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function changeInfo(prev, cur) {
    if (prev === cur) return { dir: 0, text: '변화 없음' };
    if (!prev) return { dir: cur > 0 ? 1 : 0, text: cur > 0 ? '새로 생김' : '변화 없음' };
    const pct = ((cur - prev) / prev) * 100;
    if (Math.abs(pct) < 3) return { dir: 0, text: '거의 같음' };
    return { dir: pct < 0 ? -1 : 1, text: `${pct < 0 ? '▼' : '▲'} ${Math.abs(pct).toFixed(0)}%` };
}
const changeText = (p, c) => changeInfo(p, c).text;
function changeHtml(p, c) {
    const i = changeInfo(p, c);
    return `<span class="${i.dir < 0 ? 'xdoc-good' : i.dir > 0 ? 'xdoc-bad' : 'xdoc-muted'}">${esc(i.text)}</span>`;
}

function renderHistoryInfo() {
    const n = loadHistory().length;
    $('#xdoc_history_info').text(n ? `저장된 진단 기록 ${n}개 (이 브라우저에만 저장, 최근 ${HIST_MAX}개)` : '저장된 진단 기록이 없어요.');
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
                if (type === 'loaf' && probe.effectiveFreezeMs(e) < 50) continue;
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
        const felt = type === 'loaf' ? probe.effectiveFreezeMs(e) : e.duration;
        totalMs += felt;
        let owner = 'unknown'; let script = '';
        if (type === 'loaf' && e.scripts?.length) {
            // attributeScript matches the frame against probe timings, so wrapped (probe.js) and jQuery-dispatched
            // handlers are credited to the extension that really ran.
            for (const s of e.scripts) {
                const o = probe.attributeScript(s).owner;
                owners.set(o, (owners.get(o) || 0) + s.duration);
            }
            const main = [...e.scripts].sort((a, b) => b.duration - a.duration)[0];
            const attr = probe.attributeScript(main);
            owner = attr.owner;
            script = attr.kind ? freezeWhat({ ...attr, invoker: main.invoker }) : `${main.sourceFunctionName || main.invoker || ''} @ ${shortFile(main.sourceURL) || '?'}`;
        }
        top.push({ duration: felt, start: e.startTime - t0, owner, script });
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
        const hist = loadHistory();
        const cur = summarizeReport(r);
        if (hist[0]) r.compare = buildCompare(hist[0], cur);
        hist.unshift(cur);
        storeHistory(hist);
        storeLastReport(r);
        renderHistoryInfo();
        lastReport = r;
        setLastButtons();
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
    skip: r => (r.scope === 'dom' ? '반응 코드 건너뛰기' : '이벤트 핸들러 건너뛰기'),
    debounce: r => `멈춘 뒤 ${r.interval}ms에 한 번만 실행`,
};
function ruleTarget(r) {
    if (r.scope === 'event') return `이벤트 ${r.event}`;
    if (r.scope === 'dom') return `${eventKo(r.type)} 반응 ${r.target === '*' ? '(전체)' : r.target}`;
    return `감시 대상 ${r.target}`;
}
const ruleLabel = r => `${ownerLabel(r.owner)} — ${ruleTarget(r)}: ${KIND_LABEL[r.kind]?.(r) || r.kind}`;
const newId = () => `hf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function persistRules() {
    settings().hotfixes = probe.rules.filter(r => r.persist).map(({ id, scope, kind, owner, target, event, type, interval, partners }) => ({ id, scope, kind, owner, target, event, type, interval, partners, persist: true }));
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

const KEY_TYPES = new Set(['keydown', 'keyup', 'keypress']);

/** Hotfix for an extension's input/scroll/mouse handler (from a freeze alert or the report). */
async function offerDomHotfix({ owner, type, target }) {
    const recs = findDomRecsFor(owner, type, target);
    if (!recs.length) { toastr.warning('보정할 반응 코드를 찾지 못했어요. 이 확장이 직접 단 코드가 아니거나(HTML 속성 등) 이미 사라졌을 수 있어요.'); return; }
    await ensureNames([owner]);
    const isKey = KEY_TYPES.has(type);
    const s = settings();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const el = document.createElement('div');
    el.className = 'xdoc-fix';
    el.innerHTML = `
      <h3>임시 보정 적용하시겠습니까?</h3>
      <p><b>${esc(ownerLabel(owner))}</b>가 <b>${esc(eventKo(type))}</b>에 반응하는 코드가 무거워요.</p>
      <div class="xdoc-muted">대상:</div>
      <ul>${recs.map(r => `<li><code>${esc(r.target)}</code> — ${fmtN(r.calls)}회 실행, 총 ${fmtMs(r.totalMs)}, 최대 ${fmtMs(r.maxMs)}</li>`).join('')}</ul>
      ${isKey ? '' : `<label class="radio_label"><input type="radio" name="xdoc_fix_kind" value="debounce" checked> <b>멈춘 뒤 한 번만 실행</b> (권장)</label>
      <div class="xdoc-desc">${esc(eventKo(type))}이(가) 이어지는 동안은 실행하지 않고, 멈추고 <input type="number" class="text_pole xdoc-num" id="xdoc_fix_interval" min="50" max="3000" value="${s.debounceMs}">ms 뒤에 마지막 것으로 한 번만 실행해요.
        예: 글자 칠 때마다 무거운 계산을 하던 확장이, 타자를 멈췄을 때 한 번만 계산해요. 부작용: 그 확장의 반응(미리보기, 자동 높이 조절 등)이 그만큼 늦게 따라와요.</div>`}
      <label class="radio_label"><input type="radio" name="xdoc_fix_kind" value="skip" ${isKey ? 'checked' : ''}> <b>반응 코드 건너뛰기</b></label>
      <div class="xdoc-desc xdoc-warn">⚠️ 그 확장이 ${esc(eventKo(type))}에 반응하는 기능이 멈춰요.${isKey ? ' 키 입력 반응은 엔터로 보내기 같은 기능일 수 있어서, 멈춘 뒤 실행 방식은 쓸 수 없어요.' : ''}</div>
      <div class="xdoc-row">적용 범위:
        <label class="radio_label"><input type="radio" name="xdoc_fix_scope" value="once" checked> 이번만 (새로고침하면 해제)</label>
        <label class="radio_label"><input type="radio" name="xdoc_fix_scope" value="persist"> 기억하기 (다음에도 적용)</label></div>
      <div class="xdoc-muted">다른 확장의 파일은 건드리지 않아요. 설정 패널의 "적용 중인 보정"에서 언제든 해제할 수 있어요.</div>`;
    const res = await new Popup(el, POPUP_TYPE.CONFIRM, '', { okButton: '적용', cancelButton: '취소', wide: true, allowVerticalScrolling: true }).show();
    if (res !== POPUP_RESULT.AFFIRMATIVE) return;
    const kind = el.querySelector('input[name="xdoc_fix_kind"]:checked')?.value || (isKey ? 'skip' : 'debounce');
    const persist = el.querySelector('input[name="xdoc_fix_scope"]:checked')?.value === 'persist';
    const interval = clamp(Number(el.querySelector('#xdoc_fix_interval')?.value) || 300, 50, 3000);
    let n = 0;
    for (const r of recs) {
        if (probe.rules.some(x => x.scope === 'dom' && x.owner === owner && x.type === type && x.target === r.target)) continue;
        probe.addRule({ id: newId(), scope: 'dom', kind, owner, type, target: r.target, interval, persist });
        n++;
    }
    if (kind === 'debounce') s.debounceMs = interval;
    persistRules();
    toastr.success(`보정 ${n}개를 적용했어요.${persist ? ' (기억됨)' : ' (새로고침하면 해제)'}`);
}

async function renderHotfixList() {
    const box = document.getElementById('xdoc_hotfix_list');
    if (!box || !probe) return;
    const rules = probe.rules;
    await ensureNames(rules.map(r => r.owner).concat(rules.flatMap(r => r.partners || [])));
    const ids = new Set(rules.map(r => r.id));
    for (const id of hfSel) if (!ids.has(id)) hfSel.delete(id);
    if (!rules.length) { box.innerHTML = '<div class="xdoc-muted">적용 중인 보정이 없어요.</div>'; return; }
    // Keep the list's scroll position across re-renders (removals, persist changes).
    // Anchor on the first visible row rather than raw pixels: row heights can change on re-render.
    let anchor = null;
    const oldList = box.querySelector('.xdoc-hf-list');
    if (oldList && oldList.scrollTop > 0) {
        const rows = [...oldList.querySelectorAll('.xdoc-hf')];
        const i = rows.findIndex(el => el.offsetTop + el.offsetHeight > oldList.scrollTop);
        if (i >= 0) anchor = { i, id: rows[i].querySelector('[data-hf]')?.dataset.hf, delta: oldList.scrollTop - rows[i].offsetTop };
    }
    box.innerHTML = `<div class="xdoc-hf-bar">
        <span class="xdoc-muted">총 ${rules.length}개 (기억됨 ${rules.filter(r => r.persist).length}) · 선택 <b class="xdoc-hf-n">0</b>개</span>
        <button type="button" class="menu_button xdoc-small" data-hfbulk="all">전체 선택</button>
        <button type="button" class="menu_button xdoc-small" data-hfbulk="none">선택 비우기</button>
        <button type="button" class="menu_button xdoc-small" data-hfbulk="between" title="체크한 것 중 맨 위와 맨 아래 사이를 모두 선택해요">사이 모두 선택</button>
      </div>
      <div class="xdoc-hf-bar">
        <span class="xdoc-muted">선택한 것을:</span>
        <button type="button" class="menu_button xdoc-small" data-hfbulk="persistSel" data-needsel title="새로고침해도 계속 적용돼요">기억하기로</button>
        <button type="button" class="menu_button xdoc-small" data-hfbulk="onceSel" data-needsel title="새로고침하면 해제돼요">이번만으로</button>
        <button type="button" class="menu_button xdoc-small" data-hfbulk="removeSel" data-needsel>해제</button>
        <button type="button" class="menu_button xdoc-small xdoc-danger" data-hfbulk="removeAll">전체 해제</button>
      </div>
      <small class="xdoc-muted">범위 선택: 시작과 끝을 체크하고 "사이 모두 선택"을 누르거나, PC에서는 Shift를 누른 채 끝을 클릭하세요. 줄의 (기억됨)/(이번만)을 누르면 서로 바뀌어요.</small>
      <div class="xdoc-hf-list">${rules.map((r, i) => `<div class="xdoc-hf">
        <label class="xdoc-hf-check"><input type="checkbox" data-hfsel="${esc(r.id)}" data-idx="${i}">
        <span class="xdoc-hf-no">${i + 1}.</span> <span>${esc(ruleLabel(r))}</span></label>
        <button type="button" class="xdoc-hf-persist ${r.persist ? 'on' : ''}" data-hfpersist="${esc(r.id)}" title="눌러서 ${r.persist ? '이번만으로' : '기억하기로'} 바꾸기">${r.persist ? '기억됨' : '이번만'}</button>
        <button type="button" class="menu_button xdoc-small" data-hf="${esc(r.id)}">해제</button></div>`).join('')}</div>`;
    const list = box.querySelector('.xdoc-hf-list');
    if (list && anchor) {
        const rows = [...list.querySelectorAll('.xdoc-hf')];
        const row = rows.find(el => el.querySelector('[data-hf]')?.dataset.hf === anchor.id) || rows[Math.min(anchor.i, rows.length - 1)];
        if (row) list.scrollTop = row.offsetTop + anchor.delta;
    }
    syncHfSel();
}

/** Reflect the selection set in the existing DOM without re-rendering (keeps scroll position). */
function syncHfSel() {
    const box = document.getElementById('xdoc_hotfix_list');
    if (!box) return;
    box.querySelectorAll('input[data-hfsel]').forEach(cb => { cb.checked = hfSel.has(cb.dataset.hfsel); });
    const n = hfSel.size;
    const nEl = box.querySelector('.xdoc-hf-n');
    if (nEl) nEl.textContent = String(n);
    box.querySelectorAll('[data-needsel]').forEach(b => { b.disabled = !n; });
    const rm = box.querySelector('[data-hfbulk="removeSel"]');
    if (rm) rm.textContent = n ? `${n}개 해제` : '해제';
}

/** Switch rules between "this session only" and "remembered". */
function setRulesPersist(idList, persist) {
    const ids = new Set(idList);
    let n = 0;
    probe.setRules(probe.rules.map(r => {
        if (!ids.has(r.id) || !!r.persist === persist) return r;
        n++;
        return { ...r, persist };
    }));
    persistRules();
    return n;
}

const hfSel = new Set();
let hfLastIdx = -1;

async function removeRulesBulk(idList, what) {
    if (!idList.length) return;
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const res = await new Popup(`<p>${esc(what)} 보정 <b>${idList.length}개</b>를 해제할까요?</p><small class="xdoc-muted">해제하면 그 확장은 원래대로 동작해요. 다시 필요하면 진단에서 다시 적용할 수 있어요.</small>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '해제', cancelButton: '취소' }).show();
    if (res !== POPUP_RESULT.AFFIRMATIVE) return;
    const drop = new Set(idList);
    probe.setRules(probe.rules.filter(r => !drop.has(r.id)));
    for (const id of drop) hfSel.delete(id);
    hfLastIdx = -1;
    persistRules();
    toastr.info(`보정 ${drop.size}개를 해제했어요.`);
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
    (r.domHandlers || []).filter(d => d.dMs >= 50).slice(0, 3).forEach(d => focus.add(d.owner));
    const loopIds = new Set(r.loops.flatMap(l => l.observerIds));
    const snap = probe.snapshot();

    const out = [];
    for (const owner of [...focus].slice(0, 6)) {
        const sites = [];
        snap.observers.filter(o => o.owner === owner && o.site && (loopIds.has(o.id) || r.hotObservers.some(h => h.id === o.id))).forEach(o => sites.push({ ...o.site, why: `감시자 생성 (${o.targets.map(t => t.sel).join(', ')})` }));
        (r.domHandlers || []).filter(d => d.owner === owner && d.site).forEach(d => sites.unshift({ ...d.site, why: `${eventKo(d.type)} 반응 코드 등록 (${d.target}), ${fmtMs(d.dMs)}` }));
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
    const maxTokens = clamp(Number(a.maxTokens) || 16000, 256, 64000);
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
        let du;
        try { du = new URL(a.directUrl); } catch { throw new Error('API URL 형식이 올바르지 않아요. 예: https://api.example.com/v1'); }
        if (!/^https?:$/.test(du.protocol)) throw new Error('API URL은 http:// 또는 https:// 로 시작해야 해요.');
        if (du.username || du.password) throw new Error('API URL 안에 아이디·비밀번호를 넣지 마세요. 키는 키 칸에 넣어 주세요.');
        const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(du.hostname);
        if (du.protocol === 'http:' && !local && key) throw new Error('키를 암호화 없이(http://) 외부 주소로 보낼 수 없어요. https:// 주소를 써 주세요.');
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
    // The AI saw third-party extension code, which may carry prompt-injection text. Anything that loads a remote
    // resource on render (images, media, CSS, frames) could leak data in its URL, so only plain text/markup is kept.
    const html = DOMPurify.sanitize(conv.makeHtml(md), {
        FORBID_TAGS: ['style', 'link', 'meta', 'base', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select',
            'img', 'picture', 'source', 'video', 'audio', 'track', 'svg', 'math', 'image'],
        FORBID_ATTR: ['style', 'srcset', 'src', 'background', 'poster', 'action', 'formaction', 'ping', 'id', 'name'],
    });
    const wrap = document.createElement('div');
    wrap.className = 'xdoc-ai-md';
    wrap.innerHTML = html;
    // Links: http(s) only, always in a new tab without access back to this page.
    wrap.querySelectorAll('a').forEach(a => {
        let ok = false;
        try { ok = /^https?:$/.test(new URL(a.getAttribute('href') || '', location.href).protocol) && !!a.getAttribute('href'); } catch { ok = false; }
        if (!ok) { a.replaceWith(document.createTextNode(a.textContent || '')); return; }
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        a.referrerPolicy = 'no-referrer';
    });
    wrap.querySelectorAll('pre').forEach(pre => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu_button xdoc-copy-code';
        btn.innerHTML = '<i class="fa-solid fa-copy"></i> 복사';
        btn.addEventListener('click', () => copyText(pre.querySelector('code')?.textContent ?? pre.textContent, btn));
        pre.before(btn);
    });
    return wrap;
}

let aiRunning = null; // AbortController of the analysis in progress
let aiLive = null; // { view, open } — the progress view of the running analysis; it keeps running when the popup is closed
let lastAi = null; // { text, dest, report } — kept for this page session so a closed result can be reopened

/** Show the progress/result view of the running analysis in a popup (again). Closing it never stops the analysis. */
function openLiveAi() {
    if (!aiLive) return;
    const { Popup, POPUP_TYPE } = ctx();
    aiLive.open = true;
    new Popup(aiLive.view, POPUP_TYPE.TEXT, '', {
        wide: true, large: true, allowVerticalScrolling: true, okButton: '닫기',
        onClose: () => {
            if (!aiLive) return;
            aiLive.open = false;
            if (aiRunning) toastr.info('창을 닫아도 AI 분석은 계속돼요. 끝나면 알림으로 알려드릴게요.', 'Extension Doctor', { timeOut: 4000 });
        },
    }).show();
}

/** Heuristic: thinking models spend output tokens on reasoning, so answers often stop mid-sentence. */
function looksTruncated(text) {
    const t = String(text).trimEnd();
    if (((t.match(/```/g) || []).length % 2) === 1) return true;
    if ((t.match(/\*\*/g) || []).length % 2 === 1) return true;
    const last = t.slice(-1);
    return !/[.!?…)\]}"'`」』*:>~요다음함됨임니죠세]/.test(last);
}

function fillAiView(view, ai) {
    const truncated = looksTruncated(ai.text);
    view.querySelector('.xdoc-ai-status').innerHTML = `<b>AI 분석 결과</b> <span class="xdoc-muted">${esc(ai.dest)}</span>
        <button type="button" class="menu_button xdoc-small" data-xdoc="copyall"><i class="fa-solid fa-copy"></i> 전체 복사</button>
        <button type="button" class="menu_button xdoc-small" data-xdoc="again"><i class="fa-solid fa-rotate"></i> 다른 API로 다시 분석</button>
        ${truncated ? `<div class="xdoc-alert">⚠️ 응답이 중간에 끊긴 것 같아요. [다른 API로 다시 분석]에서 <b>응답 최대 토큰</b>을 늘려 다시 보내 보세요. (생각하는 모델은 생각하는 데도 토큰을 써서 답이 잘리기 쉬워요. 지금 설정: ${fmtN(settings().ai.maxTokens)})</div>` : ''}`;
    const copyBtn = view.querySelector('[data-xdoc="copyall"]');
    copyBtn.addEventListener('click', () => copyText(ai.text, copyBtn));
    view.querySelector('[data-xdoc="again"]').addEventListener('click', () => runAiAnalysis(ai.report));
    view.querySelector('.xdoc-ai-body').replaceChildren(renderMarkdown(ai.text));
}

function showLastAi() {
    if (aiRunning && aiLive) { if (!aiLive.open) openLiveAi(); return; }
    if (!lastAi) { toastr.info('아직 AI 분석 결과가 없어요.'); return; }
    const { Popup, POPUP_TYPE } = ctx();
    const view = document.createElement('div');
    view.className = 'xdoc-ai';
    view.innerHTML = '<div class="xdoc-ai-status"></div><div class="xdoc-ai-body"></div>';
    fillAiView(view, lastAi);
    new Popup(view, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '닫기' }).show();
}

function setLastButtons() {
    $('#xdoc_last_report').prop('disabled', !lastReport).toggleClass('disabled', !lastReport);
    const canAi = !!lastAi || !!aiRunning;
    $('#xdoc_last_ai').prop('disabled', !canAi).toggleClass('disabled', !canAi)
        .html(aiRunning ? '<i class="fa-solid fa-spinner fa-spin"></i> AI 분석 진행 중 (보기)' : '<i class="fa-solid fa-robot"></i> 마지막 AI 결과 보기');
}

/** "Where to send" picker shown inside the AI confirm popup, so the API can be changed without leaving the report. */
function destinationPickerHtml() {
    const a = settings().ai;
    let profiles = [];
    try { profiles = ctx().ConnectionManagerRequestService.getSupportedProfiles(); } catch { /* connection manager off */ }
    const opts = [`<option value="current">현재 채팅 연결 (${esc(ctx().mainApi)})</option>`]
        .concat(profiles.map(p => `<option value="profile:${esc(p.id)}">연결 프로필: ${esc(p.name)}${p.model ? ` (${esc(p.model)})` : ''}</option>`))
        .concat(`<option value="direct">직접 입력: ${esc(a.directUrl || '(설정 패널에서 URL 입력 필요)')}${a.directModel ? ` / ${esc(a.directModel)}` : ''}</option>`);
    return `<div class="xdoc-dest">
        <label>보낼 곳 <select class="text_pole" data-dest="sel">${opts.join('')}</select></label>
        <label data-dest="modelrow">모델 덮어쓰기 (비우면 프로필의 모델)
          <input type="text" class="text_pole" data-dest="model" value="${esc(a.profileModel)}" placeholder="예: gemini-2.5-pro"></label>
        <label>응답 최대 토큰 <input type="number" class="text_pole" data-dest="tokens" min="256" max="64000" value="${esc(a.maxTokens)}"></label>
      </div>`;
}

function bindDestinationPicker(el) {
    const a = settings().ai;
    const sel = el.querySelector('[data-dest="sel"]');
    const wanted = a.mode === 'profile' ? `profile:${a.profileId}` : a.mode;
    sel.value = [...sel.options].some(o => o.value === wanted) ? wanted : 'current';
    const sync = () => { el.querySelector('[data-dest="modelrow"]').style.display = sel.value.startsWith('profile:') ? '' : 'none'; };
    sel.addEventListener('change', sync);
    sync();
}

function applyDestinationPicker(el) {
    const s = settings();
    const v = el.querySelector('[data-dest="sel"]').value;
    if (v.startsWith('profile:')) { s.ai.mode = 'profile'; s.ai.profileId = v.slice(8); s.ai.profileModel = el.querySelector('[data-dest="model"]').value.trim(); }
    else s.ai.mode = v;
    s.ai.maxTokens = clamp(Number(el.querySelector('[data-dest="tokens"]').value) || 16000, 256, 64000);
    save();
    // keep the settings panel in sync
    $(`input[name="xdoc_ai_mode"][value="${s.ai.mode}"]`).prop('checked', true);
    $('#xdoc_profile_model').val(s.ai.profileModel);
    $('#xdoc_max_tokens').val(s.ai.maxTokens);
    showAiMode();
    $('#xdoc_profile').val(s.ai.profileId);
}

async function runAiAnalysis(r) {
    if (aiRunning) { toastr.warning('AI 분석이 이미 진행 중이에요.'); if (aiLive && !aiLive.open) openLiveAi(); return; }
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    let code;
    try { code = await collectCode(r); } catch (e) { code = []; console.error(e); }
    const summary = reportToText(r).slice(0, 9000);
    const codeText = code.map(c => `### ${ownerLabel(c.owner)}\n` + c.parts.map(p => `파일 ${p.file} (줄 ${p.from}–${p.to}) — ${p.why}\n\`\`\`js\n${p.code}\n\`\`\``).join('\n')).join('\n\n');
    // Secrets (keys/tokens in error messages or hard-coded in extension code) never leave the browser.
    const user = redactSecrets(`# 진단 리포트\n${summary}\n\n# 지목된 코드 발췌 (확장당 최대 150줄)\n${codeText || '(발췌 없음)'}`);
    const approxTokens = Math.round((AI_SYSTEM.length + user.length) / 3);

    const confirmEl = document.createElement('div');
    confirmEl.className = 'xdoc-fix';
    confirmEl.innerHTML = `<h3>AI 분석 — 보낼 내용 확인</h3>
      ${destinationPickerHtml()}
      <ul><li>진단 리포트 요약 (텍스트 ${fmtN(summary.length)}자)</li>
      ${code.map(c => `<li>${esc(ownerLabel(c.owner))} — 코드 ${c.lines}줄 (${esc(c.parts.map(p => `${p.file}:${p.from}-${p.to}`).join(', '))})</li>`).join('') || '<li>코드 발췌 없음</li>'}</ul>
      <p>대략 <b>${fmtN(approxTokens)} 토큰</b>을 보내요. 전체 파일은 보내지 않아요.</p>
      <div class="xdoc-muted">현재 채팅 연결이나 연결 프로필을 쓰면 그 API의 요금이 들어요.</div>`;
    bindDestinationPicker(confirmEl);
    const ok = await new Popup(confirmEl, POPUP_TYPE.CONFIRM, '', { okButton: '보내기', cancelButton: '취소', wide: true, allowVerticalScrolling: true }).show();
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    applyDestinationPicker(confirmEl);

    const controller = new AbortController();
    const a = settings().ai;
    const timeoutMs = clamp(Number(a.timeoutSec) || 180, 15, 900) * 1000;
    const view = document.createElement('div');
    view.className = 'xdoc-ai';
    view.innerHTML = `<div class="xdoc-ai-status"><i class="fa-solid fa-spinner fa-spin"></i> AI 분석 중… <span class="xdoc-muted">${esc(aiDestination())}</span>
        <button type="button" class="menu_button xdoc-small" data-xdoc="stop">중지</button>
        <div class="xdoc-muted">창을 닫아도 분석은 계속돼요. 끝나면 알림이 뜨고, 설정 패널의 [AI 분석 진행 중] 버튼으로 다시 볼 수 있어요.</div></div><div class="xdoc-ai-body"></div>`;
    const stop = (why) => {
        if (controller.signal.aborted) return;
        controller.abort(why);
        if (a.mode === 'current') { try { ctx().stopGeneration(); } catch { /* ignore */ } }
    };
    view.querySelector('[data-xdoc="stop"]').addEventListener('click', () => stop('user'));
    aiRunning = controller;
    aiLive = { view, open: false };
    setLastButtons();
    openLiveAi();
    const timer = T.setTimeout.call(window, () => stop('timeout'), timeoutMs);
    try {
        const text = await Promise.race([
            callAi(AI_SYSTEM, user, controller.signal),
            new Promise((_, rej) => controller.signal.addEventListener('abort', () => rej(new DOMException(String(controller.signal.reason || 'aborted'), 'AbortError')), { once: true })),
        ]);
        if (!text || !String(text).trim()) throw new Error('빈 응답을 받았어요.');
        lastAi = { text: String(text), dest: aiDestination(), report: r };
        fillAiView(view, lastAi);
        if (!aiLive?.open) {
            toastr.success('AI 분석이 끝났어요. 여기를 눌러 결과를 보세요.', 'Extension Doctor', {
                timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: true, onclick: () => showLastAi(),
            });
        }
    } catch (e) {
        const reason = controller.signal.reason;
        const msg = reason === 'timeout' ? `시간 초과 (${timeoutMs / 1000}초)` : reason === 'user' ? '중지했어요.' : redactSecrets(e?.cause?.message || e?.message || String(e));
        view.querySelector('.xdoc-ai-status').innerHTML = `<span class="xdoc-bad">AI 분석 실패: ${esc(msg)}</span>`;
        if (reason !== 'user') toastr.error(`AI 분석 실패: ${msg}`, 'Extension Doctor');
        console.error('[ExtensionDoctor] AI', e);
    } finally {
        T.clearTimeout.call(window, timer);
        aiRunning = null;
        aiLive = null;
        setLastButtons();
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
    $('#xdoc_freeze').prop('checked', s.freezeAlert);
    $('#xdoc_toastsrc').prop('checked', s.toastSource);
    $('#xdoc_freeze_sec').val((s.freezeMs / 1000).toFixed(1));
    if (!lastReport) lastReport = loadLastReport();
    renderHistoryInfo();
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
    setLastButtons();

    $root.on('click', '#xdoc_start', () => (diag ? finishDiagnosis(true) : startDiagnosis()));
    $root.on('click', '#xdoc_quick', () => showQuickReport(lastAlerts[0] || null));
    $root.on('click', '#xdoc_last_report', () => { if (lastReport) showReport(lastReport); else toastr.info('아직 진단 리포트가 없어요. [진단 시작]을 먼저 눌러 주세요.'); });
    $root.on('click', '#xdoc_last_ai', showLastAi);
    $root.on('input', '#xdoc_duration', function () { s.duration = Number(this.value); $('#xdoc_duration_val').text(`${s.duration}초`); save(); });
    $root.on('change', '#xdoc_loop', function () { s.loopDetect = this.checked; probe.config.loopDetect = this.checked; save(); });
    $root.on('change', '#xdoc_threshold', function () { s.rateThreshold = clamp(Number(this.value) || 100, 5, 1000); this.value = s.rateThreshold; probe.config.rateThreshold = s.rateThreshold; save(); });
    $root.on('change', '#xdoc_toastsrc', function () { s.toastSource = this.checked; toastSourceOn = this.checked; save(); });
    $root.on('change', '#xdoc_freeze', function () { s.freezeAlert = this.checked; probe.config.freezeAlert = this.checked; save(); });
    $root.on('change', '#xdoc_freeze_sec', function () {
        const sec = clamp(Number(this.value) || 1, 0.3, 10);
        this.value = sec.toFixed(1);
        s.freezeMs = Math.round(sec * 1000); probe.config.freezeMs = s.freezeMs; save();
    });
    $root.on('click', '#xdoc_history_clear', () => {
        try { localStorage.removeItem(HIST_KEY); localStorage.removeItem(LAST_KEY); } catch { /* blocked */ }
        renderHistoryInfo();
        toastr.info('진단 기록을 지웠어요.');
    });
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
    $root.on('change', '#xdoc_max_tokens', function () { s.ai.maxTokens = clamp(Number(this.value) || 16000, 256, 64000); this.value = s.ai.maxTokens; save(); });
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
        hfSel.delete(this.dataset.hf);
        persistRules();
        toastr.info('보정을 해제했어요.');
    });
    $root.on('click', 'input[data-hfsel]', function (ev) {
        const idx = Number(this.dataset.idx);
        const rules = probe.rules;
        if (ev.shiftKey && hfLastIdx >= 0 && hfLastIdx !== idx) {
            const [a, b] = idx < hfLastIdx ? [idx, hfLastIdx] : [hfLastIdx, idx];
            for (let i = a; i <= b; i++) if (rules[i]) { if (this.checked) hfSel.add(rules[i].id); else hfSel.delete(rules[i].id); }
        } else if (this.checked) hfSel.add(this.dataset.hfsel);
        else hfSel.delete(this.dataset.hfsel);
        hfLastIdx = idx;
        syncHfSel();
    });
    $root.on('click', 'button[data-hfpersist]', function () {
        const r = probe.rules.find(x => x.id === this.dataset.hfpersist);
        if (!r) return;
        setRulesPersist([r.id], !r.persist);
        toastr.info(r.persist ? '이번만 적용으로 바꿨어요. (새로고침하면 해제)' : '기억하기로 바꿨어요. (새로고침해도 유지)');
    });
    $root.on('click', 'button[data-hfbulk]', function () {
        const rules = probe.rules;
        switch (this.dataset.hfbulk) {
            case 'all': rules.forEach(r => hfSel.add(r.id)); break;
            case 'none': hfSel.clear(); hfLastIdx = -1; break;
            case 'between': {
                const idx = rules.map((r, i) => (hfSel.has(r.id) ? i : -1)).filter(i => i >= 0);
                if (idx.length < 2) { toastr.info('시작과 끝, 두 개 이상을 먼저 체크해 주세요.'); return; }
                for (let i = idx[0]; i <= idx[idx.length - 1]; i++) hfSel.add(rules[i].id);
                break;
            }
            case 'removeSel': removeRulesBulk(rules.filter(r => hfSel.has(r.id)).map(r => r.id), '선택한'); return;
            case 'removeAll': removeRulesBulk(rules.map(r => r.id), '전체'); return;
            case 'persistSel':
            case 'onceSel': {
                const toPersist = this.dataset.hfbulk === 'persistSel';
                const n = setRulesPersist([...hfSel], toPersist);
                toastr.info(n ? `보정 ${n}개를 ${toPersist ? '기억하기로' : '이번만으로'} 바꿨어요.` : `선택한 보정은 이미 모두 ${toPersist ? '기억됨' : '이번만'}이에요.`);
                return;
            }
        }
        syncHfSel();
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
        probe.config.freezeAlert = s.freezeAlert;
        probe.config.freezeMs = s.freezeMs;
        toastSourceOn = s.toastSource !== false;
        patchToasts();
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
