/*
 * Slop Guard — SillyTavern UI extension
 *
 * Keeps a list of phrases a model keeps falling back on ("อย่างถือสิทธิ์" from
 * Gemini, "หัวเราะแห้งแล้ง" from DeepSeek, ...) and deals with them two ways:
 *   • Prompt rule — each rule can carry an instruction that is injected at a
 *     chat depth, but only while a model the rule is scoped to is selected, so
 *     one model never gets shown another model's tics. The injection goes
 *     through setExtensionPrompt, so it works with any preset.
 *   • Removal — when a reply arrives, matches are replaced or deleted in the
 *     saved message itself (after a confirmation popup, or automatically), so
 *     the phrase never lands in the history the model reads back.
 * A scan asks the current model to find repeated phrases in the chat and
 * offers them as new rules.
 */

const MODULE = 'slop_guard';
const PROMPT_KEY = 'slop_guard';
const LOG = '[SlopGuard]';
const VERSION = '1.0.0'; // keep in sync with manifest.json

const IN_CHAT = 1; // extension_prompt_types.IN_CHAT

const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'ask', // ask | auto | off — what to do with matches in a new reply
    inject: true,
    depth: 1,
    role: 0, // extension_prompt_roles: 0 system, 1 user, 2 assistant
    header: '[สไตล์การเขียน]',
    scanCount: 30,
    scanSameModel: true,
});

