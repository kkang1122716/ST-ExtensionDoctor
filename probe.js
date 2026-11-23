// Extension Doctor — instrumentation probe.
// Imported first by index.js; with loading_order -1000 it runs before any other extension
// (ST activates extensions one by one, awaiting each script — see public/scripts/extensions.js activateExtensions).
// Design rules:
//   * Normal-time overhead: counters + tiny per-second ring buffers only. Stack parsing only when an owner is unknown.
//   * Never change behaviour of wrapped APIs unless a user-approved hotfix rule matches.
//   * Doctor's own timers/observers use the original functions (probe.orig) and are never recorded.

const SELF_FOLDER = (() => {
    const m = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/third-party\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]) : 'ST-ExtensionDoctor';
})();
const SELF = `third-party/${SELF_FOLDER}`;
const CORE = 'core';
const UNKNOWN = 'unknown';

function install() {
    const orig = {
        MutationObserver: window.MutationObserver,
        setTimeout: window.setTimeout,
        clearTimeout: window.clearTimeout,
        setInterval: window.setInterval,
        clearInterval: window.clearInterval,
        requestAnimationFrame: window.requestAnimationFrame,
        appendChild: Node.prototype.appendChild,
        insertBefore: Node.prototype.insertBefore,
        append: Element.prototype.append,
        prepend: Element.prototype.prepend,
        insertAdjacentHTML: Element.prototype.insertAdjacentHTML,
        insertAdjacentElement: Element.prototype.insertAdjacentElement,
        fetch: window.fetch,
    };
    const now = () => performance.now();

    // ---------------------------------------------------------------- owner resolution

    const RE_THIRD = /\/scripts\/extensions\/third-party\/([^/?#:]+)\/([^?#:\s)]+)/;
    const RE_SYS = /\/scripts\/extensions\/([^/?#:]+)\/([^?#:\s)]+)/;
    const RE_LOC = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/;

    /** Parse one URL into an owner key, or null when it is not extension code. */
    function ownerFromUrl(url) {
        if (!url) return null;
        let m = url.match(RE_THIRD);
        if (m) return `third-party/${decodeURIComponent(m[1])}`;
        m = url.match(RE_SYS);
        if (m && m[1] !== 'third-party') return m[1];
        return null;
    }

    /**
     * Walks the current stack and returns { owner, site } where site = { url, line, col } of the first
     * extension frame. probe.js frames are skipped. If Doctor's own code is the first extension frame → SELF.
     */
    // V8 (Chrome/Edge): read structured CallSites instead of formatting the whole stack string (~5x cheaper).
    const hasCallSites = typeof Error.captureStackTrace === 'function';
    const toCallSites = (_e, frames) => frames;
    function resolveSiteFast() {
        const prevPrep = Error.prepareStackTrace; const prevLimit = Error.stackTraceLimit;
        Error.prepareStackTrace = toCallSites; Error.stackTraceLimit = 30;
        const holder = {};
        Error.captureStackTrace(holder, resolveSiteFast);
        const frames = holder.stack;
        Error.prepareStackTrace = prevPrep; Error.stackTraceLimit = prevLimit;
        if (!Array.isArray(frames)) return null;
        let sawOrigin = false;
        for (const f of frames) {
            const url = f.getFileName?.() || f.getScriptNameOrSourceURL?.();
            if (!url) continue;
            if (url.endsWith('/probe.js') && url.includes(`/${SELF_FOLDER}/`)) continue;
            sawOrigin = sawOrigin || url.startsWith(location.origin);
            const owner = ownerFromUrl(url);
            if (owner) return { owner, site: { url, line: f.getLineNumber?.() || 0, col: f.getColumnNumber?.() || 0 } };
        }
        return { owner: sawOrigin ? CORE : UNKNOWN, site: null };
    }

    function resolveSite() {
        if (hasCallSites) {
            try { const r = resolveSiteFast(); if (r) return r; } catch { /* fall back to string parsing */ }
        }
        const prev = Error.stackTraceLimit;
        Error.stackTraceLimit = 30;
        const stack = new Error().stack || '';
        Error.stackTraceLimit = prev;
        const lines = stack.split('\n');
        let sawOrigin = false;
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            const loc = line.match(RE_LOC);
            if (!loc) continue;
            const url = loc[1];
            if (url.includes('/probe.js') && url.includes(`/${SELF_FOLDER}/`)) continue;
            sawOrigin = sawOrigin || url.startsWith(location.origin);
            const owner = ownerFromUrl(url);
            if (owner) return { owner, site: { url, line: Number(loc[2]), col: Number(loc[3]) } };
        }
        return { owner: sawOrigin ? CORE : UNKNOWN, site: null };
    }

    const isExtOwner = o => o !== CORE && o !== UNKNOWN && o !== SELF && o != null;

    // ---------------------------------------------------------------- execution context

    // current: owner of the wrapped callback running right now (null outside).
    // last/lastExit: owner of the most recently finished wrapped task — MutationObserver records are delivered
    // in the microtask checkpoint right after the task that produced them, so this identifies the mutator.
    const ctx = { current: null, last: null, lastExit: 0 };

    function ownerForNewTask() {
        const c = ctx.current;
        if (isExtOwner(c)) return { owner: c, site: null };
        return resolveSite();
    }

    // ---------------------------------------------------------------- per-second rate ring

    class Rate {
        constructor() { this.s = new Int32Array(12).fill(-1); this.c = new Int32Array(12); }
        add(t) {
            const s = Math.floor(t / 1000); const i = s % 12;
            if (this.s[i] !== s) { this.s[i] = s; this.c[i] = 0; }
            this.c[i]++;
        }
        get(s) { const i = s % 12; return this.s[i] === s ? this.c[i] : 0; }
    }

    // ---------------------------------------------------------------- stores

    const owners = new Map(); // owner -> aggregate
    function ownerStat(o) {
        let s = owners.get(o);
        if (!s) {
            s = { owner: o, cbMs: 0, cbCount: 0, timeouts: 0, rafs: 0, observers: 0, intervals: 0, listeners: 0 };
            owners.set(o, s);
        }
        return s;
    }

    let seq = 0;
    const observers = []; // observer records (kept; small)
    const intervals = new Map(); // id -> record
    const events = new Map(); // `${owner}|${event}` -> record
    const edges = new Map(); // `${from}>${to}` -> { from, to, count, rate, lastAt }
    const panelOwners = new WeakMap(); // top-level child of #extensions_settings(2) -> owner
    const alertHandlers = [];
    const pendingAlerts = [];

    const config = {
        loopDetect: true, rateThreshold: 100, pingPongMin: 3, sustainSec: 3, cooldownMs: 5 * 60 * 1000,
        freezeAlert: true, freezeMs: 1500, freezeQuietMs: 20000, // no freeze toasts during the first 20s (page load)
    };

    // ---------------------------------------------------------------- hotfix rules

    let rules = [];
    let rulesVer = 0;
    function setRules(list) { rules = Array.isArray(list) ? list.slice() : []; rulesVer++; }
    function addRule(rule) { rules.push(rule); rulesVer++; }
    function removeRule(id) { rules = rules.filter(r => r.id !== id); rulesVer++; }

    function observerRules(rec) {
        if (rec.ruleVer === rulesVer) return rec.rules;
        rec.ruleVer = rulesVer;
        rec.rules = rules.filter(r => r.scope === 'observer' && r.owner === rec.owner
            && (r.target === '*' || rec.targets.some(t => t.sel === r.target)));
        return rec.rules;
    }

    function eventRule(rec) {
        if (rec.ruleVer === rulesVer) return rec.rule;
        rec.ruleVer = rulesVer;
        rec.rule = rules.find(r => r.scope === 'event' && r.kind === 'skip' && r.owner === rec.owner && r.event === rec.event) || null;
        return rec.rule;
    }

    // ---------------------------------------------------------------- generic task runner

    // MutationObserver delivery round: every observer notified in the same round sees the same mutator.
    // A round ends at a microtask queued when the round starts (it runs before the next round's microtask).
    // The longest observer callback of the round (if non-trivial) becomes the mutator for the next round,
    // which covers observers that re-render synchronously inside their own callback.
    const round = { open: false, mutator: null, best: null, bestMs: 0 };
    function closeRound() {
        round.open = false;
        if (round.best && round.bestMs >= 0.5) { ctx.last = round.best; ctx.lastExit = now(); }
        round.best = null; round.bestMs = 0;
    }

    // Slow wrapped callbacks (>=20ms). Long-frame reports name the *file* of the entry function, which for
    // wrapped callbacks is probe.js and for jQuery handlers is jquery — so frames are matched against these
    // records by time to credit the extension that actually ran.
    const longTasks = [];
    function noteLongTask(owner, t0, dt, stat) {
        longTasks.push({
            owner, t0, dt,
            kind: stat?.type ? 'dom' : stat?.event ? 'event' : stat?.delay !== undefined ? 'interval' : stat?.targets ? 'observer' : 'timer',
            type: stat?.type || null, target: stat?.type ? stat.target : null,
        });
        if (longTasks.length > 200) longTasks.shift();
    }
    function attributeScript(s) {
        if (!s) return { owner: UNKNOWN };
        const start = s.startTime; const end = start + s.duration;
        // Nested wrapped callbacks overlap (e.g. a timer that dispatches an event an extension handles):
        // prefer extension-owned work, then the longest.
        let best = null;
        const better = (a, b) => (isExtOwner(a.owner) !== isExtOwner(b.owner) ? isExtOwner(a.owner) : a.dt > b.dt);
        for (let i = longTasks.length - 1; i >= 0; i--) {
            const t = longTasks[i];
            if (t.t0 + t.dt < start - 50) break;
            if (t.t0 >= start - 2 && t.t0 <= end && t.dt >= s.duration * 0.5 && (!best || better(t, best))) best = t;
        }
        if (best) return best;
        const o = ownerFromUrl(s.sourceURL);
        if (o === SELF) return { owner: UNKNOWN }; // a wrapper ran but its callback was fast: real owner unknown
        return { owner: o || (s.sourceURL ? CORE : UNKNOWN) };
    }

    function runTask(owner, stat, fn, thisArg, args, isObserver = false) {
        const prevCur = ctx.current;
        ctx.current = owner;
        if (!isObserver) ctx.last = owner;
        const t0 = now();
        try {
            return fn.apply(thisArg, args);
        } finally {
            const t1 = now();
            const dt = t1 - t0;
            const os = ownerStat(owner); os.cbMs += dt; os.cbCount++;
            if (stat) { stat.calls++; stat.totalMs += dt; stat.lastAt = t1; if (dt > stat.maxMs) stat.maxMs = dt; }
            if (dt >= 20) noteLongTask(owner, t0, dt, stat);
            ctx.current = prevCur;
            if (isObserver) { if (dt > round.bestMs) { round.bestMs = dt; round.best = owner; } }
            else ctx.lastExit = t1;
        }
    }

    // ---------------------------------------------------------------- MutationObserver

    function describeTarget(node) {
        if (!node) return 'null';
        if (node === document) return 'document';
        if (node === document.documentElement) return 'html';
        if (node === document.body) return 'body';
        if (node.nodeType !== 1) return String(node.nodeName || node.constructor?.name || '?').toLowerCase();
        if (node.id) return `#${node.id}`;
        const cls = [...node.classList].slice(0, 2).map(c => `.${c}`).join('');
        return node.tagName.toLowerCase() + cls;
    }

    function deliver(rec, cb, records, obs, asTask = false) {
        rec.delivered += records.length;
        return runTask(rec.owner, rec, cb, obs, [records, obs], !asTask);
    }

    function flushThrottle(rec, cb, obs) {
        rec.throttleTimer = 0;
        if (!rec.buf.length) return;
        const batch = rec.buf; rec.buf = [];
        rec.lastRun = now();
        deliver(rec, cb, batch, obs, true); // runs from a timer → it is a task of its own
    }

    function onObserved(rec, cb, records, obs) {
        const t = now();
        rec.rate.add(t);
        rec.records += records.length;
        rec.lastSeen = t;

        // Causal edge: who produced these mutations?
        if (!round.open) {
            round.open = true;
            round.mutator = ctx.current || ((t - ctx.lastExit) < 16 ? ctx.last : UNKNOWN);
            queueMicrotask(closeRound);
        }
        const mutator = round.mutator;
        if (mutator && mutator !== SELF) {
            const k = `${mutator}>${rec.owner}`;
            let e = edges.get(k);
            if (!e) { e = { from: mutator, to: rec.owner, count: 0, rate: new Rate(), lastAt: 0, obs: new Set() }; edges.set(k, e); }
            e.count++; e.rate.add(t); e.lastAt = t; e.obs.add(rec.id);
        }

        const rs = observerRules(rec);
        if (rs.length) {
            if (rs.some(r => r.kind === 'pause')) { rec.skipped++; return; }
            const ign = rs.find(r => r.kind === 'ignorePartner');
            if (ign && ign.partners?.includes(mutator)) { rec.skipped++; return; }
            const thr = rs.find(r => r.kind === 'throttle');
            if (thr) {
                // Adaptive: a one-off change is delivered within `interval`; while changes keep arriving
                // back-to-back (a loop), the interval doubles up to `maxInterval` (default 2000ms).
                const base = Math.max(16, Number(thr.interval) || 200);
                const max = Math.max(base, Number(thr.maxInterval) || 2000);
                for (const r of records) rec.buf.push(r);
                if (rec.throttleTimer) { rec.throttled++; return; }
                const busy = rec.lastRun && (t - rec.lastRun) < (rec.backoff || base) * 1.5;
                rec.backoff = busy ? Math.min(max, (rec.backoff || base) * 2) : base;
                const wait = (busy ? rec.backoff : base) - (t - rec.lastRun);
                if (wait <= 0) { flushThrottle(rec, cb, obs); return; }
                rec.throttled++;
                rec.throttleTimer = orig.setTimeout.call(window, () => flushThrottle(rec, cb, obs), wait);
                return;
            }
        }
        rec.lastRun = t;
        return deliver(rec, cb, records, obs);
    }

    const REC = Symbol('doctorRec');
    const OrigMO = orig.MutationObserver;
    class DoctorMutationObserver extends OrigMO {
        constructor(callback) {
            if (typeof callback !== 'function') { super(callback); return; }
            const { owner, site } = ownerForNewTask();
            if (owner === SELF) { super(callback); return; }
            const rec = {
                id: ++seq, owner, site, targets: [], calls: 0, totalMs: 0, maxMs: 0, lastAt: 0, records: 0, delivered: 0,
                skipped: 0, throttled: 0, rate: new Rate(), buf: [], throttleTimer: 0, lastRun: 0, ruleVer: -1, rules: [],
                createdAt: now(), connected: false,
            };
            let selfRef = null;
            super((records, obs) => onObserved(rec, callback, records, obs || selfRef));
            selfRef = this;
            this[REC] = rec;
            observers.push(rec);
            ownerStat(owner).observers++;
        }
        observe(target, options) {
            const rec = this[REC];
            if (rec) {
                try {
                    const sel = describeTarget(target);
                    const subtree = !!options?.subtree;
                    const ref = target && typeof target === 'object' ? new WeakRef(target) : null;
                    let t = rec.targets.find(x => x.sel === sel);
                    if (!t) { t = { sel, subtree, ref }; rec.targets.push(t); rec.ruleVer = -1; }
                    else { t.subtree = t.subtree || subtree; t.ref = ref; }
                    t.attributes = !!(options?.attributes || options?.attributeFilter);
                    t.childList = !!options?.childList;
                    rec.connected = true;
                } catch { /* bookkeeping only; the real observe() below decides success or error */ }
            }
            return super.observe(target, options);
        }
        disconnect() {
            const rec = this[REC];
            if (rec) {
                rec.connected = false; rec.buf = [];
                if (rec.throttleTimer) { orig.clearTimeout.call(window, rec.throttleTimer); rec.throttleTimer = 0; }
            }
            return super.disconnect();
        }
        takeRecords() {
            const own = super.takeRecords();
            const rec = this[REC];
            if (rec && rec.buf.length) { const b = rec.buf; rec.buf = []; return b.concat(own); }
            return own;
        }
    }
    Object.defineProperty(DoctorMutationObserver, 'name', { value: 'MutationObserver' });

    // ---------------------------------------------------------------- timers

    function wrappedSetTimeout(fn, delay, ...args) {
        if (typeof fn !== 'function') return orig.setTimeout.apply(window, arguments);
        const { owner } = ownerForNewTask();
        if (owner === SELF) return orig.setTimeout.apply(window, arguments);
        ownerStat(owner).timeouts++;
        return orig.setTimeout.call(window, function () { return runTask(owner, null, fn, this, args); }, delay);
    }

    function wrappedRaf(fn) {
        if (typeof fn !== 'function') return orig.requestAnimationFrame.call(window, fn);
        const { owner } = ownerForNewTask();
        if (owner === SELF) return orig.requestAnimationFrame.call(window, fn);
        ownerStat(owner).rafs++;
        return orig.requestAnimationFrame.call(window, function (ts) { return runTask(owner, null, fn, this, [ts]); });
    }

    function wrappedSetInterval(fn, delay, ...args) {
        if (typeof fn !== 'function') return orig.setInterval.apply(window, arguments);
        const { owner, site } = ownerForNewTask();
        if (owner === SELF) return orig.setInterval.apply(window, arguments);
        const rec = { id: ++seq, owner, site, delay: Number(delay) || 0, calls: 0, totalMs: 0, maxMs: 0, lastAt: 0, createdAt: now() };
        const id = orig.setInterval.call(window, function () { return runTask(owner, rec, fn, this, args); }, delay);
        rec.timerId = id;
        intervals.set(id, rec);
        ownerStat(owner).intervals++;
        return id;
    }

    function wrappedClearInterval(id) {
        const rec = intervals.get(id);
        if (rec) { intervals.delete(id); ownerStat(rec.owner).intervals--; }
        return orig.clearInterval.call(window, id);
    }

    // ---------------------------------------------------------------- settings-panel DOM attribution

    // Built-in extensions append into placeholder containers that already exist in index.html
    // (e.g. <div id="sd_container" class="extension_container">), third-party ones append to the panel itself.
    let panelA = null; let panelB = null;
    const placeholders = new WeakSet();
    function panels() {
        if (!panelA) panelA = document.getElementById('extensions_settings');
        if (!panelB) panelB = document.getElementById('extensions_settings2');
        for (const p of [panelA, panelB]) if (p) for (const child of p.children) placeholders.add(child);
    }
    function tagPanelChildren(parent, owner) {
        for (const child of parent.children) {
            if (!panelOwners.has(child) && !placeholders.has(child)) panelOwners.set(child, owner);
        }
    }
    function insertOwner() {
        const c = ctx.current;
        return isExtOwner(c) ? c : resolveSite().owner;
    }
    function wrapInsert(proto, name) {
        const fn = proto[name];
        proto[name] = function () {
            if (this !== panelA && this !== panelB) {
                if (!placeholders.has(this)) return fn.apply(this, arguments);
                const result = fn.apply(this, arguments);
                try {
                    const prev = panelOwners.get(this);
                    if (!prev || !isExtOwner(prev)) { const o = insertOwner(); if (o !== CORE && o !== UNKNOWN) panelOwners.set(this, o); }
                } catch { /* attribution only */ }
                return result;
            }
            const result = fn.apply(this, arguments);
            try { tagPanelChildren(this, insertOwner()); } catch { /* attribution only */ }
            return result;
        };
    }

    // ---------------------------------------------------------------- eventSource

    let eventsWrapped = false;
    function wrapEventSource() {
        if (eventsWrapped) return true;
        const es = globalThis.SillyTavern?.getContext?.()?.eventSource;
        if (!es || typeof es.on !== 'function') return false;
        eventsWrapped = true;

        const origOn = es.on; const origFirst = es.makeFirst; const origLast = es.makeLast; const origRemove = es.removeListener;
        const wrappers = new WeakMap(); // listener -> Map(event -> wrapper)

        function wrapperFor(event, listener, create) {
            let m = wrappers.get(listener);
            let w = m?.get(event);
            if (w || !create) return w;
            const { owner, site } = resolveSite();
            if (owner === SELF) return listener;
            const key = `${owner}|${event}`;
            let rec = events.get(key);
            if (!rec) {
                rec = { owner, event: String(event), site, count: 0, calls: 0, totalMs: 0, maxMs: 0, lastAt: 0, skipped: 0, ruleVer: -1, rule: null };
                events.set(key, rec);
            }
            rec.count++;
            ownerStat(owner).listeners++;
            w = function () {
                const r = eventRule(rec);
                if (r) { rec.skipped++; return undefined; }
                return runTask(owner, rec, listener, this, arguments);
            };
            w.__doctorOriginal = listener;
            w.__doctorRec = rec;
            if (!m) { m = new Map(); wrappers.set(listener, m); }
            m.set(event, w);
            return w;
        }

        es.on = function (event, listener) {
            if (typeof listener !== 'function' || event === undefined) return origOn.apply(this, arguments);
            return origOn.call(this, event, wrapperFor(event, listener, true));
        };
        es.makeFirst = function (event, listener) {
            if (typeof listener !== 'function') return origFirst.apply(this, arguments);
            return origFirst.call(this, event, wrapperFor(event, listener, true));
        };
        es.makeLast = function (event, listener) {
            if (typeof listener !== 'function') return origLast.apply(this, arguments);
            return origLast.call(this, event, wrapperFor(event, listener, true));
        };
        es.removeListener = function (event, listener) {
            // Translate original listener -> our wrapper, otherwise other extensions could never unsubscribe.
            const w = typeof listener === 'function' ? wrapperFor(event, listener, false) : null;
            if (w && w.__doctorRec) {
                const list = this.events?.[event];
                if (Array.isArray(list) && list.includes(w)) w.__doctorRec.count = Math.max(0, w.__doctorRec.count - 1);
            }
            return origRemove.call(this, event, w || listener);
        };
        // `once` in ST's EventEmitter calls this.on(...) internally, so it is covered by the patched `on`.
        return true;
    }

    // ---------------------------------------------------------------- DOM event listeners (high-frequency types only)
    // Only listeners registered by extensions for event types that fire in bursts are wrapped. Everything else
    // (clicks, ST core listeners, listener objects) passes straight through, so normal-time cost stays near zero.

    const HOT_TYPES = new Set(['input', 'beforeinput', 'keydown', 'keyup', 'keypress', 'scroll', 'wheel', 'mousemove', 'pointermove', 'touchmove', 'resize', 'selectionchange']);
    const domRecs = new Map(); // `${owner}|${type}|${target}` -> record
    const domWrappers = new WeakMap(); // listener -> Map(`${type}|${capture}` -> WeakMap(target -> wrapper))
    let inJqAdd = 0;

    function domRec(owner, type, target, site) {
        const key = `${owner}|${type}|${target}`;
        let rec = domRecs.get(key);
        if (!rec) {
            rec = { key, owner, type, target, site, count: 0, calls: 0, totalMs: 0, maxMs: 0, lastAt: 0, events: 0, deferred: 0, skipped: 0, ruleVer: -1, rule: null };
            domRecs.set(key, rec);
            ownerStat(owner).listeners++;
        }
        return rec;
    }

    function domRule(rec) {
        if (rec.ruleVer === rulesVer) return rec.rule;
        rec.ruleVer = rulesVer;
        rec.rule = rules.find(r => r.scope === 'dom' && r.owner === rec.owner && r.type === rec.type && (r.target === '*' || r.target === rec.target)) || null;
        return rec.rule;
    }

    function domInvoke(rec, fn, thisArg, args) {
        rec.events++;
        const r = domRule(rec);
        if (r) {
            if (r.kind === 'skip') { rec.skipped++; return undefined; }
            if (r.kind === 'debounce') {
                // Run once after the burst ends, with the last event. Note: preventDefault() is too late by then.
                rec.deferred++;
                rec.pendingThis = thisArg; rec.pendingArgs = args;
                if (rec.debounceTimer) orig.clearTimeout.call(window, rec.debounceTimer);
                rec.debounceTimer = orig.setTimeout.call(window, () => {
                    rec.debounceTimer = 0;
                    const a = rec.pendingArgs; const t = rec.pendingThis;
                    rec.pendingArgs = null; rec.pendingThis = null;
                    runTask(rec.owner, rec, fn, t, a);
                }, Math.max(16, Number(r.interval) || 300));
                return undefined;
            }
        }
        return runTask(rec.owner, rec, fn, thisArg, args);
    }

    function describeEventTarget(t) {
        try {
            if (t === window) return 'window';
            if (t instanceof Node) return describeTarget(t);
            return String(t?.constructor?.name || 'object'); // e.g. VisualViewport, XMLHttpRequest
        } catch { return '?'; }
    }

    const origAddEL = EventTarget.prototype.addEventListener;
    const origRemoveEL = EventTarget.prototype.removeEventListener;
    const captureOf = o => (typeof o === 'boolean' ? o : !!o?.capture);

    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (inJqAdd || typeof listener !== 'function' || !HOT_TYPES.has(type)) return origAddEL.call(this, type, listener, options);
        let w = null;
        try {
            const { owner, site } = ownerForNewTask();
            if (isExtOwner(owner)) {
                const k = `${type}|${captureOf(options)}`;
                let m = domWrappers.get(listener);
                if (!m) { m = new Map(); domWrappers.set(listener, m); }
                let byTarget = m.get(k);
                if (!byTarget) { byTarget = new WeakMap(); m.set(k, byTarget); }
                w = byTarget.get(this);
                if (!w) {
                    const rec = domRec(owner, type, describeEventTarget(this), site);
                    rec.count++;
                    w = function () { return domInvoke(rec, listener, this, arguments); };
                    byTarget.set(this, w);
                }
            }
        } catch (e) {
            // Instrumentation must never break the caller: fall back to the plain listener.
            w = null;
            console.debug('[ExtensionDoctor] listener wrap skipped', e);
        }
        return origAddEL.call(this, type, w || listener, options);
    };

    EventTarget.prototype.removeEventListener = function (type, listener, options) {
        if (typeof listener === 'function' && HOT_TYPES.has(type)) {
            let w = null;
            try { w = domWrappers.get(listener)?.get(`${type}|${captureOf(options)}`)?.get(this) || null; } catch { w = null; }
            if (w) return origRemoveEL.call(this, type, w, options);
        }
        return origRemoveEL.call(this, type, listener, options);
    };

    // jQuery: one native handler per element/type is shared by every .on() handler, so attribution must
    // happen at jQuery.event.add. The wrapper keeps the handler's guid so .off(fn) still finds it.
    function patchJquery() {
        const jq = window.jQuery;
        if (!jq?.event?.add || jq.event.add.__doctor) return;
        const origJqAdd = jq.event.add;
        const patched = function (elem, types, handler, data, selector) {
            inJqAdd++;
            try {
                if (typeof handler !== 'function' || typeof types !== 'string') return origJqAdd.apply(this, arguments);
                let w = null;
                try {
                    const names = types.split(/\s+/).map(t => t.split('.')[0]).filter(Boolean);
                    if (names.some(t => HOT_TYPES.has(t))) {
                        const { owner, site } = ownerForNewTask();
                        if (isExtOwner(owner)) {
                            const target = selector ? `${describeEventTarget(elem)} → ${selector}` : describeEventTarget(elem);
                            for (const t of names) if (HOT_TYPES.has(t)) domRec(owner, t, target, site).count++;
                            w = function (ev) {
                                const t = ev?.type;
                                if (!HOT_TYPES.has(t)) return handler.apply(this, arguments);
                                return domInvoke(domRec(owner, t, target, site), handler, this, arguments);
                            };
                            if (!handler.guid) handler.guid = jq.guid++;
                            w.guid = handler.guid;
                        }
                    }
                } catch (e) {
                    w = null; // never break jQuery: register the original handler
                    console.debug('[ExtensionDoctor] jQuery wrap skipped', e);
                }
                if (!w) return origJqAdd.apply(this, arguments);
                return origJqAdd.call(this, elem, types, w, data, selector);
            } finally {
                inJqAdd--;
            }
        };
        patched.__doctor = true;
        jq.event.add = patched;
    }

    // ---------------------------------------------------------------- API request origin (for error toasts)

    // Deep stack walk incl. V8 async frames ("at async fn"), so an `await generateRaw()` from an extension
    // still shows the extension even though the toast is raised inside ST's openai.js after the await.
    // Returns { owner, site, direct } — direct = owner of the very first frame (who called the API itself).
    function resolveDeep(above, collect = false) {
        if (!hasCallSites) return { ...resolveSite(), direct: null };
        const prevPrep = Error.prepareStackTrace; const prevLimit = Error.stackTraceLimit;
        let frames;
        try {
            Error.prepareStackTrace = toCallSites; Error.stackTraceLimit = 80;
            const holder = {};
            Error.captureStackTrace(holder, above || resolveDeep);
            frames = holder.stack;
        } finally { Error.prepareStackTrace = prevPrep; Error.stackTraceLimit = prevLimit; }
        if (!Array.isArray(frames)) return { owner: UNKNOWN, site: null, direct: null };
        let sawOrigin = false; let direct; let found = null;
        const stack = collect ? [] : null; // compact call flow, shown to the user on request
        for (const f of frames) {
            const url = f.getFileName?.() || f.getScriptNameOrSourceURL?.();
            if (!url) continue;
            if (url.endsWith('/probe.js') && url.includes(`/${SELF_FOLDER}/`)) continue;
            sawOrigin = sawOrigin || url.startsWith(location.origin);
            const owner = ownerFromUrl(url);
            if (stack && stack.length < 25) {
                let fn = '';
                try { fn = f.getFunctionName?.() || f.getMethodName?.() || ''; } catch { /* ignore */ }
                stack.push({ url, line: f.getLineNumber?.() || 0, col: f.getColumnNumber?.() || 0, fn, async: !!f.isAsync?.(), owner: owner || (url.startsWith(location.origin) ? CORE : UNKNOWN) });
            }
            if (direct === undefined) direct = owner || CORE;
            if (owner && !found) {
                found = { owner, site: { url, line: f.getLineNumber?.() || 0, col: f.getColumnNumber?.() || 0 }, direct };
                if (!stack) return found;
            }
        }
        const r = found || { owner: sawOrigin ? CORE : UNKNOWN, site: null, direct: direct ?? null };
        if (stack) r.stack = stack;
        return r;
    }

    // Requests that talk to an AI / external service. Cross-origin requests count too (extensions calling APIs directly).
    const RE_API = /\/api\/(backends|openai|sd|novelai|horde|translate|speech|google|azure|minimax|caption|vector|extra|search|backend)/i;
    function isApiUrl(url) {
        if (!url) return false;
        if (RE_API.test(url)) return true;
        return /^https?:\/\//i.test(url) && !url.startsWith(location.origin);
    }
    const apiCalls = []; // ring of recent API requests: { owner, site, url, t0, t1, status, ok }
    const shortUrl = u => { try { const x = new URL(u, location.href); return x.origin === location.origin ? x.pathname : `${x.host}${x.pathname}`; } catch { return String(u).slice(0, 80); } };

    if (typeof orig.fetch === 'function') {
        window.fetch = function wrappedFetch(input, init) {
            let rec = null;
            try {
                const url = typeof input === 'string' ? input : (input?.url || String(input));
                if (isApiUrl(url)) {
                    const c = ctx.current;
                    const r = (isExtOwner(c) || c === SELF) ? { owner: c, site: null } : resolveDeep(wrappedFetch);
                    rec = { owner: r.owner, site: r.site, url: shortUrl(url), t0: now(), t1: 0, status: 0, ok: null };
                    apiCalls.push(rec);
                    if (apiCalls.length > 30) apiCalls.shift();
                }
            } catch { rec = null; }
            const p = orig.fetch.apply(window, arguments);
            if (rec) {
                try { p.then(res => { rec.t1 = now(); rec.status = res.status; rec.ok = res.ok; }, () => { rec.t1 = now(); rec.ok = false; }); } catch { /* ignore */ }
            }
            return p;
        };
    }

    /**
     * Who is behind a toast being shown right now? `above` = the toast wrapper (its frames are cut off).
     * how: 'stack' (seen on the call stack, reliable) | 'ctx' (inside an extension callback) | 'api' (matched to a
     * recent failing/finished API request — a best guess). Returns null for Doctor's own toasts.
     */
    function toastSource(above) {
        const r = resolveDeep(above, true);
        if (r.direct === SELF) return null;
        const stack = r.stack;
        if (r.owner !== CORE && r.owner !== UNKNOWN) return { owner: r.owner, site: r.site, how: 'stack', api: lastApiBy(r.owner), stack };
        const c = ctx.current;
        if (isExtOwner(c)) return { owner: c, site: null, how: 'ctx', api: lastApiBy(c), stack };
        const t = now();
        let best = null;
        for (let i = apiCalls.length - 1; i >= 0; i--) {
            const a = apiCalls[i];
            if (!a.t1 || t - a.t1 > 4000) continue;
            if (!best || (a.ok === false && best.ok !== false)) best = a;
            if (best.ok === false) break;
        }
        if (best && best.owner !== CORE && best.owner !== UNKNOWN) return { owner: best.owner, site: best.site, how: 'api', api: { ...best }, stack };
        return { owner: r.owner, site: null, how: 'stack', api: best ? { ...best } : null, stack };
    }
    function lastApiBy(owner) {
        for (let i = apiCalls.length - 1; i >= 0; i--) if (apiCalls[i].owner === owner && now() - (apiCalls[i].t1 || now()) < 10000) return { ...apiCalls[i] };
        return null;
    }

    // ---------------------------------------------------------------- freeze watch (always on, near-zero cost)
    // The browser itself reports frames longer than 50ms; we only look at them. Nothing runs while the UI is smooth.

    const freezes = []; // most recent notable freezes (ring)
    const installedAt = now();
    const INVOKER_RE = /^(.*)\.on([a-z]+)$/;

    function effectiveFreezeMs(e) {
        let longest = 0;
        for (const s of e.scripts || []) if (s.duration > longest) longest = s.duration;
        return Math.max(e.blockingDuration || 0, longest);
    }

    function onLongFrame(e) {
        const scripts = e.scripts || [];
        let main = null;
        for (const s of scripts) if (!main || s.duration > main.duration) main = s;
        // Felt freeze = blocking time (or the longest single script). Frame length alone is inflated in
        // background/hidden tabs, where frames stretch to ~1s while almost nothing runs.
        const felt = effectiveFreezeMs(e);
        if (felt < 200) return;
        const attr = attributeScript(main);
        const owner = attr.owner;
        let type = attr.type || null; let target = attr.target || null;
        if (!type && main?.invokerType === 'event-listener') {
            const m = INVOKER_RE.exec(main.invoker || '');
            if (m) {
                type = m[2];
                const idm = /#([\w-]+)/.exec(m[1]);
                target = idm ? `#${idm[1]}` : m[1].toLowerCase();
            }
        }
        const f = {
            at: e.startTime, duration: felt, frameMs: e.duration, blocking: e.blockingDuration || 0, owner, kind: attr.kind || null,
            invoker: main?.invoker || '', invokerType: main?.invokerType || '', fn: main?.sourceFunctionName || '',
            file: main?.sourceURL || '', scriptMs: main?.duration || 0, type, target,
        };
        freezes.push(f);
        if (freezes.length > 60) freezes.shift();
        if (!config.freezeAlert || owner === SELF || !isExtOwner(owner)) return;
        if (felt < config.freezeMs || now() - installedAt < config.freezeQuietMs) return;
        emitAlert({ type: 'freeze', key: `fz:${owner}:${f.invoker}`, owner, freeze: f });
    }

    function startFreezeWatch() {
        try {
            if (!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) return false;
            const po = new PerformanceObserver(list => { for (const e of list.getEntries()) onLongFrame(e); });
            po.observe({ type: 'long-animation-frame', buffered: false });
            return true;
        } catch { return false; }
    }

    // ---------------------------------------------------------------- detector

    const alerted = new Map();
    function emitAlert(a) {
        const key = a.key;
        const t = Date.now();
        if (alerted.has(key) && t - alerted.get(key) < config.cooldownMs) return;
        alerted.set(key, t);
        if (alertHandlers.length) alertHandlers.forEach(h => { try { h(a); } catch (e) { console.error('[ExtensionDoctor]', e); } });
        else pendingAlerts.push(a);
    }

    function detect() {
        if (!config.loopDetect) return;
        const s = Math.floor(now() / 1000);
        const N = config.sustainSec;
        // single observer rate
        for (const rec of observers) {
            if (!rec.lastSeen || now() - rec.lastSeen > 2000) continue;
            let min = Infinity; let sum = 0;
            for (let i = 1; i <= N; i++) { const c = rec.rate.get(s - i); sum += c; if (c < min) min = c; }
            if (min > config.rateThreshold) {
                emitAlert({ type: 'rate', key: `rate:${rec.owner}:${rec.targets.map(t => t.sel).join(',')}`, owner: rec.owner, observerId: rec.id, target: rec.targets[0]?.sel || '?', perSec: Math.round(sum / N) });
            }
        }
        // ping-pong between two different extensions
        const seen = new Set();
        for (const e of edges.values()) {
            if (!isExtOwner(e.from) || !isExtOwner(e.to) || e.from === e.to) continue;
            if (now() - e.lastAt > 2000) continue;
            const back = edges.get(`${e.to}>${e.from}`);
            if (!back || now() - back.lastAt > 2000) continue;
            const pair = [e.from, e.to].sort().join('<>');
            if (seen.has(pair)) continue;
            seen.add(pair);
            let ok = true; let sum = 0;
            for (let i = 1; i <= N; i++) {
                const a = e.rate.get(s - i); const b = back.rate.get(s - i);
                sum += a + b;
                if (a < config.pingPongMin || b < config.pingPongMin) { ok = false; break; }
            }
            if (ok) {
                const [a, b] = pair.split('<>');
                emitAlert({ type: 'pingpong', key: `pp:${pair}`, a, b, perSec: Math.round(sum / N), observerIds: [...e.obs, ...back.obs] });
            }
        }
    }

    // ---------------------------------------------------------------- snapshot (for diagnosis)

    function snapshot() {
        const t = now();
        return {
            at: t,
            owners: [...owners.values()].map(o => ({ ...o })),
            observers: observers.map(r => ({
                id: r.id, owner: r.owner, site: r.site, targets: r.targets.map(x => ({ sel: x.sel, subtree: x.subtree, attributes: x.attributes, el: x.ref?.deref() || null })),
                calls: r.calls, totalMs: r.totalMs, maxMs: r.maxMs, records: r.records, skipped: r.skipped, throttled: r.throttled, connected: r.connected,
            })),
            intervals: [...intervals.values()].map(r => ({ ...r })),
            events: [...events.values()].map(r => ({ owner: r.owner, event: r.event, site: r.site, count: r.count, calls: r.calls, totalMs: r.totalMs, maxMs: r.maxMs, skipped: r.skipped })),
            edges: [...edges.values()].map(e => ({ from: e.from, to: e.to, count: e.count, obs: [...e.obs] })),
            dom: [...domRecs.values()].map(r => ({ key: r.key, owner: r.owner, type: r.type, target: r.target, site: r.site, count: r.count, calls: r.calls, totalMs: r.totalMs, maxMs: r.maxMs, events: r.events, deferred: r.deferred, skipped: r.skipped })),
            freezes: freezes.map(f => ({ ...f })),
            freezeWatch,
        };
    }

    // ---------------------------------------------------------------- install

    window.MutationObserver = DoctorMutationObserver;
    window.setTimeout = wrappedSetTimeout;
    window.setInterval = wrappedSetInterval;
    window.clearInterval = wrappedClearInterval;
    window.requestAnimationFrame = wrappedRaf;
    panels();
    wrapInsert(Node.prototype, 'appendChild');
    wrapInsert(Node.prototype, 'insertBefore');
    wrapInsert(Element.prototype, 'append');
    wrapInsert(Element.prototype, 'prepend');
    wrapInsert(Element.prototype, 'insertAdjacentHTML');
    wrapInsert(Element.prototype, 'insertAdjacentElement');
    wrapEventSource();
    patchJquery();
    const freezeWatch = startFreezeWatch();

    // Remembered hotfix rules from extension settings (already loaded by ST before extensions activate).
    try {
        const saved = globalThis.SillyTavern?.getContext?.()?.extensionSettings?.extensionDoctor;
        if (saved) {
            if (Array.isArray(saved.hotfixes)) setRules(saved.hotfixes.map(r => ({ ...r, persist: true })));
            if (typeof saved.loopDetect === 'boolean') config.loopDetect = saved.loopDetect;
            if (Number(saved.rateThreshold) > 0) config.rateThreshold = Number(saved.rateThreshold);
            if (typeof saved.freezeAlert === 'boolean') config.freezeAlert = saved.freezeAlert;
            if (Number(saved.freezeMs) > 0) config.freezeMs = Number(saved.freezeMs);
        }
    } catch { /* settings not available yet: index.js will apply them */ }

    orig.setInterval.call(window, detect, 1000);

    return {
        SELF, SELF_FOLDER, CORE, UNKNOWN, orig, config, ctx,
        ownerFromUrl, isExtOwner, snapshot, panelOwners, HOT_TYPES, attributeScript, effectiveFreezeMs, toastSource,
        recentApiCalls: () => apiCalls.map(a => ({ ...a })),
        get rules() { return rules.slice(); }, setRules, addRule, removeRule,
        onAlert(h) { alertHandlers.push(h); while (pendingAlerts.length) { try { h(pendingAlerts.shift()); } catch (e) { console.error(e); } } },
        wrapEventSource,
        resetAlertCooldown() { alerted.clear(); },
    };
}

if (!window.__extensionDoctorProbe) {
    try {
        window.__extensionDoctorProbe = install();
    } catch (e) {
        console.error('[ExtensionDoctor] probe install failed', e);
    }
}

export const probe = window.__extensionDoctorProbe;
