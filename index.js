/*
 * Slop Guard — SillyTavern UI extension
 *
 * Keeps a list of phrases a model keeps falling back on ("อย่างถือสิทธิ์" from
 * Gemini, "หัวเราะแห้งแล้ง" from DeepSeek, ...). Each rule picks one way to
 * handle its phrase in the bot's replies:
 *   • fix    — a wrong or broken phrase: replace or delete it every time.
 *   • vary   — a fine phrase that is overused: it may appear once, then goes on
 *     cooldown; while it cools, each new occurrence is swapped for a random
 *     alternative from the rule's pool that is not cooling itself, and that
 *     alternative goes on cooldown in turn. Cooldown is read from the chat
 *     itself (did it appear in the last N bot replies?), so swipes, edits and
 *     deleted messages are always accounted for.
 *   • flag   — something no fixed replacement can repair (a word in another
 *     script slipping into Thai prose): point it out, and let the user, or the
 *     model, rewrite it.
 *   • prompt — leave replies alone; only tell the model.
 * Edits land in the saved message itself (after a confirmation popup, or
 * straight away), so the phrase never reaches the history the model reads back.
 * Any rule can also carry an instruction that is injected at a chat depth, but
 * only while a model the rule is scoped to is selected, so one model never gets
 * shown another model's tics. The injection goes through setExtensionPrompt,
 * so it works with any preset. An instruction can also wait until its phrase
 * turns up often in the last few replies, so the model is not shown the phrase
 * while it is not using it. The same goes for replies that keep opening or
 * closing alike, or keep ending on a question: the warning is only sent while
 * that is happening.
 * A scan asks the current model to find repeated phrases in the chat and
 * offers them as new rules; the model can also suggest alternatives for a pool.
 */

import { installThemePalette } from './theme-palette.js';

const MODULE = 'slop_guard';
const PROMPT_KEY = 'slop_guard';
const LOG = '[SlopGuard]';
const VERSION = '1.3.3'; // keep in sync with manifest.json

const IN_CHAT = 1; // extension_prompt_types.IN_CHAT

const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'ask', // ask | auto — confirm edits to a new reply in a popup, or make them straight away
    inject: true,
    depth: 1,
    role: 0, // extension_prompt_roles: 0 system, 1 user, 2 assistant
    header: '[สไตล์การเขียน]',
    scanCount: 30,
    scanSameModel: true,
    cooldown: 5, // bot replies a phrase or alternative stays "used" for
    watchWindow: 6, // bot replies looked at for "often" rules and repeated openings/closings
    patternMin: 3, // that many alike openings/closings in the window count as a habit
    patterns: { opening: true, closing: true, question: true },
});

const SEED_RULES = [
    {
        find: '/\\s?(?:อย่าง|ด้วยท่าที|ด้วยท่าทาง)(?:ถือสิทธิ์?|ถือสิทธ์|เป็นเจ้าของ|แสดงความเป็นเจ้าของ|ครอบครอง|อ้างสิทธิ์?)/g',
        mode: 'vary',
        pool: ['อย่างหวงแหน', 'อย่างไม่ยอมปล่อย', 'ราวกับกลัวจะหลุดมือ', 'อย่างหึงหวง', 'อย่างไม่คิดจะแบ่งให้ใคร',
            'ราวกับเป็นของล้ำค่า', 'อย่างแน่นหนา', 'อย่างไม่ยอมให้ใครแตะต้อง', 'ด้วยความหวงแหน', 'ราวกับประกาศว่าเป็นของตน'],
        models: 'gemini',
        prompt: 'ห้ามต่อท้ายกริยาด้วย "อย่างถือสิทธิ์" หรือ "อย่างเป็นเจ้าของ" ถ้าจะสื่อความหวง ให้แสดงผ่านการกระทำหรือบทพูด เช่น ดึงเข้ามาใกล้ ไม่ยอมปล่อยมือ',
    },
    {
        find: '/(หัวเราะ(?:ออกมา)?)\\s?(?:อย่าง)?แห้งแล้ง/g',
        mode: 'fix',
        replace: '$1',
        models: 'deepseek',
        prompt: 'ห้ามใช้ "หัวเราะแห้งแล้ง" ถ้าตัวละครหัวเราะแบบฝืน ให้แสดงผ่านสิ่งที่ทำต่อ เช่น เบือนหน้า พูดเปลี่ยนเรื่อง หรือเสียงที่ขาดห้วน',
    },
    {
        find: 'อย่างสมบูรณ์แบบ',
        mode: 'vary',
        pool: ['พอดิบพอดี', 'อย่างเหมาะเจาะ', 'ราวกับสร้างมาคู่กัน', 'ราวกับเกิดมาเพื่อกันและกัน', 'อย่างลงตัว',
            'อย่างกลมกลืน', 'อย่างไม่มีที่ติ', 'จนแทบไม่น่าเชื่อ', 'ราวกับเป็นชิ้นส่วนเดียวกัน', 'อย่างไร้รอยต่อ'],
        models: '',
        prompt: '',
    },
];

/** Substrings that name a model family; the first one found in a model id wins. */
const FAMILIES = ['gemini', 'gemma', 'deepseek', 'claude', 'gpt', 'grok', 'llama', 'mistral', 'qwen', 'glm', 'kimi', 'command'];

// ---------------------------------------------------------------- helpers

const ctx = () => SillyTavern.getContext();
const $id = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const toast = {
    info: m => globalThis.toastr?.info(m, 'Slop Guard'),
    ok: m => globalThis.toastr?.success(m, 'Slop Guard'),
    warn: m => globalThis.toastr?.warning(m, 'Slop Guard'),
};

// ---------------------------------------------------------------- inline errors
// A failed AI button shows its error right under the button that failed, with what to do
// about it, and stays until it is closed or the button is pressed again. A toast vanishes,
// and on a phone the user may not have seen which button it came from.

/** What to do about an API error, read from its message. */
function errorFix(message) {
    const m = String(message ?? '');
    if (/\b40[13]\b|unauthori[sz]ed|forbidden|api[ _-]?key|invalid.*key/i.test(m)) return 'API key ไม่ถูกต้องหรือหมดอายุ ตรวจในหน้า API Connections (ไอคอนปลั๊กด้านบน)';
    if (/\b429\b|quota|rate.?limit|too many|exhausted/i.test(m)) return 'โควต้าหมดหรือส่งถี่เกินไป รอสักครู่ หรือเปลี่ยนไปใช้โมเดลอื่น';
    if (/timeout|timed out|network|failed to fetch|abort|ECONN|50[0234]\b/i.test(m)) return 'ติดต่อ API ไม่ได้ ตรวจว่ายังเชื่อมต่ออยู่ (ไอคอนปลั๊กด้านบน) แล้วลองอีกครั้ง';
    if (/safety|block|filter|refus/i.test(m)) return 'โมเดลปฏิเสธหรือติดตัวกรอง ลองอีกครั้ง หรือเปลี่ยนไปใช้โมเดลอื่น';
    return 'ตรวจว่าเชื่อมต่อ API อยู่ (ไอคอนปลั๊กด้านบน) แล้วลองอีกครั้ง';
}

