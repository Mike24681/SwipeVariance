const MODULE_NAME = "swipe_variance";
const PROMPT_KEY = "SwipeVariance";

// Zero-width Unicode characters: invisible in rendered text but each tokenizes differently,
// so changing their combination shifts the token distribution and produces varied outputs.
const ZW_CHARS = [
    "\u200B", // Zero Width Space
    "\u200C", // Zero Width Non-Joiner
    "\u200D", // Zero Width Joiner
    "\u2060", // Word Joiner
    "\uFEFF", // Zero Width No-Break Space
];

const defaultSettings = {
    enabled: true,
    charCount: 4,
};

let lastSequence = "";
let lastDepth = -1;

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

function generateVariance() {
    const settings = getSettings();
    const count = settings.charCount ?? defaultSettings.charCount;
    let sequence;
    let attempts = 0;

    do {
        sequence = "";
        let prev = "";
        for (let i = 0; i < count; i++) {
            const pool = ZW_CHARS.filter((c) => c !== prev);
            const picked = pool[Math.floor(Math.random() * pool.length)];
            sequence += picked;
            prev = picked;
        }
        attempts++;
    } while (sequence === lastSequence && attempts < 50);

    lastSequence = sequence;
    return sequence;
}

function pickDepth(maxAllowed) {
    if (maxAllowed <= 0) return 0;
    let depth;
    let attempts = 0;
    do {
        depth = Math.floor(Math.random() * (maxAllowed + 1));
        attempts++;
    } while (depth === lastDepth && attempts < 20);
    lastDepth = depth;
    return depth;
}

function onGenerationStarted() {
    const settings = getSettings();
    const { setExtensionPrompt } = SillyTavern.getContext();

    if (!settings.enabled) {
        setExtensionPrompt(PROMPT_KEY, "", 1, 0);
        return;
    }

    const context = SillyTavern.getContext();
    const chatLength = context.chat?.length ?? 0;
    const maxDepth = Math.min(3, Math.max(0, chatLength - 1));

    const variance = generateVariance();
    const depth = pickDepth(maxDepth);

    setExtensionPrompt(PROMPT_KEY, variance, 1, depth);
}

function loadSettingsUI() {
    const settings = getSettings();
    $("#swipe_variance_enabled").prop("checked", settings.enabled);
    $("#swipe_variance_count").val(settings.charCount);
    $("#swipe_variance_count_value").text(settings.charCount);
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
                    <label for="swipe_variance_count">
                        Variance Strength: <span id="swipe_variance_count_value">4</span>
                    </label>
                    <input id="swipe_variance_count" type="range"
                           min="2" max="10" step="1" value="4" />
                    <small class="swipe_variance_hint">
                        Higher = more invisible characters injected = stronger variance
                    </small>
                </div>
                <hr class="sysHR" />
            </div>
        </div>
    </div>`;

    $("#extensions_settings2").append(settingsHtml);

    const { saveSettingsDebounced, eventSource, event_types } = SillyTavern.getContext();

    $("#swipe_variance_enabled").on("change", function () {
        const settings = getSettings();
        settings.enabled = !!$(this).prop("checked");
        saveSettingsDebounced();
    });

    $("#swipe_variance_count").on("input", function () {
        const value = Number($(this).val());
        const settings = getSettings();
        settings.charCount = value;
        $("#swipe_variance_count_value").text(value);
        saveSettingsDebounced();
    });

    loadSettingsUI();
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
});
