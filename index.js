const MODULE_NAME = "swipe_variance";

// ── Invisible Unicode palette ──────────────────────────────────────────
// These characters are invisible or zero-width in rendered text but each
// tokenizes differently, shifting the probability distribution for every swipe.
const ZW_CHARS = [
    "\u200B", // Zero Width Space
    "\u200C", // Zero Width Non-Joiner
    "\u200D", // Zero Width Joiner
    "\u2060", // Word Joiner
    "\uFEFF", // Zero Width No-Break Space
    "\u180E", // Mongolian Vowel Separator
    "\u2061", // Function Application
    "\u2062", // Invisible Times
    "\u2063", // Invisible Separator
    "\u2064", // Invisible Plus
    "\u034F", // Combining Grapheme Joiner
    "\u00AD", // Soft Hyphen
    "\u2028", // Line Separator (invisible in most contexts)
    "\u2029", // Paragraph Separator (invisible in most contexts)
    "\u17B4", // Khmer Vowel Inherent Aq (invisible)
    "\u17B5", // Khmer Vowel Inherent Aa (invisible)
];

// ── Default settings ───────────────────────────────────────────────────
// Invisible punctuation — wrapped in zero-width chars so users never see them,
// but each one shifts the token boundary for the AI.
const INVISIBLE_PUNCTUATION = [
    "\u200B.\u200B",
    "\u200B,\u200B",
    "\u200C.\u200C",
    "\u200C,\u200C",
    "\u200D.\u200D",
    "\u200D,\u200D",
    "\u2060.\u2060",
    "\u2060,\u2060",
    "\uFEFF.\uFEFF",
    "\uFEFF,\uFEFF",
];

const defaultSettings = {
    enabled: true,
    strength: 5,           // 1-10 overall strength dial
    perturbMessages: true,  // splice invisible chars into existing messages
    multiDepth: true,       // inject at multiple depths
    roleShuffle: true,      // vary the injection role
    entropyPrefix: true,    // add a tiny unique generation nonce
    punctuationPad: true,   // add invisible periods/commas to message edges
};

let generationCounter = 0;
let lastInjections = {};

// ── Helpers ────────────────────────────────────────────────────────────
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

/** Pick `count` random items from `arr` without replacement. */
function sample(arr, count) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, arr.length));
}

/** Build a random invisible sequence of length `n` (never the same twice in a row). */
function randomZWSequence(n) {
    let seq = "";
    let prev = "";
    for (let i = 0; i < n; i++) {
        const pool = ZW_CHARS.filter((c) => c !== prev);
        const picked = pool[Math.floor(Math.random() * pool.length)];
        seq += picked;
        prev = picked;
    }
    return seq;
}

/** Generate a compact unique nonce like "v9f3a" — changes every generation. */
function generateNonce() {
    generationCounter++;
    const time = Date.now().toString(36).slice(-4);
    const rand = Math.random().toString(36).slice(2, 6);
    const count = generationCounter.toString(36);
    return `${time}${rand}${count}`;
}

/** Insert `snippet` at a random position inside `text` (at a word boundary). */
function spliceIntoText(text, snippet) {
    if (!text || text.length < 2) return snippet + text;
    // Find all word-boundary positions (between spaces / after punctuation)
    const positions = [];
    for (let i = 1; i < text.length - 1; i++) {
        if (text[i] === " " || text[i] === "\n") {
            positions.push(i);
        }
    }
    if (positions.length === 0) {
        // Fallback: insert after first char
        return text[0] + snippet + text.slice(1);
    }
    const pos = positions[Math.floor(Math.random() * positions.length)];
    return text.slice(0, pos) + snippet + text.slice(pos);
}