/** Shows an error under `anchor` (the row holding the button). `detail` is the raw API text, if any. */
function showError(anchor, what, { detail = '', fix = '' } = {}) {
    if (!anchor) return;
    clearError(anchor);
    const box = document.createElement('div');
    box.className = 'sg_err';
    box.setAttribute('role', 'alert');
    box.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>
        <div class="sg_err_text"><b>${esc(what)}</b>${fix ? `<div>${esc(fix)}</div>` : ''}${detail ? `<small>${esc(detail)}</small>` : ''}</div>
        <div class="menu_button fa-solid fa-xmark sg_err_close" title="ปิด"></div>`;
    box.querySelector('.sg_err_close').addEventListener('click', () => box.remove());
    anchor.after(box);
}
function clearError(anchor) {
    const next = anchor?.nextElementSibling;
    if (next?.classList.contains('sg_err')) next.remove();
}


/** How a rule handles its phrase in a reply. */
const MODES = {
    fix: { label: 'แก้คำผิด', desc: 'คำผิดหรือคำแปลก ลบหรือแทนที่ทุกครั้งที่เจอ' },
    vary: { label: 'หลากคำ', desc: 'คำที่ใช้ได้แต่ใช้ซ้ำ ปล่อยผ่านครั้งแรก แล้วสุ่มคำจากคลังมาแทนระหว่างคูลดาวน์' },
    flag: { label: 'แจ้งเตือน', desc: 'แก้ด้วยคำตายตัวไม่ได้ เช่น อักษรต่างภาษาหลุด จะแจ้งพร้อมจุดที่เจอ ให้แก้เองหรือให้ AI แก้' },
    prompt: { label: 'แค่ prompt', desc: 'ไม่แก้ข้อความ บอกโมเดลผ่านกฎใน prompt อย่างเดียว' },
};

function makeRule(r = {}) {
    const pool = parsePool(r.pool);
    return {
        id: r.id || newId(),
        enabled: r.enabled !== false,
        name: String(r.name ?? ''), // optional label, shown above the pattern (ready-made rules have one)
        find: String(r.find ?? ''),
        // Rules saved before 1.2 have no mode: "remove" off meant prompt only, and a pool meant variety.
        mode: MODES[r.mode] ? r.mode : r.remove === false ? 'prompt' : pool.length ? 'vary' : 'fix',
        replace: String(r.replace ?? ''),
        pool,
        allowFirst: r.allowFirst !== false, // vary: the phrase itself may appear once per cooldown
        models: String(r.models ?? ''),
        prompt: String(r.prompt ?? ''),
        when: r.when === 'often' ? 'often' : 'always', // when the prompt instruction is sent
        minHits: Math.max(1, Math.round(Number(r.minHits)) || 2), // "often": this many hits in the watch window
    };
}

/** A pool is stored as an array; the UI edits it as one alternative per line. */
function parsePool(v) {
    const list = Array.isArray(v) ? v : String(v ?? '').split('\n');
    const out = [];
    for (const x of list) {
        const t = String(x ?? '').trim();
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}

const hasPool = r => r.pool?.length > 0;

let migrated = false;

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = typeof v === 'object' ? { ...v } : v;
    }
    if (!Array.isArray(s.rules)) s.rules = SEED_RULES.map(makeRule);
    if (!migrated) {
        migrated = true;
        // Bring rules saved by older versions up to the current shape (missing
        // fields used to break the rule list). Ids and contents are kept.
        s.rules = s.rules.filter(r => r && typeof r === 'object').map(makeRule);
        // The old global "don't remove" option is now a per-rule choice.
        if (s.mode === 'off') {
            for (const r of s.rules) r.mode = 'prompt';
            s.mode = 'ask';
        }
        if (s.mode !== 'auto') s.mode = 'ask';
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
    updatePrompt();
}

// ---------------------------------------------------------------- models

function currentModel() {
    const c = ctx();
    try {
        if (c.mainApi === 'openai') return String(c.getChatCompletionModel?.() ?? '');
    } catch { /* fall through */ }
    const status = String(c.onlineStatus ?? '');
    return status === 'no_connection' ? '' : status;
}

function modelFamily(model) {
    const m = String(model ?? '').toLowerCase();
    return FAMILIES.find(f => m.includes(f)) ?? m.split('/').pop();
}

/** A rule with no models applies everywhere; otherwise any listed substring must occur in the model id. */
function modelMatches(rule, model) {
    const wanted = rule.models.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (!wanted.length) return true;
    const m = String(model ?? '').toLowerCase();
    return wanted.some(w => m.includes(w));
}

// ---------------------------------------------------------------- matching

const compiled = new Map(); // `${find}\u0000${deletes}` -> RegExp | null

/** A literal phrase that is deleted outright takes one space next to it along. */
const deletes = rule => rule.mode === 'fix' && rule.replace === '';

/**
 * "/body/flags" is a regex (g is always added). Anything else is a literal phrase;
 * when it is deleted (fix rule, empty replacement) one space next to it goes too, so
 * "held her possessively close" becomes "held her close".
 */
function compile(rule) {
    const key = `${rule.find}\u0000${deletes(rule) ? 1 : 0}`;
    if (compiled.has(key)) return compiled.get(key);
    let rx = null;
    const m = rule.find.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
    try {
        if (m) {
            rx = new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
        } else if (rule.find.trim()) {
            const body = escapeRegex(rule.find.trim());
            rx = new RegExp(deletes(rule) ? `[ \\t]${body}|${body}[ \\t]?` : body, 'g');
        }
    } catch (e) {
        console.warn(LOG, 'invalid pattern', rule.find, e);
        rx = null;
    }
    compiled.set(key, rx);
    return rx;
}

const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];
function pickWeighted(arr, weight) {
    const w = arr.map(weight);
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < arr.length; i++) if ((r -= w[i]) < 0) return arr[i];
    return arr[arr.length - 1];
}
/** Below this many alternatives off cooldown, some cooling ones are allowed back so the order stays unpredictable. */
const MIN_CHOICES = 3;

/** What to look for in the chat to tell whether an alternative was used: its text without $1-style references. */
const fingerprint = v => v.replace(/\$(?:\d{1,2}|&|<[^>]*>)/g, '').trim().toLowerCase();

/**
 * Hands out replacements for one pool rule across one reply.
 * Age of a phrase = how many bot replies back it last appeared (0 = this reply,
 * Infinity = not within the cooldown window, i.e. free to use).
 */
function rotation(rule, rx, text, history) {
    const test = new RegExp(rx.source, rx.flags.replace('g', ''));
    const lower = history.map(h => h.toLowerCase());
    const ageIn = has => {
        for (let k = 1; k <= history.length; k++) if (has(history[history.length - k], lower[lower.length - k])) return k;
        return Infinity;
    };
    let originalFree = rule.allowFirst && ageIn(h => test.test(h)) === Infinity;
    const textLower = text.toLowerCase();
    const vars = rule.pool.map(v => {
        const fp = fingerprint(v);
        const age = !fp ? Infinity : textLower.includes(fp) ? 0 : ageIn((_, l) => l.includes(fp));
        return { v, age };
    });
    const window = history.length + 1;
    return {
        /** @returns {string|null} a replacement template, or null to leave this occurrence alone */
        next() {
            if (originalFree) { originalFree = false; return null; }
            // Off cooldown: equally likely. When fewer than MIN_CHOICES are off cooldown
            // (small pool, or the phrase keeps coming back), the ones cooling longest
            // join in with a smaller chance. A hard cooldown on a small pool would
            // otherwise leave exactly one option each time and repeat in a fixed order.
            // Never this reply's or the previous reply's word, while anything else is left.
            const free = vars.filter(x => x.age === Infinity);
            let pick;
            if (free.length >= MIN_CHOICES) pick = pickRandom(free);
            else {
                const cooled = n => vars.filter(x => x.age === n || (n === 2 && x.age >= 2 && x.age !== Infinity));
                const options = [...free, ...cooled(2)];
                if (options.length < MIN_CHOICES) options.push(...cooled(1)); // the previous reply's words
                if (!options.length) options.push(...cooled(0)); // only this reply's words are left
                pick = pickWeighted(options, x => x.age === Infinity ? 1 : (x.age + 1) / (window + 1));
            }
            pick.age = 0;
            return pick.v;
        },
    };
}

/**
 * Works out every change the rules make to a reply, without making it.
 * @param {string} text
 * @param {any[]} rules
 * @param {string[]} history — earlier bot replies, oldest first, within the cooldown window
 * @returns {{rule, index:number, text:string, after:string}[]} non-overlapping, in text order
 */
function planEdits(text, rules, history = []) {
    const edits = [];
    for (const rule of rules) {
        const rx = compile(rule);
        if (!rx) continue;
        if (rule.mode === 'prompt' || (rule.mode === 'vary' && !hasPool(rule))) continue;
        const single = new RegExp(rx.source, rx.flags.replace('g', ''));
        const rot = rule.mode === 'vary' ? rotation(rule, rx, text, history) : null;
        for (const m of text.matchAll(rx)) {
            if (!m[0]) continue;
            const template = rot ? rot.next() : rule.replace;
            if (template === null) continue;
            const after = m[0].replace(single, template);
            if (after !== m[0]) edits.push({ rule, index: m.index, text: m[0], after });
        }
    }
    // Stable sort keeps rule order for edits at the same spot; the first one wins.
    edits.sort((a, b) => a.index - b.index);
    const out = [];
    let end = -1;
    for (const e of edits) {
        if (e.index < end) continue;
        out.push(e);
        end = e.index + e.text.length;
    }
    return out;
}

function applyEdits(text, edits) {
    let out = text;
    for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i];
        out = out.slice(0, e.index) + e.after + out.slice(e.index + e.text.length);
    }
    return out;
}

const isBotMessage = m => m && !m.is_user && !m.is_system && typeof m.mes === 'string';

/** Texts of the bot replies before `id`, oldest first, as many as the cooldown covers. */
function historyBefore(id, texts = null) {
    const c = ctx();
    const n = Math.max(0, Number(settings().cooldown) || 0);
    const out = [];
    for (let i = id - 1; i >= 0 && out.length < n; i--) {
        if (!isBotMessage(c.chat[i])) continue;
        out.push(texts?.get(i) ?? c.chat[i].mes);
    }
    return out.reverse();
}

const removalRules = () => settings().rules.filter(r => r.enabled && (r.mode === 'fix' || r.mode === 'vary') && r.find.trim());
const flagRules = () => settings().rules.filter(r => r.enabled && r.mode === 'flag' && r.find.trim());

// ---------------------------------------------------------------- how often (for "often" rules)

const HITS_KEY = 'slop_guard_hits'; // message.extra[HITS_KEY] = { ruleId: matches edited out of this message }

/** Remembers what was edited out of a message, so "often" still counts it. */
function recordHits(msg, edits) {
    if (!edits.length) return;
    msg.extra ??= {};
    const h = msg.extra[HITS_KEY] ??= {};
    for (const e of edits) h[e.rule.id] = (h[e.rule.id] ?? 0) + 1;
}

/** The last `n` bot replies of the open chat, oldest first. */
function recentReplies(n) {
    const chat = ctx().chat ?? [];
    const out = [];
    for (let i = chat.length - 1; i >= 0 && out.length < n; i--) if (isBotMessage(chat[i])) out.push(chat[i]);
    return out.reverse();
}

/** Matches of a rule in these replies, counting the ones already edited out. */
function countHits(rule, msgs) {
    const rx = compile(rule);
    if (!rx) return 0;
    let n = 0;
    for (const m of msgs) {
        for (const x of m.mes.matchAll(rx)) if (x[0]) n++;
        n += Number(m.extra?.[HITS_KEY]?.[rule.id]) || 0;
    }
    return n;
}

// ---------------------------------------------------------------- repeated openings / closings

/** The text a reader sees, without markup, thinking blocks or quote marks. */
function plainText(text) {
    return stripForScan(String(text ?? '')).replace(/[*_~`"“”'‘’「」『』]/g, '').trim();
}

const MIN_SEG = 12;
const MAX_SEG = 40;

/** First or last stretch of a reply, cut at a space so it reads as a phrase. */
function edgeOf(text, which) {
    const lines = plainText(text).split(/\n+/).map(l => l.trim()).filter(l => /\p{L}/u.test(l));
    if (!lines.length) return '';
    if (which === 'start') {
        const l = lines[0];
        if (l.length <= MAX_SEG) return l;
        const cut = l.slice(MIN_SEG, MAX_SEG).search(/\s/);
        return cut < 0 ? l.slice(0, MAX_SEG) : l.slice(0, MIN_SEG + cut);
    }
    const l = lines[lines.length - 1];
    if (l.length <= MAX_SEG) return l;
    const tail = l.slice(-MAX_SEG);
    const cut = tail.slice(0, MAX_SEG - MIN_SEG).search(/\s/);
    return cut < 0 ? tail : tail.slice(cut + 1);
}

