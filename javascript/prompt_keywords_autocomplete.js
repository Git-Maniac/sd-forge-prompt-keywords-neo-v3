// ---------------------------------------------------------------------------
// PromptKeywords autocomplete
// ---------------------------------------------------------------------------
//
// Suggests the keywords when you type "<" in a prompt box. Typing more letters
// filters the list ("<cf" shows cfg_scale). Some keywords also suggest their
// values ("<sampler_name:" lists the samplers, "<checkpoint:" the checkpoints).
//
// Two modes:
//
// 1. Tag Autocomplete is installed (and switched on):
//    The keywords are added to ITS list. So "<" shows the keywords (on top) and
//    your LoRAs (below) in one list. Nothing is drawn on top of anything.
//
// 2. Tag Autocomplete is not installed:
//    This file draws its own small popup.
//
// The keyword list is loaded from the Python script (all_keywords),
// so new keywords show up here without changing this file.
//
// Keys: Up/Down = move, Enter or Tab = accept, Escape = close.

(function () {
    // The four prompt boxes (positive and negative, txt2img and img2img)
    const PROMPT_BOXES =
        "#txt2img_prompt textarea, #txt2img_neg_prompt textarea, " +
        "#img2img_prompt textarea, #img2img_neg_prompt textarea";

    // Keywords are only reloaded from Python if the last load is older than this
    const RELOAD_AFTER_MS = 10000;

    // Longest list shown at once in the own popup (the list scrolls)
    const MAX_ROWS_HEIGHT_PX = 280;

    // Colors of the own popup. They are the same as in Tag Autocomplete.
    const THEMES = {
        dark: {
            "--pk-bg": "#0b0f19",
            "--pk-bg-odd": "#111827",
            "--pk-selected": "#374151",
            "--pk-border-color": "#4b5563",
            "--pk-border-width": "1px",
            "--pk-text": "#e0e0e0",
            "--pk-meta": "#6b6f7b",
            "--pk-blue": "#597ef7",   // checkpoint names (like the LoRA names)
        },
        light: {
            "--pk-bg": "#ffffff",
            "--pk-bg-odd": "#f9fafb",
            "--pk-selected": "#e5e7eb",
            "--pk-border-color": "#e5e7eb",
            "--pk-border-width": "1.5px",
            "--pk-text": "#000000",
            "--pk-meta": "#a2a9b4",
            "--pk-blue": "#2040c8",
        },
    };

    // ------------------------------------------------------------------
    // Loading the keyword list
    // ------------------------------------------------------------------

    let keywords = [];       // [{name, type, where, values, previews}] loaded from Python
    let lastLoadTime = 0;
    let loading = false;

    async function loadKeywords() {
        // Loads the list from Python. Nobody waits for it: the lists always use the
        // keywords that are already there, a newer list is used from the next time on.
        if (loading || Date.now() - lastLoadTime < RELOAD_AFTER_MS) {
            return;
        }
        loading = true;
        try {
            const response = await fetch("/prompt_keywords/keywords");
            keywords = await response.json();
            lastLoadTime = Date.now();
        } catch (error) {
            console.error("[PromptKeywords] Could not load keywords:", error);
        }
        loading = false;
    }

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    function autocompleteEnabled() {
        // The setting can be switched off in Settings -> PromptKeywords
        if (typeof opts !== "undefined" && opts.prompt_keywords_autocomplete === false) {
            return false;
        }
        return true;
    }

    function isPromptBox(element) {
        return element && element.matches && element.matches(PROMPT_BOXES);
    }

    function tagAutocompleteInUse() {
        // True if Tag Autocomplete is installed and switched on. Then its list is used.
        // (window.isEnabled is the function of Tag Autocomplete)
        try {
            return typeof PARSERS !== "undefined"
                && typeof window.isEnabled === "function"
                && window.isEnabled();
        } catch (error) {
            return false;
        }
    }

    function filterByText(items, getName, text) {
        // Keeps the items that contain the text. Items that start with it come first.
        text = text.toLowerCase();
        const starts = [];
        const contains = [];
        for (const item of items) {
            const name = getName(item).toLowerCase();
            if (name.startsWith(text)) {
                starts.push(item);
            } else if (name.includes(text)) {
                contains.push(item);
            }
        }
        return starts.concat(contains);
    }

    // ------------------------------------------------------------------
    // Finding out what the user is typing (used by both modes)
    // ------------------------------------------------------------------

    function analyze(value, caret) {
        // Looks at the text before the cursor. Returns the rows to suggest and
        // the part of the text (from..to) that a chosen row replaces.
        // rows: [{label, meta, insert, cursorBack, preview, blue}]
        const none = { rows: [], from: 0, to: 0 };
        const before = value.substring(0, caret);

        // Case 1: "<" followed by letters, e.g. "<cf" -> suggest keyword names
        const nameMatch = before.match(/<([A-Za-z_]*)$/);
        if (nameMatch) {
            const found = filterByText(keywords, (k) => k.name, nameMatch[1]);
            const rows = found.map((k) => ({
                label: k.name,
                meta: [k.type, k.where].filter(Boolean).join(" · "),
                // "<name:>" and the cursor is placed before the ">"
                insert: "<" + k.name + ":>",
                cursorBack: 1,
                preview: "",
                blue: false,
            }));
            return { rows: rows, from: caret - nameMatch[0].length, to: caret };
        }

        // Case 2: "<name:" followed by a value start, e.g. "<sampler_name:eu"
        // -> suggest the values of that keyword
        const valueMatch = before.match(/<([A-Za-z_]+):([^<>]*)$/);
        if (valueMatch) {
            const keyword = keywords.find((k) => k.name === valueMatch[1]);
            if (!keyword || keyword.values.length === 0) {
                return none;
            }
            let to = caret;
            // A ">" right behind the cursor belongs to the tag and is replaced too
            if (value[to] === ">") {
                to += 1;
            }

            const found = filterByText(keyword.values, (v) => v, valueMatch[2]);
            const rows = found.map((name) => ({
                label: name,
                meta: "",
                insert: "<" + keyword.name + ":" + name + ">",
                cursorBack: 0,
                preview: (keyword.previews || {})[name] || "",
                blue: keyword.name === "checkpoint",
            }));
            return { rows: rows, from: caret - valueMatch[0].length, to: to };
        }

        return none;
    }

    function analyzeTextarea(textarea) {
        if (!autocompleteEnabled() || keywords.length === 0 || textarea.selectionStart !== textarea.selectionEnd) {
            return { rows: [], from: 0, to: 0 };
        }
        return analyze(textarea.value, textarea.selectionStart);
    }

    function insertRow(textarea, row, from, to) {
        // Puts the text of a row into the prompt and moves the cursor
        const caretAfter = from + row.insert.length - row.cursorBack;
        textarea.focus();
        textarea.setRangeText(row.insert, from, to, "end");
        textarea.setSelectionRange(caretAfter, caretAfter);

        // Tells the WebUI that the text changed. The event looks like normal typing
        // (inputType "insertText"). It also makes the lists look at the new text again,
        // so "<sampler_name:" directly shows the samplers.
        textarea.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: row.insert,
        }));
    }

    // ==================================================================
    // MODE 1: the keywords go into the list of Tag Autocomplete
    // ==================================================================

    let tacRegistered = false;
    let tacAnalysis = null;   // result of analyze() from the trigger check, used by parse()

    function tagAutocompleteReady() {
        // True when all parts of Tag Autocomplete that are needed exist
        try {
            return typeof PARSERS !== "undefined"
                && typeof BaseTagParser !== "undefined"
                && typeof AutocompleteResult !== "undefined"
                && typeof ResultType !== "undefined"
                && typeof window.insertTextAtCursor === "function"
                && typeof window.addResultsToList === "function"
                && typeof window.updateSelectionStyle === "function"
                && typeof window.getSortFunction === "function";
        } catch (error) {
            return false;
        }
    }

    function registerWithTagAutocomplete() {
        // Tag Autocomplete is loaded after this file, so this is tried again and again
        // until its functions exist. Returns true when everything is set up.
        if (tacRegistered) {
            return true;
        }
        if (!tagAutocompleteReady()) {
            return false;
        }
        tacRegistered = true;

        // ---- The parser: Tag Autocomplete asks it "is this yours?" and then for results ----
        class KeywordParser extends BaseTagParser {
            parse() {
                // Called without "this" by Tag Autocomplete, so only module variables are used
                const info = tacAnalysis;
                if (!info) {
                    return [];
                }
                return info.rows.map((row) => {
                    const result = new AutocompleteResult(row.label, ResultType.extra);
                    result.meta = row.meta;
                    // Marks the result as one of ours (see the wrapped functions below)
                    result.pk = { row: row };
                    return result;
                });
            }
        }

        PARSERS.push(new KeywordParser(() => {
            const textarea = document.activeElement;
            tacAnalysis = null;
            if (!isPromptBox(textarea)) {
                return false;
            }
            const info = analyzeTextarea(textarea);
            if (info.rows.length === 0) {
                return false;
            }
            tacAnalysis = info;
            return true;
        }));

        // ---- Our results always come first in the list (the LoRAs follow) ----
        const originalGetSortFunction = window.getSortFunction;
        window.getSortFunction = function (...args) {
            const baseSort = originalGetSortFunction.apply(this, args);
            return (a, b) => {
                const aIsOurs = Boolean(a.pk);
                const bIsOurs = Boolean(b.pk);
                if (aIsOurs !== bIsOurs) {
                    return aIsOurs ? -1 : 1;
                }
                // Ours keep the order of the keyword list (not alphabetical)
                if (aIsOurs && bIsOurs) {
                    return 0;
                }
                return baseSort(a, b);
            };
        };

        // ---- Choosing one of our results: we insert the text ourselves ----
        const originalInsert = window.insertTextAtCursor;
        window.insertTextAtCursor = function (textArea, result, ...args) {
            if (!result || !result.pk) {
                return originalInsert.call(this, textArea, result, ...args);
            }
            // Look at the text again: it may have changed since the list was made
            const info = analyze(textArea.value, textArea.selectionStart);
            // Stop searches that are still running, so they cannot reopen the list
            if (typeof autocompleteRun !== "undefined") {
                autocompleteRun++;
            }
            hideResults(textArea);
            insertRow(textArea, result.pk.row, info.from, info.to);
        };

        // ---- Blue names and preview images for our results ----
        const originalAddResults = window.addResultsToList;
        window.addResultsToList = function (textArea, resultList, ...args) {
            const returned = originalAddResults.call(this, textArea, resultList, ...args);
            try {
                decorateList(textArea, resultList);
            } catch (error) {
                console.error("[PromptKeywords] Could not decorate the list:", error);
            }
            return returned;
        };

        const originalSelection = window.updateSelectionStyle;
        window.updateSelectionStyle = async function (textArea, newIndex, ...args) {
            const returned = await originalSelection.call(this, textArea, newIndex, ...args);
            showPreviewInTagAutocomplete(textArea, newIndex);
            return returned;
        };

        return true;
    }

    function listItems(textArea) {
        const id = getTextAreaIdentifier(textArea);
        const list = gradioApp().querySelector(".autocompleteResults" + id + " ul");
        return list ? list.getElementsByTagName("li") : [];
    }

    function showPreviewInTagAutocomplete(textArea, index) {
        // Shows the image in the box that Tag Autocomplete uses for LoRA previews
        const result = index === null ? null : results[index];
        if (!result || !result.pk || !result.pk.row.preview) {
            return;
        }
        const id = getTextAreaIdentifier(textArea);
        const side = gradioApp().querySelector(".autocompleteParent" + id + " .sideInfo");
        if (!side) {
            return;
        }
        side.querySelector("img").src = result.pk.row.preview;
        side.style.display = "block";
    }

    function decorateList(textArea, resultList) {
        const items = listItems(textArea);
        for (let i = 0; i < items.length && i < resultList.length; i++) {
            const result = resultList[i];
            const item = items[i];
            if (!result || !result.pk || item.dataset.pkDone) {
                continue;
            }
            item.dataset.pkDone = "1";

            // Same blue as the LoRA names
            if (result.pk.row.blue) {
                const text = item.querySelector(".acListItem");
                if (text) {
                    text.classList.add("acLora");
                }
            }

            // Hovering a row with an image selects it, so its image is shown (as for LoRAs)
            if (result.pk.row.preview) {
                const index = i;
                item.addEventListener("mouseover", () => {
                    setTimeout(() => {
                        if (selectedTag === index) {
                            return;
                        }
                        oldSelectedTag = selectedTag;
                        selectedTag = index;
                        window.updateSelectionStyle(textArea, selectedTag, oldSelectedTag, false);
                    }, 150);
                });
            }
        }
    }

    // ==================================================================
    // MODE 2: an own popup (when Tag Autocomplete is not used)
    // ==================================================================

    let popup = null;        // the popup <div> (created on first use)
    let previewBox = null;   // the box with the preview image next to the popup
    let shown = [];          // rows currently shown
    let selected = 0;        // index of the highlighted row
    let box = null;          // the prompt box the popup belongs to
    let replaceFrom = 0;     // text between replaceFrom and replaceTo gets replaced
    let replaceTo = 0;       // when a row is accepted

    function addStyle() {
        const style = document.createElement("style");
        style.textContent = `
            .pk-popup {
                position: fixed;
                z-index: 100000;
                min-width: 220px;
                max-width: 420px;
                max-height: ${MAX_ROWS_HEIGHT_PX}px;
                overflow-y: auto;
                overflow-x: hidden;
                font-size: 14px;
                background: var(--pk-bg);
                color: var(--pk-text);
                border: var(--pk-border-width) solid var(--pk-border-color);
                border-radius: 12px;
            }
            .pk-row {
                display: flex;
                justify-content: space-between;
                gap: 16px;
                padding: 10px;
                cursor: pointer;
            }
            .pk-row:nth-child(odd) {
                background: var(--pk-bg-odd);
            }
            .pk-row.pk-selected {
                background: var(--pk-selected);
            }
            .pk-blue {
                color: var(--pk-blue);
            }
            .pk-meta {
                color: var(--pk-meta);
                white-space: nowrap;
            }
            .pk-preview {
                position: fixed;
                z-index: 100000;
                display: none;
                width: 16rem;
                height: 18rem;
                overflow: hidden;
                background: var(--pk-bg);
                border: var(--pk-border-width) solid var(--pk-border-color);
                border-radius: 12px;
            }
            .pk-preview img {
                display: block;
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
        `;
        document.head.appendChild(style);
    }

    function createPopup() {
        popup = document.createElement("div");
        popup.className = "pk-popup";
        popup.style.display = "none";
        // mousedown would take the focus away from the prompt box, so it is blocked
        popup.addEventListener("mousedown", (event) => event.preventDefault());
        document.body.appendChild(popup);

        previewBox = document.createElement("div");
        previewBox.className = "pk-preview";
        previewBox.appendChild(document.createElement("img"));
        document.body.appendChild(previewBox);
    }

    function applyTheme() {
        // Dark or light theme? Tag Autocomplete asks the same way (a ".dark" element).
        const isDark = document.querySelector(".dark") ||
            (typeof gradioApp === "function" && gradioApp().querySelector(".dark"));
        const colors = isDark ? THEMES.dark : THEMES.light;
        for (const element of [popup, previewBox]) {
            for (const name in colors) {
                element.style.setProperty(name, colors[name]);
            }
        }
    }

    function caretPosition(textarea) {
        // Pixel position of the cursor inside the textarea. A hidden copy of the
        // textarea (same font and width) is filled with the text before the cursor.
        // A marker at the end of that text shows where the cursor is.
        const mirror = document.createElement("div");
        const computed = getComputedStyle(textarea);
        for (const property of [
            "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle",
            "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "textIndent",
            "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
            "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
        ]) {
            mirror.style[property] = computed[property];
        }
        mirror.style.position = "absolute";
        mirror.style.visibility = "hidden";
        mirror.style.whiteSpace = "pre-wrap";
        mirror.style.overflowWrap = "break-word";
        mirror.textContent = textarea.value.substring(0, textarea.selectionStart);

        const marker = document.createElement("span");
        marker.textContent = "​";
        mirror.appendChild(marker);
        document.body.appendChild(mirror);

        const result = {
            left: marker.offsetLeft,
            top: marker.offsetTop,
            height: parseFloat(computed.lineHeight) || marker.offsetHeight || 18,
        };
        document.body.removeChild(mirror);
        return result;
    }

    function placePopup() {
        const rect = box.getBoundingClientRect();
        const caret = caretPosition(box);

        let left = rect.left + caret.left - box.scrollLeft;
        let top = rect.top + caret.top - box.scrollTop + caret.height;

        // Keep the popup inside the window
        const popupRect = popup.getBoundingClientRect();
        if (left + popupRect.width > window.innerWidth - 8) {
            left = window.innerWidth - popupRect.width - 8;
        }
        if (top + popupRect.height > window.innerHeight - 8) {
            // Not enough room below the cursor: show it above
            top = rect.top + caret.top - box.scrollTop - popupRect.height;
        }
        popup.style.left = Math.max(left, 4) + "px";
        popup.style.top = Math.max(top, 4) + "px";
    }

    function showPreview() {
        // Shows the image of the highlighted row next to the popup (if it has one)
        const row = shown[selected];
        if (!row || !row.preview) {
            previewBox.style.display = "none";
            return;
        }
        const image = previewBox.firstChild;
        image.onload = placePreview;
        image.src = row.preview;
        previewBox.style.display = "block";
        placePreview();
    }

    function placePreview() {
        // Right of the popup. If there is no room on the right, left of it.
        const popupRect = popup.getBoundingClientRect();
        const previewRect = previewBox.getBoundingClientRect();
        let left = popupRect.right + 6;
        if (left + previewRect.width > window.innerWidth - 4) {
            left = popupRect.left - previewRect.width - 6;
        }
        let top = popupRect.top;
        if (top + previewRect.height > window.innerHeight - 4) {
            top = window.innerHeight - previewRect.height - 4;
        }
        previewBox.style.left = Math.max(left, 4) + "px";
        previewBox.style.top = Math.max(top, 4) + "px";
    }

    function render() {
        popup.innerHTML = "";
        shown.forEach((row, index) => {
            const element = document.createElement("div");
            element.className = "pk-row" + (index === selected ? " pk-selected" : "");

            const label = document.createElement("span");
            label.textContent = row.label;
            if (row.blue) {
                label.className = "pk-blue";
            }
            element.appendChild(label);

            if (row.meta) {
                const meta = document.createElement("span");
                meta.className = "pk-meta";
                meta.textContent = row.meta;
                element.appendChild(meta);
            }

            element.addEventListener("click", () => accept(index));
            element.addEventListener("mousemove", () => {
                // Highlight the row under the mouse and show its preview.
                // (mousemove, not mouseenter: a list that is redrawn under a resting
                // mouse must not steal the selection from the arrow keys)
                if (selected === index) {
                    return;
                }
                selected = index;
                for (let i = 0; i < popup.children.length; i++) {
                    popup.children[i].classList.toggle("pk-selected", i === index);
                }
                showPreview();
            });
            popup.appendChild(element);
        });

        const selectedElement = popup.children[selected];
        if (selectedElement) {
            selectedElement.scrollIntoView({ block: "nearest" });
        }
        showPreview();
    }

    function hide() {
        shown = [];
        if (popup) {
            popup.style.display = "none";
            previewBox.style.display = "none";
        }
    }

    function isOpen() {
        return shown.length > 0;
    }

    function update(textarea) {
        if (tagAutocompleteInUse()) {
            hide();
            return;
        }
        // Reload the list in the background if it is old (never wait for it here)
        loadKeywords();

        const info = analyzeTextarea(textarea);
        box = textarea;
        shown = info.rows;
        replaceFrom = info.from;
        replaceTo = info.to;
        selected = 0;

        if (shown.length === 0) {
            hide();
            return;
        }
        if (!popup) {
            createPopup();
        }
        applyTheme();
        popup.style.display = "block";
        render();
        placePopup();
        showPreview();   // again, now that the popup has its final position
    }

    function accept(index) {
        const row = shown[index];
        if (!row) {
            return;
        }
        const textarea = box;
        hide();
        insertRow(textarea, row, replaceFrom, replaceTo);
    }

    // ------------------------------------------------------------------
    // Events of the own popup
    // ------------------------------------------------------------------

    function onInput(event) {
        if (isPromptBox(event.target) && !event.isComposing) {
            update(event.target);
        }
    }

    function onKeyDown(event) {
        // Only react while the popup is open and no modifier key (Ctrl, Alt...) is held
        if (!isOpen() || event.target !== box || event.ctrlKey || event.altKey || event.metaKey) {
            return;
        }

        let handled = true;
        if (event.key === "ArrowDown") {
            selected = (selected + 1) % shown.length;
            render();
        } else if (event.key === "ArrowUp") {
            selected = (selected - 1 + shown.length) % shown.length;
            render();
        } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
            accept(selected);
        } else if (event.key === "Escape") {
            hide();
        } else {
            handled = false;
        }

        if (handled) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    function onCursorMoved(event) {
        // The cursor was moved with the mouse or the arrow keys: check the text again
        if (!isPromptBox(event.target)) {
            return;
        }
        if (event.type === "keyup" && !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            return;
        }
        update(event.target);
    }

    function onFocusOut(event) {
        if (isPromptBox(event.target)) {
            hide();
        }
    }

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    function start() {
        addStyle();
        loadKeywords();   // load the list now, so it is ready at the first "<"

        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("input", onInput, true);
        document.addEventListener("click", onCursorMoved, true);
        document.addEventListener("keyup", onCursorMoved, true);
        document.addEventListener("focusout", onFocusOut, true);
        window.addEventListener("resize", hide);
        // Close the popup when the page scrolls (but not when the popup itself scrolls)
        window.addEventListener("scroll", (event) => {
            if (!popup || !popup.contains(event.target)) {
                hide();
            }
        }, true);

        // Tag Autocomplete is loaded after this file: try to connect to it until it works
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (registerWithTagAutocomplete() || tries > 240) {
                clearInterval(timer);
            }
        }, 500);
    }

    start();
})();