// ── Strategy 1: Multi-depth prompt injection ───────────────────────────
function injectPrompts() {
    const settings = getSettings();
    const { setExtensionPrompt, chat } = SillyTavern.getContext();
    const chatLength = chat?.length ?? 0;

    // Clear all previous injection slots
    for (const key of Object.keys(lastInjections)) {
        setExtensionPrompt(key, "", 1, 0);
    }
    lastInjections = {};

    if (!settings.enabled) return;

    const strength = settings.strength ?? 5;
    // Number of invisible chars per injection scales with strength
    const charCount = Math.max(2, Math.floor(strength * 0.8) + 2);
    // Number of injection points: 1-4 depending on strength and multiDepth
    const injectionCount = settings.multiDepth
        ? Math.min(4, Math.max(1, Math.ceil(strength / 3)))
        : 1;

    const maxDepth = Math.min(6, Math.max(0, chatLength - 1));

    // Pick distinct random depths
    const depthPool = [];
    for (let d = 0; d <= maxDepth; d++) depthPool.push(d);
    const depths = sample(depthPool, injectionCount);

    // Possible roles: 0 = system, 1 = user, 2 = assistant
    const roles = [0, 1, 2];

    depths.forEach((depth, idx) => {
        const key = `SwipeVariance_${idx}`;
        const seq = randomZWSequence(charCount);

        let role = 0; // default system
        if (settings.roleShuffle) {
            role = roles[Math.floor(Math.random() * roles.length)];
        }

        setExtensionPrompt(key, seq, 1, depth, false, role);
        lastInjections[key] = true;
    });

    // Strategy 2: Entropy nonce — a tiny system-role injection with a unique ID
    if (settings.entropyPrefix) {
        const nonceKey = "SwipeVariance_nonce";
        const nonce = generateNonce();
        // Wrap in zero-width chars so it's invisible to user but changes tokens
        const wrapped = randomZWSequence(2) + nonce + randomZWSequence(2);
        setExtensionPrompt(nonceKey, wrapped, 0, 0, false, 0); // position=BEFORE_PROMPT
        lastInjections[nonceKey] = true;
    }
}

// ── Strategy 3: Generate interceptor ────────────────────────────────────
// This is called by ST's engine right before the prompt is finalized.
// It receives the actual chat array and can modify messages in-place.
export function swipeVarianceInterceptor(chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled || !settings.perturbMessages) return;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const strength = settings.strength ?? 5;
    // How many messages to perturb: 1-5 based on strength
    const perturbCount = Math.min(chat.length, Math.max(1, Math.ceil(strength / 2)));
    // How many invisible chars to splice into each perturbed message
    const snippetLen = Math.max(1, Math.floor(strength / 2));

    // Pick random indices from the chat to perturb (avoid the very first system prompt)
    const indices = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.content && typeof chat[i].content === "string") {
            indices.push(i);
        }
    }

    const chosen = sample(indices, perturbCount);

    for (const idx of chosen) {
        const msg = chat[idx];
        if (!msg.content || typeof msg.content !== "string") continue;

        const snippet = randomZWSequence(snippetLen);
        msg.content = spliceIntoText(msg.content, snippet);
    }

    // Strategy 4: Invisible punctuation padding on message edges
    if (settings.punctuationPad) {
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg.content || typeof msg.content !== "string") continue;
            if (msg.role !== "user" && msg.role !== "assistant") continue;

            // Random count 1-6 for beginning, 1-6 for end (always different per message)
            const prefixCount = Math.floor(Math.random() * 6) + 1;
            const suffixCount = Math.floor(Math.random() * 6) + 1;

            let prefix = "";
            for (let p = 0; p < prefixCount; p++) {
                prefix += INVISIBLE_PUNCTUATION[Math.floor(Math.random() * INVISIBLE_PUNCTUATION.length)];
            }

            let suffix = "";
            for (let s = 0; s < suffixCount; s++) {
                suffix += INVISIBLE_PUNCTUATION[Math.floor(Math.random() * INVISIBLE_PUNCTUATION.length)];
            }

            msg.content = prefix + msg.content + suffix;
        }
    }
}