function bigrams(s) {
    const t = s.toLowerCase().replace(/\s+/g, ' ');
    const out = new Map();
    for (let i = 0; i < t.length - 1; i++) {
        const g = t.slice(i, i + 2);
        out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
}

/** Dice coefficient over character pairs: 1 = same, 0 = nothing shared. */
function similarity(a, b) {
    if (!a || !b) return 0;
    const A = bigrams(a), B = bigrams(b);
    let shared = 0, total = 0;
    for (const [g, n] of A) { shared += Math.min(n, B.get(g) ?? 0); total += n; }
    for (const n of B.values()) total += n;
    return total ? (2 * shared) / total : 0;
}

const ALIKE = 0.5;

/** The biggest group of alike segments: how many, and the newest one as the example. */
function biggestAlike(segs) {
    let best = { count: 0, example: '' };
    segs.forEach((a, i) => {
        if (!a) return;
        const count = segs.filter(b => b && similarity(a, b) >= ALIKE).length;
        if (count >= best.count) best = { count, example: a };
    });
    return best;
}

const endsWithQuestion = t => /[?？]\s*$/.test(plainText(t).replace(/[)\]]+\s*$/, ''));

/** What the recent replies keep doing, by kind: { count, example } (example only for alike segments). */
function patternState() {
    const s = settings();
    const msgs = recentReplies(Math.max(2, Number(s.watchWindow) || DEFAULTS.watchWindow));
    return {
        total: msgs.length,
        opening: biggestAlike(msgs.map(m => edgeOf(m.mes, 'start'))),
        closing: biggestAlike(msgs.map(m => edgeOf(m.mes, 'end'))),
        question: { count: msgs.filter(m => endsWithQuestion(m.mes)).length, example: '' },
    };
}

const PATTERN_TEXT = {
    opening: { label: 'ขึ้นต้นข้อความคล้ายกัน', prompt: ex => `หลายข้อความล่าสุดขึ้นต้นคล้ายกัน (เช่น "${ex}") ให้ขึ้นต้นข้อความถัดไปด้วยแบบอื่น เช่น บทพูด เสียง หรือสิ่งที่เกิดขึ้นรอบตัว` },
    closing: { label: 'ลงท้ายข้อความคล้ายกัน', prompt: ex => `หลายข้อความล่าสุดลงท้ายคล้ายกัน (เช่น "${ex}") ให้จบข้อความถัดไปด้วยแบบอื่น` },
    question: { label: 'จบข้อความด้วยคำถาม', prompt: () => 'หลายข้อความล่าสุดจบด้วยคำถาม ให้จบข้อความถัดไปด้วยการกระทำ บทพูด หรือภาพ ที่ไม่ใช่คำถาม' },
};

/** Instructions for the habits that are happening right now. */
function patternLines(state) {
    const s = settings();
    const min = Math.max(2, Number(s.patternMin) || DEFAULTS.patternMin);
    const lines = [];
    for (const [k, t] of Object.entries(PATTERN_TEXT)) {
        if (!s.patterns?.[k] || state[k].count < min) continue;
        lines.push(t.prompt(state[k].example));
    }
    return lines;
}

// ---------------------------------------------------------------- prompt injection

/** Rules whose prompt instruction applies to this model; "often" ones only while their phrase keeps turning up. */
function promptRules(model, recent) {
    return settings().rules.filter(r => r.enabled && r.prompt.trim() && modelMatches(r, model)
        && (r.when !== 'often' || countHits(r, recent) >= r.minHits));
}

function updatePrompt() {
    const s = settings();
    const c = ctx();
    let text = '';
    if (s.enabled && s.inject) {
        const model = currentModel();
        const recent = recentReplies(Math.max(1, Number(s.watchWindow) || DEFAULTS.watchWindow));
        const lines = [
            ...promptRules(model, recent).map(r => r.prompt.trim()),
            ...patternLines(patternState()),
        ].map(l => `- ${l}`);
        if (lines.length) text = `${s.header}\n${lines.join('\n')}`;
    }
    c.setExtensionPrompt(PROMPT_KEY, text, IN_CHAT, Number(s.depth) || 0, false, Number(s.role) || 0);
    syncModelLine();
}

// ---------------------------------------------------------------- review popup

function snippet(text, m) {
    const pad = 40;
    const start = Math.max(0, m.index - pad);
    const end = Math.min(text.length, m.index + m.text.length + pad);
    const before = text.slice(start, m.index).replace(/\s+/g, ' ');
    const after = text.slice(m.index + m.text.length, end).replace(/\s+/g, ' ');
    const repl = m.after ? `<ins>${esc(m.after)}</ins>` : '';
    return `${start > 0 ? '…' : ''}${esc(before)}<del>${esc(m.text)}</del>${repl}${esc(after)}${end < text.length ? '…' : ''}`;
}

/**
 * Asks which rules to apply.
 * @param {{id:number, text:string, edits:any[]}[]} found
 * @param {boolean} single — a fresh reply (offers "always remove")
 * @returns {Promise<{ruleIds:Set<string>, always:boolean}|null>}
 */
async function reviewPopup(found, single) {
    const c = ctx();
    const byRule = new Map();
    for (const f of found) {
        const seen = new Set();
        for (const e of f.edits) {
            if (!byRule.has(e.rule.id)) byRule.set(e.rule.id, { rule: e.rule, count: 0, messages: 0, samples: [] });
            const g = byRule.get(e.rule.id);
            g.count += 1;
            if (!seen.has(e.rule.id)) { seen.add(e.rule.id); g.messages += 1; }
            if (g.samples.length < 3) g.samples.push(snippet(f.text, e));
        }
    }

    const root = document.createElement('div');
    root.className = 'sg_review';
    const where = single ? 'ในข้อความล่าสุด' : `ใน ${found.length} ข้อความ`;
    root.innerHTML = `
        <h3>จะแก้ข้อความ${where}</h3>
        <small class="sg_note">ติ๊กกฎที่จะใช้ <del>ขีดฆ่า</del> คือส่วนที่จะหายไป <ins>ขีดเส้นใต้</ins> คือส่วนที่ใส่แทน</small>
        ${[...byRule.values()].map(g => `
        <label class="sg_review_rule">
            <div class="sg_review_head">
                <input type="checkbox" data-rule="${esc(g.rule.id)}" checked>
                <code>${esc(g.rule.name || g.rule.find)}</code>
                <span class="sg_badge">${MODES[g.rule.mode].label} · ${g.count} ครั้ง${single ? '' : ` · ${g.messages} ข้อความ`}</span>
            </div>
            ${g.samples.map(x => `<div class="sg_sample">${x}</div>`).join('')}
        </label>`).join('')}`;

    const customButtons = single
        ? [{ text: 'แก้เลยต่อจากนี้ ไม่ต้องถาม', result: c.POPUP_RESULT.CUSTOM1, classes: ['sg_always'] }]
        : null;
    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'แก้',
        cancelButton: 'ปล่อยไว้',
        customButtons,
        wide: true,
        allowVerticalScrolling: true,
    });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE && result !== c.POPUP_RESULT.CUSTOM1) return null;
    const ruleIds = new Set([...root.querySelectorAll('input[data-rule]:checked')].map(x => x.dataset.rule));
    return { ruleIds, always: result === c.POPUP_RESULT.CUSTOM1 };
}

// ---------------------------------------------------------------- applying

function writeMessage(id, text) {
    const c = ctx();
    const msg = c.chat[id];
    msg.mes = text;
    if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id) && msg.swipe_id < msg.swipes.length) {
        msg.swipes[msg.swipe_id] = text;
    }
    c.updateMessageBlock(id, msg);
    c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, id);
}

// Popups for incoming replies are shown one at a time, and the event handler
// never waits on them — SillyTavern awaits MESSAGE_RECEIVED before finishing a
// generation, and a popup left open must not hold that up.
let queue = Promise.resolve();
const enqueue = fn => { queue = queue.then(fn).catch(e => console.error(LOG, e)); };

function onMessageReceived(mesId, type) {
    const s = settings();
    if (!s.enabled) return;
    if (type === 'first_message' || type === 'command') return;
    const id = Number(mesId);
    enqueue(() => handleReply(id));
}

async function handleReply(id) {
    const s = settings();
    const c = ctx();
    const msg = c.chat[id];
    if (!isBotMessage(msg)) return;
    await editReply(id, msg);
    await checkFlags(id);
    updatePrompt();
}

async function editReply(id, msg) {
    const s = settings();
    const c = ctx();
    const text = msg.mes;
    let edits = planEdits(text, removalRules(), historyBefore(id));
    if (!edits.length) return;

    if (s.mode === 'ask') {
        const answer = await reviewPopup([{ id, text, edits }], true);
        if (!answer) return;
        if (answer.always) {
            s.mode = 'auto';
            save();
            syncSettingsUi();
            toast.info('ต่อจากนี้จะแก้เลยโดยไม่ถาม ติ๊ก "ถามก่อนแก้" ในหน้าตั้งค่า Slop Guard ได้ถ้าอยากให้ถามอีก');
        }
        edits = edits.filter(e => answer.ruleIds.has(e.rule.id));
        // The user may have swiped, edited or deleted while the popup was open.
        if (ctx().chat[id] !== msg || msg.mes !== text) {
            toast.warn('ข้อความเปลี่ยนไประหว่างรอ เลยไม่ได้แก้ให้');
            return;
        }
    }
    if (!edits.length) return;

    const out = applyEdits(text, edits);
    if (out === text) return;
    recordHits(msg, edits);
    writeMessage(id, out);
    await c.saveChat();
    if (s.mode === 'auto') toast.info(`แก้ ${edits.length} จุดในข้อความล่าสุด`);
}

async function cleanWholeChat() {
    const c = ctx();
    if (!c.chat?.length) return toast.warn('ยังไม่ได้เปิดแชท');
    const rules = removalRules();
    const found = [];
    // Go oldest to newest, and let each reply's cooldown see the earlier replies
    // as they will read after cleaning, so alternatives keep rotating.
    const cleaned = new Map();
    c.chat.forEach((m, id) => {
        if (!isBotMessage(m)) return;
        const edits = planEdits(m.mes, rules, historyBefore(id, cleaned));
        if (!edits.length) return;
        found.push({ id, text: m.mes, edits });
        cleaned.set(id, applyEdits(m.mes, edits));
    });
    if (!found.length) return toast.ok('ไม่เจอคำที่แบนไว้ในแชทนี้');

    const answer = await reviewPopup(found, false);
    if (!answer) return;
    let changed = 0;
    for (const f of found) {
        if (c.chat[f.id]?.mes !== f.text) continue;
        const edits = f.edits.filter(e => answer.ruleIds.has(e.rule.id));
        const out = applyEdits(f.text, edits);
        if (out !== f.text) { recordHits(c.chat[f.id], edits); writeMessage(f.id, out); changed++; }
    }
    if (changed) await c.saveChat();
    toast.ok(`แก้ไป ${changed} ข้อความ`);
    updatePrompt();
}