const SEED_RULES = [
    {
        find: '/\\s?(?:อย่าง|ด้วยท่าที|ด้วยท่าทาง)(?:ถือสิทธิ์?|ถือสิทธ์|เป็นเจ้าของ|แสดงความเป็นเจ้าของ|ครอบครอง|อ้างสิทธิ์?)/g',
        replace: '',
        models: 'gemini',
        prompt: 'ห้ามต่อท้ายกริยาด้วย "อย่างถือสิทธิ์" หรือ "อย่างเป็นเจ้าของ" ถ้าจะสื่อความหวง ให้แสดงผ่านการกระทำหรือบทพูด เช่น ดึงเข้ามาใกล้ ไม่ยอมปล่อยมือ',
    },
    {
        find: '/(หัวเราะ(?:ออกมา)?)\\s?(?:อย่าง)?แห้งแล้ง/g',
        replace: '$1',
        models: 'deepseek',
        prompt: 'ห้ามใช้ "หัวเราะแห้งแล้ง" ถ้าตัวละครหัวเราะแบบฝืน ให้แสดงผ่านสิ่งที่ทำต่อ เช่น เบือนหน้า พูดเปลี่ยนเรื่อง หรือเสียงที่ขาดห้วน',
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

function makeRule(r = {}) {
    return {
        id: r.id || newId(),
        enabled: r.enabled !== false,
        find: String(r.find ?? ''),
        replace: String(r.replace ?? ''),
        remove: r.remove !== false,
        models: String(r.models ?? ''),
        prompt: String(r.prompt ?? ''),
    };
}

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = v;
    }
    if (!Array.isArray(s.rules)) s.rules = SEED_RULES.map(makeRule);
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

const compiled = new Map(); // `${find}\u0000${replace}` -> RegExp | null

/**
 * "/body/flags" is a regex (g is always added). Anything else is a literal phrase;
 * when it is deleted (empty replacement) one space before it goes too, so
 * "held her possessively close" becomes "held her close".
 */
function compile(rule) {
    const key = `${rule.find}\u0000${rule.replace}`;
    if (compiled.has(key)) return compiled.get(key);
    let rx = null;
    const m = rule.find.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
    try {
        if (m) {
            rx = new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
        } else if (rule.find.trim()) {
            const body = escapeRegex(rule.find.trim());
            rx = new RegExp(rule.replace === '' ? `[ \\t]?${body}` : body, 'g');
        }
    } catch (e) {
        console.warn(LOG, 'invalid pattern', rule.find, e);
        rx = null;
    }
    compiled.set(key, rx);
    return rx;
}

/** @returns {{rule, matches: {index:number, text:string, after:string}[]}[]} */
function findHits(text, rules) {
    const hits = [];
    for (const rule of rules) {
        const rx = compile(rule);
        if (!rx) continue;
        const matches = [];
        const single = new RegExp(rx.source, rx.flags.replace('g', ''));
        for (const m of text.matchAll(rx)) {
            if (!m[0]) continue;
            matches.push({ index: m.index, text: m[0], after: m[0].replace(single, rule.replace) });
        }
        if (matches.length) hits.push({ rule, matches });
    }
    return hits;
}

function applyRules(text, rules) {
    let out = text;
    for (const rule of rules) {
        const rx = compile(rule);
        if (rx) out = out.replace(rx, rule.replace);
    }
    return out;
}

const removalRules = () => settings().rules.filter(r => r.enabled && r.remove && r.find.trim());

// ---------------------------------------------------------------- prompt injection

function updatePrompt() {
    const s = settings();
    const c = ctx();
    let text = '';
    if (s.enabled && s.inject) {
        const model = currentModel();
        const lines = s.rules
            .filter(r => r.enabled && r.prompt.trim() && modelMatches(r, model))
            .map(r => `- ${r.prompt.trim()}`);
        if (lines.length) text = `${s.header}\n${lines.join('\n')}`;
    }
    c.setExtensionPrompt(PROMPT_KEY, text, IN_CHAT, Number(s.depth) || 0, false, Number(s.role) || 0);
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
 * @param {{id:number, text:string, hits:any[]}[]} found
 * @param {boolean} single — a fresh reply (offers "always remove")
 * @returns {Promise<{ruleIds:Set<string>, always:boolean}|null>}
 */
async function reviewPopup(found, single) {
    const c = ctx();
    const byRule = new Map();
    for (const f of found) {
        for (const h of f.hits) {
            if (!byRule.has(h.rule.id)) byRule.set(h.rule.id, { rule: h.rule, count: 0, messages: 0, samples: [] });
            const g = byRule.get(h.rule.id);
            g.count += h.matches.length;
            g.messages += 1;
            for (const m of h.matches) if (g.samples.length < 3) g.samples.push(snippet(f.text, m));
        }
    }

    const root = document.createElement('div');
    root.className = 'sg_review';
    const where = single ? 'ในข้อความล่าสุด' : `ใน ${found.length} ข้อความ`;
    root.innerHTML = `
        <h3>เจอคำที่แบนไว้${where}</h3>
        <small class="sg_note">ติ๊กกฎที่จะลบ/แทนที่ <del>ขีดฆ่า</del> คือส่วนที่จะหายไป <ins>ขีดเส้นใต้</ins> คือส่วนที่ใส่แทน</small>
        ${[...byRule.values()].map(g => `
        <label class="sg_review_rule">
            <div class="sg_review_head">
                <input type="checkbox" data-rule="${esc(g.rule.id)}" checked>
                <code>${esc(g.rule.find)}</code>
                <span class="sg_badge">${g.count} ครั้ง${single ? '' : ` · ${g.messages} ข้อความ`}</span>
            </div>
            ${g.samples.map(x => `<div class="sg_sample">${x}</div>`).join('')}
        </label>`).join('')}`;

    const customButtons = single
        ? [{ text: 'ลบอัตโนมัติต่อจากนี้', result: c.POPUP_RESULT.CUSTOM1, classes: ['sg_always'] }]
        : null;
    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'ลบ/แทนที่',
        cancelButton: 'ข้าม',
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

const isBotMessage = m => m && !m.is_user && !m.is_system && typeof m.mes === 'string';

// Popups for incoming replies are shown one at a time, and the event handler
// never waits on them — SillyTavern awaits MESSAGE_RECEIVED before finishing a
// generation, and a popup left open must not hold that up.
let queue = Promise.resolve();
const enqueue = fn => { queue = queue.then(fn).catch(e => console.error(LOG, e)); };

function onMessageReceived(mesId, type) {
    const s = settings();
    if (!s.enabled || s.mode === 'off') return;
    if (type === 'first_message' || type === 'command') return;
    const id = Number(mesId);
    enqueue(() => handleReply(id));
}

async function handleReply(id) {
    const s = settings();
    const c = ctx();
    const msg = c.chat[id];
    if (!isBotMessage(msg)) return;
    const text = msg.mes;
    const rules = removalRules();
    const hits = findHits(text, rules);
    if (!hits.length) return;

    let chosen = hits.map(h => h.rule);
    if (s.mode === 'ask') {
        const answer = await reviewPopup([{ id, text, hits }], true);
        if (!answer) return;
        if (answer.always) {
            s.mode = 'auto';
            save();
            syncSettingsUi();
            toast.info('ต่อจากนี้จะลบอัตโนมัติ เปลี่ยนกลับได้ในหน้าตั้งค่า Slop Guard');
        }
        chosen = chosen.filter(r => answer.ruleIds.has(r.id));
        // The user may have swiped, edited or deleted while the popup was open.
        if (ctx().chat[id] !== msg || msg.mes !== text) {
            toast.warn('ข้อความเปลี่ยนไประหว่างรอ เลยไม่ได้แก้ให้');
            return;
        }
    }
    if (!chosen.length) return;

    const out = applyRules(text, chosen);
    if (out === text) return;
    writeMessage(id, out);
    await c.saveChat();
    if (s.mode === 'auto') {
        const n = hits.filter(h => chosen.includes(h.rule)).reduce((a, h) => a + h.matches.length, 0);
        toast.info(`ลบ/แทนที่ ${n} จุดในข้อความล่าสุด`);
    }
}

async function cleanWholeChat() {
    const c = ctx();
    if (!c.chat?.length) return toast.warn('ยังไม่ได้เปิดแชท');
    const rules = removalRules();
    const found = [];
    c.chat.forEach((m, id) => {
        if (!isBotMessage(m)) return;
        const hits = findHits(m.mes, rules);
        if (hits.length) found.push({ id, text: m.mes, hits });
    });
    if (!found.length) return toast.ok('ไม่เจอคำที่แบนไว้ในแชทนี้');

    const answer = await reviewPopup(found, false);
    if (!answer) return;
    const chosen = rules.filter(r => answer.ruleIds.has(r.id));
    let changed = 0;
    for (const f of found) {
        if (c.chat[f.id]?.mes !== f.text) continue;
        const out = applyRules(f.text, chosen);
        if (out !== f.text) { writeMessage(f.id, out); changed++; }
    }
    if (changed) await c.saveChat();
    toast.ok(`แก้ไป ${changed} ข้อความ`);
}

// ---------------------------------------------------------------- AI scan

const SCAN_SYSTEM = `You are an editor hunting a writer's verbal tics.
Read the passages and list up to 8 phrases that occur at least twice and read as clichés or crutches (stock gestures, stock adverbs, stock metaphors).
For each, copy the phrase EXACTLY as it is written in the text — same language, same spelling — and as short as possible while still identifying the tic.
Return ONLY a JSON array, no prose:
[{"phrase": "...", "fix": "...", "rule": "..."}]
- "fix": text that can replace the phrase everywhere and still read naturally; "" if deleting the phrase leaves a correct sentence; null if no single replacement works.
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
    if (!c.chat?.length) return toast.warn('ยังไม่ได้เปิดแชท');

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
    if (corpus.length < 500) return toast.warn('ข้อความในแชทยังน้อยเกินไปสำหรับการสแกน');

    scanning = true;
    const btn = $id('sg_scan');
    btn?.classList.add('disabled');
    toast.info(`กำลังให้ ${model || 'โมเดล'} สแกน ${msgs.length} ข้อความ…`);
    let raw;
    try {
        raw = await c.generateRaw({
            systemPrompt: SCAN_SYSTEM,
            prompt: `<passages>\n${corpus}\n</passages>\n\nReturn the JSON array now.`,
            responseLength: 1500,
        });
    } catch (e) {
        console.error(LOG, e);
        toast.warn('สแกนไม่สำเร็จ: ' + (e?.message ?? e));
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
        items.push({ phrase, count, fix: typeof x.fix === 'string' ? x.fix : null, rule: String(x.rule ?? '') });
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
        <small class="sg_note">ติ๊กอันที่จะเพิ่มเป็นกฎ แก้ไขได้ก่อนกดเพิ่ม · ถ้าไม่ติ๊ก "ลบในข้อความ" กฎจะใช้แค่ใน prompt</small>
        ${items.map((it, i) => `
        <div class="sg_review_rule" data-i="${i}">
            <div class="sg_review_head">
                <input type="checkbox" class="sg_pick" checked>
                <input type="text" class="text_pole sg_f_find" value="${esc(it.phrase)}">
                <span class="sg_badge">${it.count} ครั้ง</span>
            </div>
            <div class="sg_row">
                <label class="checkbox_label"><input type="checkbox" class="sg_f_remove" ${it.fix !== null ? 'checked' : ''}> ลบในข้อความ</label>
                <input type="text" class="text_pole sg_f_replace" placeholder="แทนด้วย (ว่าง = ลบ)" value="${esc(it.fix ?? '')}">
                <input type="text" class="text_pole sg_f_models" placeholder="ทุกโมเดล" value="${esc(family)}">
            </div>
            <textarea class="text_pole sg_f_prompt" rows="2" placeholder="กฎใน prompt">${esc(it.rule)}</textarea>
        </div>`).join('')}`;
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
            replace: el.querySelector('.sg_f_replace').value,
            remove: el.querySelector('.sg_f_remove').checked,
            models: el.querySelector('.sg_f_models').value.trim(),
            prompt: el.querySelector('.sg_f_prompt').value.trim(),
        }));
        added++;
    }
    if (!added) return;
    save();
    renderRules();
    toast.ok(`เพิ่ม ${added} กฎ`);
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
                <label class="checkbox_label"><input type="checkbox" id="sg_enabled"> เปิดใช้ Slop Guard</label>
                <div class="sg_row">
                    <label for="sg_mode">เจอคำแบนในข้อความใหม่</label>
                    <select id="sg_mode" class="text_pole">
                        <option value="ask">ถามก่อนลบ (popup)</option>
                        <option value="auto">ลบอัตโนมัติ</option>
                        <option value="off">ไม่ลบ (ใช้แค่กฎใน prompt)</option>
                    </select>
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
                <div class="sg_buttons">
                    <div class="menu_button menu_button_icon" id="sg_add"><i class="fa-solid fa-plus"></i> เพิ่มกฎ</div>
                    <div class="menu_button menu_button_icon" id="sg_scan" title="ให้โมเดลที่ใช้อยู่หาวลีที่ซ้ำในแชทนี้"><i class="fa-solid fa-magnifying-glass"></i> สแกนแชทด้วย AI</div>
                    <div class="menu_button menu_button_icon" id="sg_clean" title="หาคำแบนในทุกข้อความของบอทในแชทนี้"><i class="fa-solid fa-broom"></i> ล้างทั้งแชท</div>
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
                <small class="sg_note">ช่อง "หา" ใส่วลีตรงๆ หรือ <code>/regex/</code> · ช่อง "โมเดล" ใส่ชื่อบางส่วนคั่นด้วยจุลภาค เช่น <code>gemini, deepseek</code> เว้นว่าง = ทุกโมเดล · โมเดลมีผลกับกฎใน prompt ส่วนการลบใช้กับทุกโมเดล</small>
                <div id="sg_rules" class="sg_rules"></div>
            </div>
        </div>
    </div>`);

    const s = settings();
    const bindCheck = (id, key) => $id(id).addEventListener('change', e => { s[key] = e.target.checked; save(); });
    bindCheck('sg_enabled', 'enabled');
    bindCheck('sg_inject', 'inject');
    bindCheck('sg_scan_same', 'scanSameModel');
    $id('sg_mode').addEventListener('change', e => { s.mode = e.target.value; save(); });
    $id('sg_role').addEventListener('change', e => { s.role = Number(e.target.value); save(); });
    $id('sg_depth').addEventListener('change', e => { s.depth = Math.max(0, Number(e.target.value) || 0); save(); });
    $id('sg_scan_count').addEventListener('change', e => { s.scanCount = Math.max(5, Number(e.target.value) || 30); save(); });

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
    $id('sg_mode').value = s.mode;
    $id('sg_role').value = String(s.role);
    $id('sg_depth').value = String(s.depth);
    $id('sg_scan_count').value = String(s.scanCount);
    syncModelLine();
}

function syncModelLine() {
    const el = $id('sg_model_line');
    if (!el) return;
    const model = currentModel();
    const active = settings().rules.filter(r => r.enabled && r.prompt.trim() && modelMatches(r, model)).length;
    el.textContent = model
        ? `โมเดลตอนนี้: ${model} · กฎใน prompt ที่ใช้อยู่ ${active} ข้อ`
        : 'ยังไม่ได้เชื่อมต่อโมเดล';
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
        <div class="sg_rule${r.enabled ? '' : ' sg_off'}" data-id="${esc(r.id)}">
            <div class="sg_rule_head">
                <input type="checkbox" class="sg_f_enabled" title="เปิดใช้กฎนี้" ${r.enabled ? 'checked' : ''}>
                <input type="text" class="text_pole sg_f_find${r.find.trim() && !compile(r) ? ' sg_invalid' : ''}" placeholder="หา: วลี หรือ /regex/" value="${esc(r.find)}">
                <div class="menu_button fa-solid fa-trash-can sg_f_delete" title="ลบกฎ"></div>
            </div>
            <div class="sg_row">
                <label class="checkbox_label" title="ลบหรือแทนที่ในข้อความที่บอทตอบ"><input type="checkbox" class="sg_f_remove" ${r.remove ? 'checked' : ''}> ลบในข้อความ</label>
                <input type="text" class="text_pole sg_f_replace" placeholder="แทนด้วย (ว่าง = ลบ)" value="${esc(r.replace)}">
                <input type="text" class="text_pole sg_f_models" placeholder="ทุกโมเดล" title="โมเดลที่จะได้กฎใน prompt" value="${esc(r.models)}">
            </div>
            <textarea class="text_pole sg_f_prompt" rows="2" placeholder="กฎใน prompt (ว่าง = ไม่ใส่)">${esc(r.prompt)}</textarea>
        </div>`).join('');

    for (const el of box.querySelectorAll('.sg_rule')) {
        const rule = s.rules.find(r => r.id === el.dataset.id);
        const field = (cls, key, prop = 'value') => el.querySelector(cls).addEventListener('change', e => {
            rule[key] = e.target[prop];
            if (key === 'enabled') el.classList.toggle('sg_off', !rule.enabled);
            if (key === 'find' || key === 'replace') {
                el.querySelector('.sg_f_find').classList.toggle('sg_invalid', !!rule.find.trim() && !compile(rule));
            }
            save();
            syncModelLine();
        });
        field('.sg_f_enabled', 'enabled', 'checked');
        field('.sg_f_remove', 'remove', 'checked');
        field('.sg_f_find', 'find');
        field('.sg_f_replace', 'replace');
        field('.sg_f_models', 'models');
        field('.sg_f_prompt', 'prompt');
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
        helpString: 'Slop Guard — หาคำที่แบนไว้ในทุกข้อความของบอทในแชทนี้ แล้วเลือกลบ/แทนที่',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'slopscan',
        callback: async () => { await scanWithAI(); return ''; },
        helpString: 'Slop Guard — ให้โมเดลที่ใช้อยู่หาวลีที่ซ้ำในแชทนี้ แล้วเลือกเพิ่มเป็นกฎ',
    }));
}

// ---------------------------------------------------------------- boot

function start() {
    settings();
    renderSettings();
    registerCommand();
    updatePrompt();
}

(function init() {
    const { eventSource, event_types: E } = ctx();
    eventSource.on(E.MESSAGE_RECEIVED, onMessageReceived);
    // Re-check the model right before every prompt is built: the model can be
    // switched from many places (connection profiles, slash commands, ...).
    eventSource.on(E.GENERATION_STARTED, () => updatePrompt());
    eventSource.on(E.CHAT_CHANGED, () => { updatePrompt(); syncModelLine(); });
    if (E.CHATCOMPLETION_MODEL_CHANGED) eventSource.on(E.CHATCOMPLETION_MODEL_CHANGED, () => { updatePrompt(); syncModelLine(); });
    if (E.ONLINE_STATUS_CHANGED) eventSource.on(E.ONLINE_STATUS_CHANGED, () => { updatePrompt(); syncModelLine(); });
    if (E.MAIN_API_CHANGED) eventSource.on(E.MAIN_API_CHANGED, () => { updatePrompt(); syncModelLine(); });
    eventSource.once(E.APP_READY, start);
})();