// ── Event hook ─────────────────────────────────────────────────────────
function onGenerationStarted() {
    injectPrompts();
}

// ── UI ─────────────────────────────────────────────────────────────────
function loadSettingsUI() {
    const settings = getSettings();
    $("#swipe_variance_enabled").prop("checked", settings.enabled);
    $("#swipe_variance_strength").val(settings.strength);
    $("#swipe_variance_strength_value").text(settings.strength);
    $("#swipe_variance_perturb").prop("checked", settings.perturbMessages);
    $("#swipe_variance_multidepth").prop("checked", settings.multiDepth);
    $("#swipe_variance_roleshuffle").prop("checked", settings.roleShuffle);
    $("#swipe_variance_entropy").prop("checked", settings.entropyPrefix);
    $("#swipe_variance_punctuation").prop("checked", settings.punctuationPad);
}

jQuery(async () => {
    const settingsHtml = `
    <div id="swipe_variance_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Swipe Variance</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_enabled">
                        <input id="swipe_variance_enabled" type="checkbox" />
                        <span>Enable Swipe Variance</span>
                    </label>
                </div>
                <div class="swipe_variance_block">
                    <label for="swipe_variance_strength">
                        Variance Strength: <span id="swipe_variance_strength_value">5</span>
                    </label>
                    <input id="swipe_variance_strength" type="range"
                           min="1" max="10" step="1" value="5" />
                    <small class="swipe_variance_hint">
                        Controls how many injections, perturbations, and invisible chars are used.
                    </small>
                </div>
                <hr class="sysHR" />
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_perturb">
                        <input id="swipe_variance_perturb" type="checkbox" />
                        <span>Perturb Messages</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Splice invisible characters into random existing messages before generation.
                        This changes how the AI "sees" the conversation each time.
                    </small>
                </div>
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_multidepth">
                        <input id="swipe_variance_multidepth" type="checkbox" />
                        <span>Multi-Depth Injection</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Inject invisible characters at multiple random depths in the prompt.
                    </small>
                </div>
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_roleshuffle">
                        <input id="swipe_variance_roleshuffle" type="checkbox" />
                        <span>Role Shuffle</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Randomly vary the role (system/user/assistant) of injected prompts.
                    </small>
                </div>
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_entropy">
                        <input id="swipe_variance_entropy" type="checkbox" />
                        <span>Entropy Nonce</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Prepend a unique invisible generation ID so no two requests are identical.
                    </small>
                </div>
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_punctuation">
                        <input id="swipe_variance_punctuation" type="checkbox" />
                        <span>Invisible Punctuation Padding</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Adds a random number of invisible periods/commas to the start and end
                        of every user and AI message. Changes token boundaries each swipe.
                    </small>
                </div>
                <hr class="sysHR" />
            </div>
        </div>
    </div>`;

    $("#extensions_settings2").append(settingsHtml);

    const { saveSettingsDebounced, eventSource, event_types } = SillyTavern.getContext();

    // ── Bind UI events ──
    $("#swipe_variance_enabled").on("change", function () {
        const settings = getSettings();
        settings.enabled = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#swipe_variance_strength").on("input", function () {
        const value = Number($(this).val());
        const settings = getSettings();
        settings.strength = value;
        $("#swipe_variance_strength_value").text(value);
        saveSettingsDebounced();
    });

    $("#swipe_variance_perturb").on("change", function () {
        const settings = getSettings();
        settings.perturbMessages = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#swipe_variance_multidepth").on("change", function () {
        const settings = getSettings();
        settings.multiDepth = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#swipe_variance_roleshuffle").on("change", function () {
        const settings = getSettings();
        settings.roleShuffle = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#swipe_variance_entropy").on("change", function () {
        const settings = getSettings();
        settings.entropyPrefix = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#swipe_variance_punctuation").on("change", function () {
        const settings = getSettings();
        settings.punctuationPad = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    loadSettingsUI();
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
});
