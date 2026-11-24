// ---------------------------------------------------------------------------
// PromptKeywords autocomplete
// ---------------------------------------------------------------------------
//
// Suggests the keywords when you type "<" in a prompt box. Typing more letters
// filters the list ("<cf" shows cfg_scale). Some keywords also suggest their
// values ("<sampler_name:" lists the samplers, "<checkpoint:" the checkpoints).
//
// This file needs the extension "Tag Autocomplete". It does not draw a list of
// its own: it adds the keywords to the list of Tag Autocomplete. So "<" shows
// the LoRAs of Tag Autocomplete first and the keywords below them.
//
// Some words used in this file:
//   suggestion = one line of our list: a keyword or a value of a keyword
//   result     = one line in the list of Tag Autocomplete (an AutocompleteResult).
//                A result of ours carries its suggestion in result.keywordSuggestion,
//                results of Tag Autocomplete (LoRAs ...) do not have that.
//   list item  = the <li> element of a result on the screen
//
// The keyword list is loaded from the Python script (all_keywords),
// so new keywords show up here without changing this file.

(function () {
    // The four prompt boxes (positive and negative, txt2img and img2img)
    const PROMPT_BOXES =
        "#txt2img_prompt textarea, #txt2img_neg_prompt textarea, " +
        "#img2img_prompt textarea, #img2img_neg_prompt textarea";

    // Keywords are only reloaded from Python if the last load is older than this
    const RELOAD_AFTER_MS = 10000;

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

    function filterByText(items, getName, text) {
        // Keeps the items that contain the text. Items that start with it come first.
        text = text.toLowerCase();
        const startWith = [];
        const contain = [];
        for (const item of items) {
            const name = getName(item).toLowerCase();
            if (name.startsWith(text)) {
                startWith.push(item);
            } else if (name.includes(text)) {
                contain.push(item);
            }
        }
        return startWith.concat(contain);
    }

    // ------------------------------------------------------------------
    // Finding out what the user is typing
    // ------------------------------------------------------------------
    //
    // Both functions look at the text before the cursor and return an object:
    //   suggestions = [{label, meta, insert, cursorBack, preview, blue}]
    //   from, to    = the part of the prompt that a chosen suggestion replaces
    // or null if the text before the cursor is not what the function looks for.

    function suggestKeywordNames(textBeforeCursor, caret) {
        // "<" followed by letters, e.g. "<cf" -> suggest the keyword names
        const match = textBeforeCursor.match(/<([A-Za-z_]*)$/);
        if (!match) {
            return null;
        }
        const typedLetters = match[1];
        const foundKeywords = filterByText(keywords, (keyword) => keyword.name, typedLetters);
        const suggestions = foundKeywords.map((keyword) => ({
            label: keyword.name,
            meta: [keyword.type, keyword.where].filter(Boolean).join(" · "),
            // "<name:>" and the cursor is placed before the ">"
            insert: "<" + keyword.name + ":>",
            cursorBack: 1,
            preview: "",
            blue: false,
        }));
        return { suggestions: suggestions, from: caret - match[0].length, to: caret };
    }

    function suggestKeywordValues(promptText, textBeforeCursor, caret) {
        // "<name:" followed by the start of a value, e.g. "<sampler_name:eu"
        // -> suggest the values of that keyword
        const match = textBeforeCursor.match(/<([A-Za-z_]+):([^<>]*)$/);
        if (!match) {
            return null;
        }
        const keywordName = match[1];
        const typedLetters = match[2];
        const keyword = keywords.find((k) => k.name === keywordName);
        if (!keyword || keyword.values.length === 0) {
            return null;
        }

        // A ">" right behind the cursor belongs to the tag and is replaced too
        let to = caret;
        if (promptText[to] === ">") {
            to += 1;
        }

        const foundValues = filterByText(keyword.values, (value) => value, typedLetters);
        const suggestions = foundValues.map((value) => ({
            label: value,
            meta: "",
            insert: "<" + keyword.name + ":" + value + ">",
            cursorBack: 0,
            preview: (keyword.previews || {})[value] || "",
            blue: keyword.name === "checkpoint",
        }));
        return { suggestions: suggestions, from: caret - match[0].length, to: to };
    }

    function findSuggestions(promptText, caret) {
        // Returns the suggestions for the text before the cursor (or an empty list)
        const textBeforeCursor = promptText.substring(0, caret);
        const found =
            suggestKeywordNames(textBeforeCursor, caret) ||
            suggestKeywordValues(promptText, textBeforeCursor, caret);
        return found || { suggestions: [], from: 0, to: 0 };
    }

    function findSuggestionsFor(textarea) {
        // Same as findSuggestions, but only if the autocomplete is switched on,
        // the keywords are loaded and no text is selected
        if (!autocompleteEnabled() || keywords.length === 0 || textarea.selectionStart !== textarea.selectionEnd) {
            return { suggestions: [], from: 0, to: 0 };
        }
        return findSuggestions(textarea.value, textarea.selectionStart);
    }

    function insertSuggestion(textarea, suggestion, from, to) {
        // Puts the text of a suggestion into the prompt and moves the cursor
        const caretAfter = from + suggestion.insert.length - suggestion.cursorBack;
        textarea.focus();
        textarea.setRangeText(suggestion.insert, from, to, "end");
        textarea.setSelectionRange(caretAfter, caretAfter);

        // Tells the WebUI that the text changed. The event looks like normal typing
        // (inputType "insertText"). It also makes the lists look at the new text again,
        // so "<sampler_name:" directly shows the samplers.
        textarea.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: suggestion.insert,
        }));
    }

    // ------------------------------------------------------------------
    // Connecting to Tag Autocomplete
    // ------------------------------------------------------------------
    //
    // Tag Autocomplete has no official way to add things, so a few of its functions
    // are replaced here by our own version. Each of them does its own work and then
    // calls the original function ("monkey patching"). Results of Tag Autocomplete
    // (LoRAs ...) are always passed on to the original unchanged.

    let connectedToTagAutocomplete = false;

    // The suggestions that the parser found when Tag Autocomplete asked "is this yours?".
    // The parser needs them again a moment later when Tag Autocomplete asks for the results.
    let currentSuggestions = null;

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

    function connectToTagAutocomplete() {
        // Tag Autocomplete is loaded after this file, so this is tried again and again
        // until its functions exist. Returns true when everything is set up.
        if (connectedToTagAutocomplete) {
            return true;
        }
        if (!tagAutocompleteReady()) {
            return false;
        }
        connectedToTagAutocomplete = true;

        addKeywordParser();
        sortKeywordsAfterOtherResults();
        insertKeywordsOurselves();
        addColorsAndPreviews();
        return true;
    }

    function addKeywordParser() {
        // A parser is a part of Tag Autocomplete that suggests one kind of thing
        // (LoRAs, embeddings ...). Ours suggests the keywords.
        class KeywordParser extends BaseTagParser {
            parse() {
                // Tag Autocomplete calls this without "this", so only variables
                // outside of the class are used here.
                if (!currentSuggestions) {
                    return [];
                }
                return currentSuggestions.suggestions.map((suggestion) => {
                    const result = new AutocompleteResult(suggestion.label, ResultType.extra);
                    result.meta = suggestion.meta;
                    // Marks the result as one of ours (the functions below look for it)
                    result.keywordSuggestion = suggestion;
                    // After our sorting, Tag Autocomplete sorts by "archRank" (0 = LoRA of the
                    // current architecture, 1 = unknown, 2 = other architecture). 3 keeps the
                    // keywords below ALL LoRAs.
                    result.archRank = 3;
                    return result;
                });
            }
        }

        // The first function is the question "is this yours?": true if there is
        // something to suggest for the text before the cursor.
        PARSERS.push(new KeywordParser(() => {
            loadKeywords();   // reloads the keywords in the background if the list is old
            currentSuggestions = null;
            const textarea = document.activeElement;
            if (!isPromptBox(textarea)) {
                return false;
            }
            const found = findSuggestionsFor(textarea);
            if (found.suggestions.length === 0) {
                return false;
            }
            currentSuggestions = found;
            return true;
        }));
    }

    function sortKeywordsAfterOtherResults() {
        // Our results come last. The others are sorted by Tag Autocomplete as usual.
        const originalGetSortFunction = window.getSortFunction;
        window.getSortFunction = function (...args) {
            const sortOthers = originalGetSortFunction.apply(this, args);
            return (a, b) => {
                const aIsOurs = Boolean(a.keywordSuggestion);
                const bIsOurs = Boolean(b.keywordSuggestion);
                if (aIsOurs !== bIsOurs) {
                    return aIsOurs ? 1 : -1;
                }
                // Ours keep the order of the keyword list (not alphabetical)
                if (aIsOurs && bIsOurs) {
                    return 0;
                }
                return sortOthers(a, b);
            };
        };
    }

    function insertKeywordsOurselves() {
        // When a result of ours is chosen, we insert its text ourselves
        // (Tag Autocomplete would not know how to insert a keyword).
        const originalInsert = window.insertTextAtCursor;
        window.insertTextAtCursor = function (textArea, result, ...args) {
            if (!result || !result.keywordSuggestion) {
                return originalInsert.call(this, textArea, result, ...args);
            }
            // Look at the text again: it may have changed since the list was made
            const found = findSuggestions(textArea.value, textArea.selectionStart);
            // Stop searches that are still running, so they cannot reopen the list
            if (typeof autocompleteRun !== "undefined") {
                autocompleteRun++;
            }
            hideResults(textArea);
            insertSuggestion(textArea, result.keywordSuggestion, found.from, found.to);
        };
    }

    function addColorsAndPreviews() {
        // Blue names and preview images for our results
        const originalAddResults = window.addResultsToList;
        window.addResultsToList = function (textArea, resultList, ...args) {
            const returned = originalAddResults.call(this, textArea, resultList, ...args);
            try {
                decorateListItems(textArea, resultList);
            } catch (error) {
                console.error("[PromptKeywords] Could not decorate the list:", error);
            }
            return returned;
        };

        // The preview box is shown when a result is selected (with the keys or the mouse)
        const originalUpdateSelection = window.updateSelectionStyle;
        window.updateSelectionStyle = async function (textArea, newIndex, ...args) {
            const returned = await originalUpdateSelection.call(this, textArea, newIndex, ...args);
            showPreviewInTagAutocomplete(textArea, newIndex);
            return returned;
        };
    }

    function listItemsOf(textArea) {
        // The <li> elements that are on the screen right now
        const id = getTextAreaIdentifier(textArea);
        const list = gradioApp().querySelector(".autocompleteResults" + id + " ul");
        return list ? list.getElementsByTagName("li") : [];
    }

    function showPreviewInTagAutocomplete(textArea, index) {
        // Shows the image in the box that Tag Autocomplete uses for LoRA previews.
        // (results is the list of all results, a variable of Tag Autocomplete)
        const result = index === null ? null : results[index];
        if (!result || !result.keywordSuggestion || !result.keywordSuggestion.preview) {
            return;
        }
        const id = getTextAreaIdentifier(textArea);
        const previewBox = gradioApp().querySelector(".autocompleteParent" + id + " .sideInfo");
        if (!previewBox) {
            return;
        }
        previewBox.querySelector("img").src = result.keywordSuggestion.preview;
        previewBox.style.display = "block";
    }

    function decorateListItems(textArea, resultList) {
        // Goes through the list on the screen. The list item number i belongs to
        // the result number i.
        const listItems = listItemsOf(textArea);
        for (let i = 0; i < listItems.length && i < resultList.length; i++) {
            const result = resultList[i];
            const listItem = listItems[i];
            // Only our own results, and every list item only once
            if (!result || !result.keywordSuggestion || listItem.dataset.keywordDecorated) {
                continue;
            }
            listItem.dataset.keywordDecorated = "1";
            const suggestion = result.keywordSuggestion;

            // Same blue as the LoRA names
            if (suggestion.blue) {
                const nameElement = listItem.querySelector(".acListItem");
                if (nameElement) {
                    nameElement.classList.add("acLora");
                }
            }

            // Hovering a list item with an image selects it, so its image is shown (as for LoRAs)
            if (suggestion.preview) {
                listItem.addEventListener("mouseover", () => {
                    setTimeout(() => {
                        if (selectedTag === i) {
                            return;
                        }
                        oldSelectedTag = selectedTag;
                        selectedTag = i;
                        window.updateSelectionStyle(textArea, selectedTag, oldSelectedTag, false);
                    }, 150);
                });
            }
        }
    }

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    function start() {
        loadKeywords();   // load the list now, so it is ready at the first "<"

        // Tag Autocomplete is loaded after this file: try to connect to it until it works
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (connectToTagAutocomplete() || tries > 240) {
                clearInterval(timer);
            }
        }, 500);
    }

    start();
})();