// ---------------------------------------------------------------- flags: point out, rewrite by hand or by AI

/** Matches of flag rules, without overlaps, in text order. */
function findFlags(text) {
    const hits = [];
    for (const rule of flagRules()) {
        const rx = compile(rule);
        if (!rx) continue;
        for (const m of text.matchAll(rx)) if (m[0]) hits.push({ rule, index: m.index, text: m[0] });
    }
    hits.sort((a, b) => a.index - b.index);
    const out = [];
    let end = -1;
    for (const h of hits) {
        if (h.index < end) continue;
        out.push(h);
        end = h.index + h.text.length;
    }
    return out;
}

function contextOf(text, h, pad = 60) {
    const start = Math.max(0, h.index - pad);
    const end = Math.min(text.length, h.index + h.text.length + pad);
    return {
        before: (start > 0 ? '…' : '') + text.slice(start, h.index).replace(/\s+/g, ' '),
        after: text.slice(h.index + h.text.length, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : ''),
    };
}

/** After a new reply: if a flag rule matched, ask right away (ask mode) or leave a toast to tap. */
async function checkFlags(id) {
    const msg = ctx().chat[id];
    if (!isBotMessage(msg)) return;
    const hits = findFlags(msg.mes);
    if (!hits.length) return;
    if (settings().mode === 'ask') return flagPopup(id);
    const what = [...new Set(hits.map(h => h.text))].slice(0, 3).join(', ');
    globalThis.toastr?.warning(`เจอ ${hits.length} จุดที่ต้องเช็กในข้อความล่าสุด: ${esc(what)}<br>แตะเพื่อดูและแก้`, 'Slop Guard', {
        timeOut: 15000, extendedTimeOut: 5000, closeButton: true, escapeHtml: false,
        onclick: () => enqueue(() => flagPopup(id)),
    });
}

const FIX_SYSTEM = `You fix fragments that slipped into Thai prose in the wrong language or script.
For each item you get the sentence around it, with the fragment between ⟦ ⟧.
Rewrite ONLY the fragment as natural Thai that fits the sentence and keeps its meaning. Keep proper names that are clearly meant to stay as they are.
Return ONLY a JSON array of strings, one per item, in the same order.`;

async function aiRewrite(text, hits) {
    const items = hits.map((h, i) => { const x = contextOf(text, h); return `${i + 1}. ${x.before}⟦${h.text}⟧${x.after}`; });
    const raw = await ctx().generateRaw({
        systemPrompt: FIX_SYSTEM,
        prompt: `${items.join('\n')}\n\nReturn the JSON array of ${hits.length} strings now.`,
        responseLength: 600,
    });
    return parseStringList(raw);
}

/** Lists what the flag rules found in a reply; each spot can be rewritten by hand or by the model. */
async function flagPopup(id) {
    const c = ctx();
    const msg = c.chat?.[id];
    if (!isBotMessage(msg)) return;
    const text = msg.mes;
    const hits = findFlags(text);
    if (!hits.length) return toast.ok('ไม่เจอจุดที่ต้องเช็กแล้ว');

    const root = document.createElement('div');
    root.className = 'sg_review';
    root.innerHTML = `
        <h3>เจอจุดที่ต้องเช็ก</h3>
        <small class="sg_note">แก้ข้อความในช่องเป็นคำที่ถูก หรือกดให้ AI แก้ ช่องไหนไม่แก้จะคงไว้ตามเดิม</small>
        <div class="sg_buttons"><div class="menu_button menu_button_icon sg_ai_fix"><i class="fa-solid fa-wand-magic-sparkles"></i> ให้ AI แก้ทุกจุด</div></div>
        ${hits.map((h, i) => {
            const x = contextOf(text, h);
            return `
        <div class="sg_review_rule" data-i="${i}">
            <div class="sg_sample">${esc(x.before)}<mark>${esc(h.text)}</mark>${esc(x.after)}</div>
            <div class="sg_review_head">
                <span class="sg_badge sg_badge_left">${esc(h.rule.name || (h.rule.find.length > 24 ? h.rule.find.slice(0, 24) + '…' : h.rule.find))}</span>
            </div>
            <input type="text" class="text_pole sg_f_fix" value="${esc(h.text)}">
        </div>`;
        }).join('')}`;
    const inputs = [...root.querySelectorAll('.sg_f_fix')];
    const aiBtn = root.querySelector('.sg_ai_fix');
    aiBtn.addEventListener('click', async () => {
        if (aiBtn.classList.contains('disabled')) return;
        const row = aiBtn.parentElement;
        clearError(row);
        aiBtn.classList.add('disabled');
        try {
            const out = await aiRewrite(text, hits);
            if (!out.length) return showError(row, 'AI ไม่ได้ตอบเป็นรายการ', { fix: 'กดอีกครั้ง หรือแก้คำในช่องเอง' });
            out.slice(0, inputs.length).forEach((v, i) => { if (v.trim()) inputs[i].value = v.trim(); });
        } catch (e) {
            console.error(LOG, e);
            const detail = String(e?.message ?? e);
            showError(row, 'ให้ AI แก้ไม่สำเร็จ', { fix: errorFix(detail), detail });
        } finally {
            aiBtn.classList.remove('disabled');
        }
    });
    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'แก้',
        cancelButton: 'ปล่อยไว้',
        wide: true,
        allowVerticalScrolling: true,
    });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return;
    const edits = hits.map((h, i) => ({ ...h, after: inputs[i].value })).filter(e => e.after !== e.text);
    if (!edits.length) return;
    if (c.chat[id] !== msg || msg.mes !== text) return toast.warn('ข้อความเปลี่ยนไประหว่างรอ เลยไม่ได้แก้ให้');
    recordHits(msg, edits);
    writeMessage(id, applyEdits(text, edits));
    await c.saveChat();
    updatePrompt();
    toast.ok(`แก้ ${edits.length} จุด`);
}

/** The last bot reply in the open chat, for /slopflag. */
function lastBotId() {
    const chat = ctx().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) if (isBotMessage(chat[i])) return i;
    return -1;
}

// ---------------------------------------------------------------- ready-made rules

const PRESETS = [
    {
        title: 'ไม่ใช่… แต่…',
        desc: 'โครงสร้าง "ไม่ใช่ X แต่เป็น Y" ที่โมเดลชอบใช้ซ้ำ แจ้งโมเดลเฉพาะตอนเจอบ่อย',
        rule: { find: '/ไม่ใช่[^\\n]{0,40}?(?:หากแต่|แต่)(?:เป็น|คือ)?/', mode: 'prompt', when: 'often', minHits: 2,
            prompt: 'เลี่ยงโครงสร้าง "ไม่ใช่... แต่เป็น..." ให้บอกสิ่งที่เป็นไปตรงๆ' },
    },
    {
        title: 'ราวกับ / เหมือนกับว่า',
        desc: 'การเปรียบเทียบที่ถี่จนเฝือ แจ้งโมเดลเมื่อเจอเฉลี่ยเกินข้อความละครั้ง',
        rule: { find: '/ราวกับ(?:ว่า)?|เหมือนกับว่า|ประหนึ่ง|ดุจดั่ง/', mode: 'prompt', when: 'often', minHits: 7,
            prompt: 'ใช้การเปรียบเทียบด้วย "ราวกับ" ไม่เกินหนึ่งครั้งต่อข้อความ บรรยายสิ่งที่เห็นหรือรู้สึกตรงๆ แทน' },
    },
    {
        title: 'ขีดยาว —',
        desc: 'em dash ที่ภาษาไทยไม่ใช้ แทนด้วยเว้นวรรค',
        rule: { find: '/[ \\t]*—+[ \\t]*/', mode: 'fix', replace: ' ' },
    },
    {
        title: 'เครื่องหมายซ้ำ !! ??',
        desc: 'ตกใจหรือถามซ้อนหลายตัว ให้เหลือตัวเดียว',
        rule: { find: '/([!?！？])\\1+/', mode: 'fix', replace: '$1' },
    },
    {
        title: 'อักษรต่างภาษาหลุด',
        desc: 'อักษรจีน ญี่ปุ่น เกาหลี หรือรัสเซียโผล่กลางข้อความ แจ้งให้แก้เองหรือให้ AI แก้ อย่าใช้กับบอทที่ตั้งใจใช้อักษรพวกนี้',
        rule: { find: '/[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af\\u0400-\\u04ff]+/', mode: 'flag', when: 'often', minHits: 1,
            prompt: 'เขียนเป็นภาษาไทยทั้งหมด ห้ามมีอักษรภาษาอื่นปน' },
    },
    {
        title: 'คำอังกฤษหลุดกลางประโยคไทย',
        desc: 'คำอังกฤษที่อยู่ระหว่างคำไทย แจ้งให้แก้ ชื่อเฉพาะหรือศัพท์ที่ตั้งใจใช้จะโดนด้วย',
        rule: { find: '/(?<=[\\u0E00-\\u0E7F][ \\t]?)[A-Za-z][A-Za-z\'’-]{2,}(?:[ \\t]+[A-Za-z][A-Za-z\'’-]*)*(?=[ \\t]?[\\u0E00-\\u0E7F])/', mode: 'flag' },
    },
];

