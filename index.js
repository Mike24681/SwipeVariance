const MODULE_NAME = "swipe_variance";

// ── Unicode whitespace palette ─────────────────────────────────────────
// These are visible-width whitespace characters that Claude tokenizes
// distinctly from regular ASCII spaces.  They render as spaces of varying
// widths but each one shifts the token boundary for every swipe.
const SPACE_CHARS = [
    "\u2002", // En Space
    "\u2003", // Em Space
    "\u2004", // Three-Per-Em Space
    "\u2005", // Four-Per-Em Space
    "\u2006", // Six-Per-Em Space
    "\u2007", // Figure Space
    "\u2008", // Punctuation Space
    "\u2009", // Thin Space
    "\u200A", // Hair Space
    "\u202F", // Narrow No-Break Space
    "\u205F", // Medium Mathematical Space
    "\u00A0", // No-Break Space
    "\u3000", // Ideographic Space
    "\t",     // Tab
];

// ── Edge-padding sequences ─────────────────────────────────────────────
// Used to pad message boundaries — Claude tokenizes all of these.
const PAD_SEQUENCES = [
    "\n",
    "\n ",
    " \n",
    "\n\n",
    "  ",
    "   ",
    "\t",
    " \t",
    "\t ",
    "\n\t",
];

const defaultSettings = {
    enabled: true,
    strength: 5,           // 1-10 overall strength dial
    perturbMessages: true,  // swap regular spaces with Unicode space variants
    multiDepth: true,       // inject whitespace at multiple depths
    roleShuffle: true,      // vary the injection role
    entropyPrefix: true,    // inject a unique tokenizable seed
    punctuationPad: true,   // newline/whitespace padding on message edges
    trailingSpace: true,    // random trailing whitespace on all messages
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

/** Build a random whitespace sequence of length `n` (never the same twice in a row). */
function randomSpaceSequence(n) {
    let seq = "";
    let prev = "";
    for (let i = 0; i < n; i++) {
        const pool = SPACE_CHARS.filter((c) => c !== prev);
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

/** Replace a random space in `text` with a Unicode whitespace variant. */
function perturbSpace(text) {
    const spacePositions = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === " ") spacePositions.push(i);
    }
    if (spacePositions.length === 0) return text;
    const pos = spacePositions[Math.floor(Math.random() * spacePositions.length)];
    const replacement = SPACE_CHARS[Math.floor(Math.random() * SPACE_CHARS.length)];
    return text.slice(0, pos) + replacement + text.slice(pos + 1);
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
    // Number of whitespace chars per injection scales with strength
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
        const seq = randomSpaceSequence(charCount);

        let role = 0; // default system
        if (settings.roleShuffle) {
            role = roles[Math.floor(Math.random() * roles.length)];
        }

        setExtensionPrompt(key, seq, 1, depth, false, role);
        lastInjections[key] = true;
    });

    // Strategy 2: Entropy seed — a unique tokenizable string Claude will process
    if (settings.entropyPrefix) {
        const nonceKey = "SwipeVariance_nonce";
        const nonce = generateNonce();
        // Plain text nonce — Claude tokenizes this distinctly each generation
        setExtensionPrompt(nonceKey, nonce, 0, 0, false, 0); // position=BEFORE_PROMPT
        lastInjections[nonceKey] = true;
    }
}

// ── Strategy 3: Generate interceptor ────────────────────────────────────
// This is called by ST's engine right before the prompt is finalized.
// It receives the actual chat array and can modify messages in-place.
export function swipeVarianceInterceptor(chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const strength = settings.strength ?? 5;

    // Strategy 3a: Space perturbation — swap regular spaces with Unicode variants
    if (settings.perturbMessages) {
        const perturbCount = Math.min(chat.length, Math.max(1, Math.ceil(strength / 2)));
        const swapsPerMessage = Math.max(1, Math.floor(strength / 2));

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

            for (let s = 0; s < swapsPerMessage; s++) {
                msg.content = perturbSpace(msg.content);
            }
        }
    }

    // Strategy 3b: Edge padding — random newlines/whitespace at message boundaries
    if (settings.punctuationPad) {
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg.content || typeof msg.content !== "string") continue;
            if (msg.role !== "user" && msg.role !== "assistant") continue;

            const prefixCount = Math.floor(Math.random() * 4) + 1;
            const suffixCount = Math.floor(Math.random() * 4) + 1;

            let prefix = "";
            for (let p = 0; p < prefixCount; p++) {
                prefix += PAD_SEQUENCES[Math.floor(Math.random() * PAD_SEQUENCES.length)];
            }

            let suffix = "";
            for (let s = 0; s < suffixCount; s++) {
                suffix += PAD_SEQUENCES[Math.floor(Math.random() * PAD_SEQUENCES.length)];
            }

            msg.content = prefix + msg.content + suffix;
        }
    }

    // Strategy 3c: Trailing whitespace — random Unicode whitespace appended
    if (settings.trailingSpace) {
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg.content || typeof msg.content !== "string") continue;

            const trailCount = Math.floor(Math.random() * (strength + 2)) + 1;
            let trail = "";
            for (let t = 0; t < trailCount; t++) {
                trail += SPACE_CHARS[Math.floor(Math.random() * SPACE_CHARS.length)];
            }
            msg.content = msg.content + trail;
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
    $("#swipe_variance_trailingspace").prop("checked", settings.trailingSpace);
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
                        Controls how many injections, perturbations, and whitespace changes are used.
                    </small>
                </div>
                <hr class="sysHR" />
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_perturb">
                        <input id="swipe_variance_perturb" type="checkbox" />
                        <span>Space Perturbation</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Replace random spaces in messages with Unicode whitespace variants
                        (em space, thin space, etc.) that Claude tokenizes differently.
                    </small>
                </div>
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_multidepth">
                        <input id="swipe_variance_multidepth" type="checkbox" />
                        <span>Multi-Depth Injection</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Inject Unicode whitespace sequences at multiple random depths in the prompt.
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
                        <span>Entropy Seed</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Inject a unique tokenizable seed each generation so no two requests
                        are identical to Claude's tokenizer.
                    </small>
                </div>
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_punctuation">
                        <input id="swipe_variance_punctuation" type="checkbox" />
                        <span>Edge Padding</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Add random newlines and whitespace to the start/end of user and AI
                        messages. Shifts token boundaries at message edges.
                    </small>
                </div>
                <div class="swipe_variance_block">
                    <label class="checkbox_label" for="swipe_variance_trailingspace">
                        <input id="swipe_variance_trailingspace" type="checkbox" />
                        <span>Trailing Whitespace</span>
                    </label>
                    <small class="swipe_variance_hint">
                        Append random Unicode whitespace characters to all messages.
                        Each swipe gets a different trailing pattern.
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

    $("#swipe_variance_trailingspace").on("change", function () {
        const settings = getSettings();
        settings.trailingSpace = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    loadSettingsUI();
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
});