async function presetPopup() {
    const c = ctx();
    const s = settings();
    const have = new Set(s.rules.map(r => r.find));
    const root = document.createElement('div');
    root.className = 'sg_review';
    root.innerHTML = `
        <h3>กฎสำเร็จรูป</h3>
        <small class="sg_note">ติ๊กกฎที่จะเพิ่ม เพิ่มแล้วแก้ต่อได้ในรายการกฎ</small>
        ${PRESETS.map((p, i) => {
            const added = have.has(p.rule.find);
            return `
        <label class="sg_review_rule${added ? ' sg_off' : ''}">
            <div class="sg_review_head">
                <input type="checkbox" data-i="${i}"${added ? ' disabled' : ''}>
                <b>${esc(p.title)}</b>
                <span class="sg_badge">${added ? 'มีแล้ว' : MODES[p.rule.mode].label}</span>
            </div>
            <small class="sg_note">${esc(p.desc)}</small>
        </label>`;
        }).join('')}`;
    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'เพิ่ม',
        cancelButton: 'ยกเลิก',
        wide: true,
        allowVerticalScrolling: true,
    });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return;
    const picked = [...root.querySelectorAll('input[data-i]:checked')].map(x => PRESETS[Number(x.dataset.i)]);
    if (!picked.length) return;
    for (const p of picked.reverse()) s.rules.unshift(makeRule({ name: p.title, ...p.rule }));
    save();
    renderRules();
    toast.ok(`เพิ่ม ${picked.length} กฎ`);
}

// ---------------------------------------------------------------- AI scan

const SCAN_SYSTEM = `You are an editor hunting a writer's verbal tics.
Read the passages and list up to 8 phrases that occur at least twice and read as clichés or crutches (stock gestures, stock adverbs, stock metaphors).
For each, copy the phrase EXACTLY as it is written in the text — same language, same spelling — and as short as possible while still identifying the tic.
Return ONLY a JSON array, no prose:
[{"phrase": "...", "fix": "...", "alts": ["...", "..."], "rule": "..."}]
- "fix": text that can replace the phrase everywhere and still read naturally; "" if deleting the phrase leaves a correct sentence; null if no single replacement works.
- "alts": 3-6 fresh alternatives with the same meaning that fit the same slot in the sentence (same language, same grammatical role), so they can be rotated in place of the phrase; [] if the phrase should simply go.
- "rule": one short instruction in the same language as the passages telling the writer what to do instead. Describe the alternative; mention the phrase at most once.`;

function stripForScan(text) {
    return text
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, '')
        .trim();
}

function parseScan(raw) {
    const text = String(raw ?? '').replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '');
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a < 0 || b <= a) return [];
    try {
        const arr = JSON.parse(text.slice(a, b + 1));
        return Array.isArray(arr) ? arr.filter(x => x && typeof x.phrase === 'string' && x.phrase.trim()) : [];
    } catch (e) {
        console.warn(LOG, 'scan output is not JSON', text);
        return [];
    }
}

let scanning = false;

async function scanWithAI() {
    if (scanning) return;
    const c = ctx();
    const s = settings();
    const row = $id('sg_scan')?.parentElement;
    clearError(row);
    if (!c.chat?.length) return showError(row, 'ยังไม่ได้เปิดแชท', { fix: 'เปิดแชทที่อยากสแกนก่อน แล้วกดอีกครั้ง' });

    const model = currentModel();
    const family = modelFamily(model);
    let msgs = c.chat.filter(isBotMessage);
    if (s.scanSameModel && model) {
        const same = msgs.filter(m => m.extra?.model && modelFamily(m.extra.model) === family);
        if (same.length >= 5) msgs = same;
    }
    msgs = msgs.slice(-Math.max(5, Number(s.scanCount) || 30));
    let corpus = msgs.map(m => stripForScan(m.mes)).filter(Boolean).join('\n\n---\n\n');
    if (corpus.length > 60000) corpus = corpus.slice(-60000);
    if (corpus.length < 500) return showError(row, 'ข้อความของบอทในแชทนี้ยังน้อยเกินไปสำหรับการสแกน', { fix: 'คุยต่ออีกสักพัก หรือเพิ่ม "สแกนย้อนหลัง" ด้านล่าง' });

    scanning = true;
    const btn = $id('sg_scan');
    btn?.classList.add('disabled');
    toast.info(`กำลังให้ ${model || 'โมเดล'} สแกน ${msgs.length} ข้อความ…`);
    let raw;
    try {
        raw = await c.generateRaw({
            systemPrompt: SCAN_SYSTEM,
            prompt: `<passages>\n${corpus}\n</passages>\n\nReturn the JSON array now.`,
            responseLength: 2500,
        });
    } catch (e) {
        console.error(LOG, e);
        const detail = String(e?.message ?? e);
        showError(row, 'สแกนไม่สำเร็จ', { fix: errorFix(detail), detail });
        toast.warn('สแกนไม่สำเร็จ ดูรายละเอียดใต้ปุ่มสแกน');
        return;
    } finally {
        scanning = false;
        btn?.classList.remove('disabled');
    }

    // Keep only phrases that really occur twice or more and no rule covers yet.
    const existing = s.rules.map(compile).filter(Boolean);
    const seen = new Set();
    const items = [];
    for (const x of parseScan(raw)) {
        const phrase = x.phrase.trim();
        const key = phrase.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const count = (corpus.match(new RegExp(escapeRegex(phrase), 'gi')) ?? []).length;
        if (count < 2) continue;
        if (existing.some(rx => { rx.lastIndex = 0; return rx.test(phrase); })) continue;
        const alts = parsePool(Array.isArray(x.alts) ? x.alts.filter(a => typeof a === 'string') : [])
            .filter(a => a.toLowerCase() !== key);
        items.push({ phrase, count, fix: typeof x.fix === 'string' ? x.fix : null, alts, rule: String(x.rule ?? '') });
    }
    if (!items.length) return toast.ok('ไม่เจอวลีซ้ำใหม่ (หรือมีกฎครอบไว้แล้ว)');
    await addScanResults(items, family);
}

async function addScanResults(items, family) {
    const c = ctx();
    const root = document.createElement('div');
    root.className = 'sg_review';
    root.innerHTML = `
        <h3>วลีที่เจอซ้ำ</h3>
        <small class="sg_note">ติ๊กอันที่จะเพิ่มเป็นกฎ เลือกวิธีจัดการ และแก้ไขได้ก่อนกดเพิ่ม</small>
        ${items.map((it, i) => {
            const mode = it.alts.length ? 'vary' : it.fix !== null ? 'fix' : 'prompt';
            return `
        <div class="sg_review_rule sg_moded sg_mode_${mode}" data-i="${i}">
            <div class="sg_review_head">
                <input type="checkbox" class="sg_pick" checked>
                <input type="text" class="text_pole sg_f_find" value="${esc(it.phrase)}">
                <span class="sg_badge">${it.count} ครั้ง</span>
            </div>
            ${modePickerHtml(`sg_scan_${i}`, mode)}
            <div class="sg_only_fix"><input type="text" class="text_pole sg_f_replace" placeholder="แทนด้วย (ว่าง = ลบทิ้ง)" value="${esc(it.fix ?? '')}"></div>
            <div class="sg_only_vary"><textarea class="text_pole sg_f_pool" rows="3" placeholder="คลังคำ บรรทัดละคำ">${esc(it.alts.join('\n'))}</textarea></div>
            <small class="sg_field_label">กฎใน prompt (ไม่ใส่ก็ได้)</small>
            <input type="text" class="text_pole sg_f_models" placeholder="โมเดลที่ได้กฎนี้ (ว่าง = ทุกโมเดล)" value="${esc(family)}">
            <textarea class="text_pole sg_f_prompt" rows="2" placeholder="คำสั่งถึงโมเดล">${esc(it.rule)}</textarea>
        </div>`;
        }).join('')}`;
    root.querySelectorAll('.sg_review_rule').forEach(el => bindModePicker(el));
    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'เพิ่มเป็นกฎ',
        cancelButton: 'ยกเลิก',
        wide: true,
        allowVerticalScrolling: true,
    });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return;

    const s = settings();
    let added = 0;
    for (const el of root.querySelectorAll('.sg_review_rule')) {
        if (!el.querySelector('.sg_pick').checked) continue;
        const find = el.querySelector('.sg_f_find').value.trim();
        if (!find) continue;
        s.rules.push(makeRule({
            find,
            mode: pickedMode(el),
            replace: el.querySelector('.sg_f_replace').value,
            models: el.querySelector('.sg_f_models').value.trim(),
            prompt: el.querySelector('.sg_f_prompt').value.trim(),
            pool: el.querySelector('.sg_f_pool').value,
        }));
        added++;
    }
    if (!added) return;
    save();
    renderRules();
    toast.ok(`เพิ่ม ${added} กฎ`);
}

// ---------------------------------------------------------------- AI: alternatives for a pool

const POOL_SYSTEM = `You help a fiction writer vary a phrase they overuse.
You get the phrase and some sentences where it appears. Suggest up to 10 alternatives that keep the meaning and fit the SAME slot, so that putting any of them in place of the phrase leaves a natural, grammatical sentence.
- Write in the same language as the phrase.
- Keep the grammatical role: an adverb for an adverb, a clause for a clause, a verb phrase for a verb phrase.
- Each alternative replaces the whole quoted phrase.
- Make them genuinely different from one another in wording and imagery. Avoid near-duplicates, and avoid alternatives that are worn-out clichés themselves.
Return ONLY a JSON array of strings, no prose.`;

/** Up to `max` places in the chat where the rule matches, with some text around each. */
function sampleContexts(rule, max = 5) {
    const rx = compile(rule);
    const c = ctx();
    if (!rx || !c.chat?.length) return [];
    const out = [];
    for (let i = c.chat.length - 1; i >= 0 && out.length < max; i--) {
        const m = c.chat[i];
        if (!isBotMessage(m)) continue;
        const text = stripForScan(m.mes);
        for (const hit of text.matchAll(rx)) {
            if (!hit[0] || out.length >= max) continue;
            const start = Math.max(0, hit.index - 70);
            const end = Math.min(text.length, hit.index + hit[0].length + 70);
            out.push({
                match: hit[0],
                before: text.slice(start, hit.index).replace(/\s+/g, ' '),
                after: text.slice(hit.index + hit[0].length, end).replace(/\s+/g, ' '),
            });
        }
    }
    return out;
}

function parseStringList(raw) {
    const text = String(raw ?? '').replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '');
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a < 0 || b <= a) return [];
    try {
        const arr = JSON.parse(text.slice(a, b + 1));
        if (!Array.isArray(arr)) return [];
        return arr.map(x => typeof x === 'string' ? x : x?.phrase ?? x?.text ?? '').filter(x => typeof x === 'string');
    } catch {
        console.warn(LOG, 'pool suggestions are not JSON', text);
        return [];
    }
}

const suggesting = new Set(); // rule ids with a request in flight

/** Asks the current model for alternatives to a rule's phrase and lets the user pick which go into its pool. */
async function suggestPool(rule, button) {
    if (suggesting.has(rule.id)) return;
    const row = button?.parentElement;
    clearError(row);
    if (!rule.find.trim()) return showError(row, 'ยังไม่มีคำในช่อง "หา"', { fix: 'ใส่วลีที่อยากหาคำแทนก่อน แล้วกดอีกครั้ง' });
    const c = ctx();
    const isRegex = /^\/[\s\S]+\/[dgimsuvy]*$/.test(rule.find);
    const samples = sampleContexts(rule);
    const phrase = (samples[0]?.match ?? rule.find).trim();
    if (isRegex && !samples.length) return showError(row, 'กฎนี้เป็น regex และยังไม่เจอในแชทนี้ เลยไม่รู้ว่าคำจริงคืออะไร', { fix: 'เปิดแชทที่มีคำนี้ก่อน แล้วกดอีกครั้ง' });

    const lines = [`Phrase: "${phrase}"`];
    if (isRegex) lines.push(`(It is one match of the pattern ${rule.find}; alternatives replace the whole match.)`);
    if (rule.pool.length) lines.push(`Already in the pool, do not repeat: ${rule.pool.map(x => `"${x}"`).join(', ')}`);
    lines.push(samples.length
        ? `Sentences where it appears (the phrase is between ⟦ ⟧):\n${samples.map(x => `- …${x.before}⟦${x.match}⟧${x.after}…`).join('\n')}`
        : 'No example sentences are available; assume ordinary narrative prose.');
    lines.push('', 'Return the JSON array now.');

    suggesting.add(rule.id);
    const icon = button?.querySelector('i');
    button?.classList.add('disabled');
    icon?.classList.replace('fa-wand-magic-sparkles', 'fa-spinner');
    icon?.classList.add('fa-spin');
    let raw;
    try {
        raw = await c.generateRaw({ systemPrompt: POOL_SYSTEM, prompt: lines.join('\n'), responseLength: 800 });
    } catch (e) {
        console.error(LOG, e);
        const detail = String(e?.message ?? e);
        return showError(row, 'ขอคำจาก AI ไม่สำเร็จ', { fix: errorFix(detail), detail });
    } finally {
        suggesting.delete(rule.id);
        button?.classList.remove('disabled');
        icon?.classList.remove('fa-spin');
        icon?.classList.replace('fa-spinner', 'fa-wand-magic-sparkles');
    }

    const known = new Set([phrase, ...rule.pool].map(x => x.toLowerCase()));
    const list = parsePool(parseStringList(raw)).filter(x => !known.has(x.toLowerCase()));
    if (!list.length) return showError(row, 'AI ไม่ได้เสนอคำใหม่', { fix: 'กดอีกครั้ง หรือพิมพ์คำลงคลังเอง' });
    await pickPoolSuggestions(rule, list, samples[0] ?? null);
}

async function pickPoolSuggestions(rule, list, sample) {
    const c = ctx();
    const preview = alt => sample
        ? `…${esc(sample.before)}<ins>${esc(alt)}</ins>${esc(sample.after)}…`
        : `<ins>${esc(alt)}</ins>`;
    const root = document.createElement('div');
    root.className = 'sg_review';
    root.innerHTML = `
        <h3>คำหลากคำสำหรับ <code>${esc(sample?.match ?? rule.find)}</code></h3>
        <small class="sg_note">ติ๊กคำที่จะใส่ในคลัง แก้คำได้ก่อนกดเพิ่ม · ตัวอย่างใต้แต่ละคำคือประโยคจากแชทนี้เมื่อใช้คำนั้นแทน</small>
        ${list.map((alt, i) => `
        <div class="sg_review_rule" data-i="${i}">
            <div class="sg_review_head">
                <input type="checkbox" class="sg_pick" checked>
                <input type="text" class="text_pole sg_f_find" value="${esc(alt)}">
            </div>
            <div class="sg_sample">${preview(alt)}</div>
        </div>`).join('')}`;
    for (const el of root.querySelectorAll('.sg_review_rule')) {
        const input = el.querySelector('.sg_f_find');
        input.addEventListener('input', () => { el.querySelector('.sg_sample').innerHTML = preview(input.value); });
    }
    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'เพิ่มลงคลัง',
        cancelButton: 'ยกเลิก',
        wide: true,
        allowVerticalScrolling: true,
    });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return;
    const picked = [...root.querySelectorAll('.sg_review_rule')]
        .filter(el => el.querySelector('.sg_pick').checked)
        .map(el => el.querySelector('.sg_f_find').value);
    const before = rule.pool.length;
    rule.pool = parsePool([...rule.pool, ...picked]);
    const added = rule.pool.length - before;
    if (!added) return;
    const switched = rule.mode !== 'vary';
    rule.mode = 'vary';
    save();
    renderRules();
    toast.ok(`เพิ่ม ${added} คำลงคลัง${switched ? ' และเปลี่ยนกฎนี้เป็นแบบหลากคำแล้ว' : ''}`);
}

// ---------------------------------------------------------------- import / export

function exportRules() {
    const data = JSON.stringify({ slopGuard: VERSION, rules: settings().rules }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'slop-guard-rules.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importRules(file) {
    const reader = new FileReader();
    reader.onload = () => {
        let list;
        try {
            const data = JSON.parse(String(reader.result));
            list = Array.isArray(data) ? data : data?.rules;
        } catch { /* handled below */ }
        if (!Array.isArray(list)) return toast.warn('ไฟล์ไม่ใช่รายการกฎของ Slop Guard');
        const s = settings();
        const have = new Set(s.rules.map(r => r.find));
        let added = 0;
        for (const x of list) {
            const r = typeof x === 'string' ? makeRule({ find: x }) : makeRule({ ...x, id: undefined });
            if (!r.find.trim() || have.has(r.find)) continue;
            s.rules.push(r);
            have.add(r.find);
            added++;
        }
        save();
        renderRules();
        toast.ok(added ? `นำเข้า ${added} กฎ` : 'ไม่มีกฎใหม่ในไฟล์');
    };
    reader.readAsText(file);
}

// ---------------------------------------------------------------- mode picker (rule cards and scan popup)

/** Three buttons for fix / vary / prompt; the container's sg_mode_* class shows the matching fields. */
function modePickerHtml(name, mode) {
    return `<div class="sg_modes" role="radiogroup">${Object.entries(MODES).map(([k, m]) => `
        <label class="sg_mode_opt${k === mode ? ' sg_sel' : ''}" title="${esc(m.desc)}"><input type="radio" name="${esc(name)}" value="${k}"${k === mode ? ' checked' : ''}><span>${m.label}</span></label>`).join('')}
    </div>
    <small class="sg_note sg_mode_desc">${esc(MODES[mode].desc)}</small>`;
}

function setModeClass(el, mode) {
    for (const k of Object.keys(MODES)) el.classList.toggle(`sg_mode_${k}`, k === mode);
    el.querySelectorAll('.sg_mode_opt').forEach(o => o.classList.toggle('sg_sel', o.querySelector('input').value === mode));
    const desc = el.querySelector('.sg_mode_desc');
    if (desc) desc.textContent = MODES[mode].desc;
}

function bindModePicker(el, onChange) {
    el.querySelectorAll('.sg_modes input').forEach(input => input.addEventListener('change', () => {
        if (!input.checked) return;
        setModeClass(el, input.value);
        onChange?.(input.value);
    }));
}

const pickedMode = el => el.querySelector('.sg_modes input:checked')?.value ?? 'fix';

// ---------------------------------------------------------------- settings UI

function renderSettings() {
    const host = $id('extensions_settings2') ?? $id('extensions_settings');
    if (!host || $id('sg_settings')) return;
    host.insertAdjacentHTML('beforeend', `
    <div id="sg_settings" class="sg_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Slop Guard <small class="sg_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                ${versionLineHtml()}
                <label class="checkbox_label"><input type="checkbox" id="sg_enabled"> เปิดใช้ Slop Guard</label>
                <label class="checkbox_label"><input type="checkbox" id="sg_ask"> ถามก่อนแก้ข้อความของบอท (popup)</label>
                <div class="sg_row">
                    <label for="sg_cooldown" title="คำเดิมหรือคำในคลังที่เพิ่งใช้ จะไม่ถูกใช้ซ้ำจนกว่าจะผ่านไปกี่ข้อความของบอท">คูลดาวน์ของกฎหลากคำ</label>
                    <input type="number" id="sg_cooldown" class="text_pole sg_num" min="1" max="100">
                    <span>ข้อความ</span>
                </div>
                <label class="checkbox_label"><input type="checkbox" id="sg_inject"> ใส่กฎลงใน prompt (เฉพาะกฎของโมเดลที่ใช้อยู่)</label>
                <div class="sg_row">
                    <label for="sg_depth">depth</label>
                    <input type="number" id="sg_depth" class="text_pole sg_num" min="0" max="100">
                    <label for="sg_role">role</label>
                    <select id="sg_role" class="text_pole">
                        <option value="0">System</option>
                        <option value="1">User</option>
                        <option value="2">Assistant</option>
                    </select>
                </div>
                <small class="sg_note" id="sg_model_line"></small>
                <hr class="sysHR">
                <b class="sg_section">ตรวจรูปแบบซ้ำ</b>
                <small class="sg_note">ถ้าข้อความล่าสุดทำแบบเดียวกันซ้ำ จะใส่คำเตือนใน prompt ให้เขียนต่างออกไป เฉพาะตอนที่เจอ</small>
                <label class="checkbox_label"><input type="checkbox" id="sg_pat_opening"> ขึ้นต้นข้อความคล้ายกัน</label>
                <label class="checkbox_label"><input type="checkbox" id="sg_pat_closing"> ลงท้ายข้อความคล้ายกัน</label>
                <label class="checkbox_label"><input type="checkbox" id="sg_pat_question"> จบข้อความด้วยคำถาม</label>
                <div class="sg_row">
                    <label for="sg_pat_min">เตือนเมื่อเจอ</label>
                    <input type="number" id="sg_pat_min" class="text_pole sg_num" min="2" max="20">
                    <label for="sg_watch">ใน</label>
                    <input type="number" id="sg_watch" class="text_pole sg_num" min="2" max="50">
                    <span>ข้อความล่าสุด</span>
                </div>
                <small class="sg_note" id="sg_pattern_line"></small>
                <hr class="sysHR">
                <div class="sg_buttons">
                    <div class="menu_button menu_button_icon" id="sg_add"><i class="fa-solid fa-plus"></i> เพิ่มกฎ</div>
                    <div class="menu_button menu_button_icon" id="sg_presets" title="กฎที่ใช้บ่อย เช่น ไม่ใช่…แต่… อักษรต่างภาษาหลุด"><i class="fa-solid fa-box-open"></i> กฎสำเร็จรูป</div>
                    <div class="menu_button menu_button_icon" id="sg_scan" title="ให้โมเดลที่ใช้อยู่หาวลีที่ซ้ำในแชทนี้"><i class="fa-solid fa-magnifying-glass"></i> สแกนแชทด้วย AI</div>
                    <div class="menu_button menu_button_icon" id="sg_clean" title="ใช้กฎกับทุกข้อความของบอทในแชทนี้"><i class="fa-solid fa-broom"></i> ล้างทั้งแชท</div>
                    <div class="menu_button menu_button_icon" id="sg_import"><i class="fa-solid fa-file-import"></i> นำเข้า</div>
                    <div class="menu_button menu_button_icon" id="sg_export"><i class="fa-solid fa-file-export"></i> ส่งออก</div>
                    <input type="file" id="sg_import_file" accept=".json,application/json" hidden>
                </div>
                <div class="sg_row">
                    <label for="sg_scan_count">สแกนย้อนหลัง</label>
                    <input type="number" id="sg_scan_count" class="text_pole sg_num" min="5" max="200">
                    <span>ข้อความ</span>
                    <label class="checkbox_label"><input type="checkbox" id="sg_scan_same"> เฉพาะที่โมเดลเดียวกันเขียน</label>
                </div>
                <small class="sg_note">แต่ละกฎเลือกวิธีจัดการเอง: <b>แก้คำผิด</b> ลบหรือแทนที่ทุกครั้ง · <b>หลากคำ</b> สุ่มคำจากคลังมาแทนเมื่อใช้ซ้ำ · <b>แจ้งเตือน</b> ชี้จุดให้แก้เองหรือให้ AI แก้ · <b>แค่ prompt</b> ไม่แก้ข้อความ · ช่อง "หา" ใส่วลีตรงๆ หรือ <code>/regex/</code> · การแก้ข้อความใช้กับทุกโมเดล ช่องโมเดลมีผลแค่กับกฎใน prompt</small>
                <div id="sg_rules" class="sg_rules"></div>
            </div>
        </div>
    </div>`);

    const s = settings();
    const bindCheck = (id, key) => $id(id).addEventListener('change', e => { s[key] = e.target.checked; save(); });
    bindCheck('sg_enabled', 'enabled');
    bindCheck('sg_inject', 'inject');
    bindCheck('sg_scan_same', 'scanSameModel');
    $id('sg_ask').addEventListener('change', e => { s.mode = e.target.checked ? 'ask' : 'auto'; save(); });
    for (const k of Object.keys(PATTERN_TEXT)) {
        $id(`sg_pat_${k}`).addEventListener('change', e => { s.patterns = { ...s.patterns, [k]: e.target.checked }; save(); });
    }
    $id('sg_pat_min').addEventListener('change', e => { s.patternMin = Math.max(2, Number(e.target.value) || DEFAULTS.patternMin); e.target.value = String(s.patternMin); save(); });
    $id('sg_watch').addEventListener('change', e => { s.watchWindow = Math.max(2, Number(e.target.value) || DEFAULTS.watchWindow); e.target.value = String(s.watchWindow); save(); renderRules(); });
    $id('sg_presets').addEventListener('click', presetPopup);
    $id('sg_role').addEventListener('change', e => { s.role = Number(e.target.value); save(); });
    $id('sg_depth').addEventListener('change', e => { s.depth = Math.max(0, Number(e.target.value) || 0); save(); });
    $id('sg_scan_count').addEventListener('change', e => { s.scanCount = Math.max(5, Number(e.target.value) || 30); save(); });
    $id('sg_cooldown').addEventListener('change', e => { s.cooldown = Math.max(1, Number(e.target.value) || DEFAULTS.cooldown); e.target.value = String(s.cooldown); save(); renderRules(); });

    $id('sg_add').addEventListener('click', () => {
        s.rules.unshift(makeRule());
        save();
        renderRules();
        $id('sg_rules').querySelector('.sg_f_find')?.focus();
    });
    $id('sg_scan').addEventListener('click', scanWithAI);
    $id('sg_clean').addEventListener('click', cleanWholeChat);
    $id('sg_export').addEventListener('click', exportRules);
    $id('sg_import').addEventListener('click', () => $id('sg_import_file').click());
    $id('sg_import_file').addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (file) importRules(file);
        e.target.value = '';
    });

    syncSettingsUi();
    renderRules();
}

function syncSettingsUi() {
    if (!$id('sg_settings')) return;
    const s = settings();
    $id('sg_enabled').checked = !!s.enabled;
    $id('sg_inject').checked = !!s.inject;
    $id('sg_scan_same').checked = !!s.scanSameModel;
    $id('sg_ask').checked = s.mode === 'ask';
    for (const k of Object.keys(PATTERN_TEXT)) $id(`sg_pat_${k}`).checked = !!s.patterns?.[k];
    $id('sg_pat_min').value = String(s.patternMin);
    $id('sg_watch').value = String(s.watchWindow);
    $id('sg_role').value = String(s.role);
    $id('sg_depth').value = String(s.depth);
    $id('sg_scan_count').value = String(s.scanCount);
    $id('sg_cooldown').value = String(s.cooldown);
    syncModelLine();
}

function syncModelLine() {
    const el = $id('sg_model_line');
    if (!el) return;
    const s = settings();
    const model = currentModel();
    const recent = recentReplies(Math.max(1, Number(s.watchWindow) || DEFAULTS.watchWindow));
    const mine = s.rules.filter(r => r.enabled && r.prompt.trim() && modelMatches(r, model));
    const active = promptRules(model, recent).length;
    const waiting = mine.length - active;
    el.textContent = model
        ? `โมเดลตอนนี้: ${model} · กฎใน prompt ที่ใส่อยู่ ${active} ข้อ${waiting ? ` (อีก ${waiting} ข้อรอให้เจอบ่อยก่อน)` : ''}`
        : 'ยังไม่ได้เชื่อมต่อโมเดล';

    const pl = $id('sg_pattern_line');
    if (!pl) return;
    const st = patternState();
    if (!st.total) { pl.textContent = 'ยังไม่มีข้อความของบอทในแชทนี้'; return; }
    const min = Math.max(2, Number(s.patternMin) || DEFAULTS.patternMin);
    pl.innerHTML = 'ตอนนี้: ' + Object.entries(PATTERN_TEXT).map(([k, t]) => {
        const n = st[k].count;
        const on = s.patterns?.[k] && n >= min;
        return `<span class="${on ? 'sg_stale' : ''}">${t.label} ${n}/${st.total}${on ? ' <i class="fa-solid fa-triangle-exclamation"></i>' : ''}</span>`;
    }).join(' · ');
}

/** Pools smaller than this let alternatives come back before the cooldown ends. */
const poolTarget = () => 2 * Math.max(1, Number(settings().cooldown) || DEFAULTS.cooldown);

/** What, if anything, keeps a rule from doing its job well. */
function ruleHint(rule) {
    if (rule.mode === 'vary') {
        const n = rule.pool.length;
        if (!n) return 'คลังยังว่าง กฎนี้ยังไม่แก้อะไร ใส่คำเอง หรือกด AI ช่วยคิดคำ';
        const want = poolTarget();
        if (n < want) return `คลังมี ${n} คำ ถ้าคำนี้โผล่บ่อย คำในคลังจะวนกลับมาก่อนหมดคูลดาวน์ ควรมีอย่างน้อย ${want} คำ`;
    }
    if (rule.mode === 'prompt' && !rule.prompt.trim()) return 'ยังไม่ได้เขียนกฎใน prompt กฎนี้เลยยังไม่ทำอะไร';
    return '';
}

function renderRules() {
    const box = $id('sg_rules');
    if (!box) return;
    const s = settings();
    if (!s.rules.length) {
        box.innerHTML = '<small class="sg_note">ยังไม่มีกฎ</small>';
        syncModelLine();
        return;
    }
    box.innerHTML = s.rules.map(r => `
        <div class="sg_rule sg_moded sg_mode_${r.mode}${r.enabled ? '' : ' sg_off'}" data-id="${esc(r.id)}">
            ${r.name ? `<b class="sg_rule_name">${esc(r.name)}</b>` : ''}
            <div class="sg_rule_head">
                <input type="checkbox" class="sg_f_enabled" title="เปิดใช้กฎนี้" ${r.enabled ? 'checked' : ''}>
                <input type="text" class="text_pole sg_f_find${r.find.trim() && !compile(r) ? ' sg_invalid' : ''}" placeholder="หา: วลี หรือ /regex/" value="${esc(r.find)}">
                <div class="menu_button fa-solid fa-trash-can sg_f_delete" title="ลบกฎ"></div>
            </div>
            ${modePickerHtml(`sg_m_${r.id}`, r.mode)}
            <small class="sg_note sg_rule_hint"${ruleHint(r) ? '' : ' hidden'}>${esc(ruleHint(r))}</small>
            <div class="sg_only_fix">
                <input type="text" class="text_pole sg_f_replace" placeholder="แทนด้วย (ว่าง = ลบทิ้ง)" value="${esc(r.replace)}">
            </div>
            <div class="sg_only_vary">
                <textarea class="text_pole sg_f_pool" rows="${Math.min(5, Math.max(2, r.pool.length))}" placeholder="คลังคำ ความหมายเดียวกัน บรรทัดละคำ">${esc(r.pool.join('\n'))}</textarea>
                <div class="sg_row sg_pool_row">
                    <label class="checkbox_label" title="คำเดิมผ่านได้หนึ่งครั้ง แล้วติดคูลดาวน์ ไม่ติ๊ก = แทนทุกครั้ง"><input type="checkbox" class="sg_f_allow" ${r.allowFirst ? 'checked' : ''}> ให้คำเดิมผ่านครั้งแรก</label>
                    <div class="menu_button menu_button_icon sg_f_suggest" title="ให้โมเดลที่ใช้อยู่ช่วยคิดคำความหมายเดียวกัน"><i class="fa-solid fa-wand-magic-sparkles"></i> AI ช่วยคิดคำ</div>
                </div>
            </div>
            <small class="sg_field_label">กฎใน prompt <span class="sg_optional">(ไม่ใส่ก็ได้)</span></small>
            <input type="text" class="text_pole sg_f_models" placeholder="โมเดลที่ได้กฎนี้ เช่น gemini (ว่าง = ทุกโมเดล)" value="${esc(r.models)}">
            <textarea class="text_pole sg_f_prompt" rows="2" placeholder="คำสั่งถึงโมเดล">${esc(r.prompt)}</textarea>
            <div class="sg_row sg_when_row">
                <label class="checkbox_label" title="ไม่ติ๊ก = ใส่ตลอด"><input type="checkbox" class="sg_f_often" ${r.when === 'often' ? 'checked' : ''}> ใส่เฉพาะตอนเจอบ่อย:</label>
                <input type="number" class="text_pole sg_num sg_f_minhits" min="1" max="99" value="${r.minHits}">
                <span>ครั้งขึ้นไป ใน ${Number(s.watchWindow) || DEFAULTS.watchWindow} ข้อความล่าสุด</span>
            </div>
        </div>`).join('');

    for (const el of box.querySelectorAll('.sg_rule')) {
        const rule = s.rules.find(r => r.id === el.dataset.id);
        const refreshHint = () => {
            const hint = el.querySelector('.sg_rule_hint');
            hint.textContent = ruleHint(rule);
            hint.hidden = !hint.textContent;
        };
        const field = (cls, key, prop = 'value') => el.querySelector(cls).addEventListener('change', e => {
            rule[key] = key === 'pool' ? parsePool(e.target.value) : e.target[prop];
            if (key === 'enabled') el.classList.toggle('sg_off', !rule.enabled);
            if (key === 'find' || key === 'replace') {
                el.querySelector('.sg_f_find').classList.toggle('sg_invalid', !!rule.find.trim() && !compile(rule));
            }
            refreshHint();
            save();
            syncModelLine();
        });
        field('.sg_f_enabled', 'enabled', 'checked');
        field('.sg_f_find', 'find');
        field('.sg_f_replace', 'replace');
        field('.sg_f_models', 'models');
        field('.sg_f_prompt', 'prompt');
        field('.sg_f_pool', 'pool');
        field('.sg_f_allow', 'allowFirst', 'checked');
        el.querySelector('.sg_f_often').addEventListener('change', e => { rule.when = e.target.checked ? 'often' : 'always'; save(); });
        el.querySelector('.sg_f_minhits').addEventListener('change', e => {
            rule.minHits = Math.max(1, Math.round(Number(e.target.value)) || 2);
            e.target.value = String(rule.minHits);
            save();
        });
        bindModePicker(el, mode => {
            rule.mode = mode;
            el.querySelector('.sg_f_find').classList.toggle('sg_invalid', !!rule.find.trim() && !compile(rule));
            refreshHint();
            save();
        });
        el.querySelector('.sg_f_suggest').addEventListener('click', e => suggestPool(rule, e.currentTarget));
        el.querySelector('.sg_f_delete').addEventListener('click', () => {
            s.rules = s.rules.filter(r => r !== rule);
            save();
            renderRules();
        });
    }
    syncModelLine();
}

// ---------------------------------------------------------------- slash command

function registerCommand() {
    const { SlashCommandParser, SlashCommand } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'slopclean',
        callback: async () => { await cleanWholeChat(); return ''; },
        helpString: 'Slop Guard — ใช้กฎกับทุกข้อความของบอทในแชทนี้ (แก้คำผิดและหลากคำ) โดยถามก่อน',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'slopflag',
        callback: async () => {
            const id = lastBotId();
            if (id < 0) toast.warn('ยังไม่มีข้อความของบอท');
            else await flagPopup(id);
            return '';
        },
        helpString: 'Slop Guard — ดูจุดที่กฎแบบแจ้งเตือนเจอในข้อความล่าสุดของบอท แล้วแก้เองหรือให้ AI แก้',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'slopscan',
        callback: async () => { await scanWithAI(); return ''; },
        helpString: 'Slop Guard — ให้โมเดลที่ใช้อยู่หาวลีที่ซ้ำในแชทนี้ แล้วเลือกเพิ่มเป็นกฎ',
    }));
}

// ---------------------------------------------------------------- version check + hard refresh
//
// SillyTavern loads extension files by a fixed URL, and browsers (and home-screen web apps on
// iOS, which rarely reload for real) keep the old files cached after "Update". Compare with the
// manifest on the server; if it is newer, say so, and offer to refetch every file and reload.

const BASE_URL = new URL('.', import.meta.url);
/** Every file of the extension, so a hard refresh can replace all of them in the browser cache. */
const FILES = ['index.js', 'theme-palette.js', 'style.css', 'manifest.json'];
let remoteVersion = '';
let versionCheckedAt = 0;
let versionToastShown = false;
const newerVersion = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
};
async function fetchRemoteVersion() {
    try {
        const res = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        if (!res.ok) return '';
        return String((await res.json())?.version ?? '');
    } catch { return ''; }
}
/** The "running vX · installed vY" line with its two buttons; put it anywhere in the UI. */
function versionLineHtml() {
    return `<div class="sg_verline">ที่รันอยู่: <b>v${VERSION}</b> <span data-sg-remote></span>
        <div class="sg_verbtns"><div class="menu_button" data-sg-check><i class="fa-solid fa-rotate"></i> เช็คเวอร์ชัน</div><div class="menu_button" data-sg-reload><i class="fa-solid fa-cloud-arrow-down"></i> โหลดเวอร์ชันล่าสุด</div></div></div>`;
}
function showRemoteVersion(scope = document) {
    const stale = remoteVersion && newerVersion(remoteVersion, VERSION);
    scope.querySelectorAll('[data-sg-remote]').forEach(el => {
        el.innerHTML = !remoteVersion ? '' : stale
            ? `· ติดตั้งไว้ <b>v${esc(remoteVersion)}</b> <span class="sg_stale">ยังไม่ได้โหลด กด “โหลดเวอร์ชันล่าสุด”</span>`
            : '· เป็นเวอร์ชันล่าสุดที่ติดตั้งไว้แล้ว';
    });
}
async function checkForNewVersion(force = false) {
    if (!force && Date.now() - versionCheckedAt < 10 * 60_000) return remoteVersion;
    versionCheckedAt = Date.now();
    remoteVersion = await fetchRemoteVersion();
    showRemoteVersion();
    if (remoteVersion && newerVersion(remoteVersion, VERSION) && !versionToastShown) {
        versionToastShown = true;
        globalThis.toastr?.info(`ติดตั้ง v${esc(remoteVersion)} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION} อยู่<br>แตะที่นี่เพื่อโหลดเวอร์ชันใหม่`, 'Slop Guard', {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: () => reloadWithFreshFiles(),
        });
    }
    return remoteVersion;
}
async function reloadWithFreshFiles() {
    try {
        globalThis.toastr?.info('กำลังดึงไฟล์ใหม่…', 'Slop Guard', { timeOut: 2000 });
        // cache: 'reload' fetches from the server and overwrites the browser's cached copy,
        // so the page reload below runs the new files
        await Promise.all(FILES.map(f => fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
    } finally {
        location.reload();
    }
}
function watchVersion() {
    document.addEventListener('click', e => {
        const t = e.target instanceof Element ? e.target : null;
        if (t?.closest('[data-sg-reload]')) reloadWithFreshFiles();
        else if (t?.closest('[data-sg-check]')) checkForNewVersion(true);
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForNewVersion(); });
    setTimeout(() => checkForNewVersion(true), 3000);
}

// ---------------------------------------------------------------- boot

function start() {
    settings();
    // readable colors on every theme: state and diff colors keep their hue but contrast with the panel
    try {
        installThemePalette({ prefix: 'sg', colors: { del: '#e05555', ins: '#4caf7a', notice: '#f5a524' } });
    } catch (err) { console.warn(LOG, 'theme palette', err); }
    renderSettings();
    watchVersion();
    registerCommand();
    updatePrompt();
}

(function init() {
    const { eventSource, event_types: E } = ctx();
    eventSource.on(E.MESSAGE_RECEIVED, onMessageReceived);
    // Re-check the model right before every prompt is built: the model can be
    // switched from many places (connection profiles, slash commands, ...).
    eventSource.on(E.GENERATION_STARTED, () => updatePrompt());
    eventSource.on(E.CHAT_CHANGED, () => { updatePrompt(); checkForNewVersion(); });
    for (const ev of [E.MESSAGE_EDITED, E.MESSAGE_DELETED, E.MESSAGE_SWIPED]) if (ev) eventSource.on(ev, () => updatePrompt());
    if (E.CHATCOMPLETION_MODEL_CHANGED) eventSource.on(E.CHATCOMPLETION_MODEL_CHANGED, () => { updatePrompt(); syncModelLine(); });
    if (E.ONLINE_STATUS_CHANGED) eventSource.on(E.ONLINE_STATUS_CHANGED, () => { updatePrompt(); syncModelLine(); });
    if (E.MAIN_API_CHANGED) eventSource.on(E.MAIN_API_CHANGED, () => { updatePrompt(); syncModelLine(); });
    eventSource.once(E.APP_READY, start);
})();
