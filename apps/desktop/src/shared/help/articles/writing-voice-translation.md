---
title: Writing check, voice input and translation
category: Settings
order: 70
summary: Set up grammar and spelling checks, dictating with your microphone, and translating text, all from the AI tab in Settings.
keywords: grammar, spelling, spellcheck, languagetool, writing check, style, proofread, voice input, dictate, microphone, whisper, speech to text, transcription, translate, translation, retries, persian, language
---

Three helpers make writing in AgentMate easier. The **writing check** underlines spelling, grammar and style problems in text boxes and offers fixes. **Voice input** turns what you say into text using a speech model that runs on your computer. **Translation** converts your text into another language, and Prompt Builder uses it to turn a request in any language into English. All three are set up in the **AI** tab of Settings.

## Where to find it

Click **Settings** in the sidebar and open the **AI** tab. Below the **Providers** card you will find **Voice input**, **Writing check** and **Translation retries**. Type grammar, whisper, voice or translate in the Settings search box to jump straight to them. The [AI providers](ai-providers.md) card at the top is separate and is not needed for any of these three.

## Saving your changes

**Writing check** saves each change the moment you make it. **Voice input** and **Translation retries** work like the rest of the Settings page: a change shows "You have unsaved changes" and you press **Save changes** (or `Ctrl+S`, `Cmd+S` on macOS) to keep it, or **Discard** to drop it.

## Writing check

The writing check uses LanguageTool to find spelling mistakes, grammar errors, punctuation problems and style suggestions. It works in text boxes across the app, including dialogs and the floating desktop widgets.

### Turn it on and tune it

In the **Writing check** card of Settings, **AI** tab:

| Setting | What it does |
| --- | --- |
| **Check my writing** | The master switch. Off means nothing is checked and no text leaves your computer. On by default. |
| **Underline as I type** | Checks a field shortly after you stop typing (about a second and a half) and underlines the problems. Off leaves only the right-click check. On by default. |
| **Include style suggestions** | Adds LanguageTool's stricter "picky" level: wordiness, repetition and typography on top of real mistakes. Off by default. |
| **Language** | **Auto-detect** (the default) works out the language of each field. You can also fix it to English (US), English (UK), German, French, Spanish, Portuguese, Italian, Dutch, Russian, Polish, Ukrainian, Arabic or Chinese. |
| **Native language** | Turns on false-friend rules, which catch mistakes speakers of that language tend to make. Choose **None** to leave them off. |

LanguageTool has no Persian rules. Persian text falls back to the built-in spellchecker (see below).

The last three controls are greyed out while **Check my writing** is off.

### Where the checks run

Under **Where checks run** you pick one of two sources:

- **LanguageTool online**: no setup. The text you check is sent to api.languagetool.org. The free service limits a check to the first 20,000 characters.
- **Local server**: offline and unlimited. It needs the LanguageTool download and Java 17 or newer. A local check covers up to the first 60,000 characters.

When a text is longer than the limit, the writing check panel says only the first part was checked.

### Set up the local server

Pick **Local server** to see the setup panel. It shows badges for the server state (**Server running**, **Starting…**, **Failed**, **Stopped**), the LanguageTool version it found, and the Java version it found.

1. Click **Download** to get the LanguageTool desktop zip.
2. Click **Open tools folder** and extract the zip into it. A folder named like LanguageTool-6.x inside is fine. The panel prints the exact folder path.
3. Click **Start server**. It takes a few seconds while the rules load. AgentMate stops the server when it quits.
4. Use **Re-check** if you changed something and the badges are out of date, and **Stop server** to stop it by hand.

The **Port** field (default 8081, allowed range 1024 to 65535) is the port the server listens on. If something is already serving LanguageTool on that port, for example in Docker, AgentMate uses it as it is.

**Start server** stays disabled until LanguageTool is in the tools folder and Java is found. If your Java is older than 17, the panel warns you: install a newer JDK or stay on the online check.

### Muted rules

When you choose **Never flag this rule** from the writing menu, the rule shows up as a chip under **Muted rules**. Click a chip to unmute that rule.

### The issue counter and review panel

Larger writing fields (for example the request box in [Prompt Builder](prompt-builder.md), the project Build Prompt dialog and Markdown editors) draw a small counter in the bottom right corner. It reads **Checking…**, **No issues**, **Check failed** or a number such as **3 issues**. Click it to open the **Writing check** panel.

The panel header shows the detected language and a **Local** or **Online** badge. Each issue lists:

- its type (spelling, grammar, punctuation, typography, style) with a colored dot,
- the flagged text (click it to jump to it in the field),
- the explanation,
- up to four suggestion buttons. Click one to apply it.
- an **X** button, "Ignore this one", to dismiss that issue.

At the bottom, **Check again** re-runs the check and **Fix N mistakes** applies the top suggestion for every spelling, grammar and punctuation issue at once. Style suggestions are never applied automatically, so they stay as you wrote them.

### The right-click writing menu

Right-click in any text field (including single-line inputs) to open AgentMate's own writing menu instead of the system one. It offers:

- spelling or grammar suggestions, first in the list,
- **Ignore** (this one issue),
- **Never flag this rule** (adds it to the muted rules),
- **Add to dictionary** for a misspelled word (not on macOS, where the system dictionary cannot be changed from the app),
- **Next issue (N left)** or **Go to the other issue**, to jump through the remaining problems,
- **Check the grammar here** or **Check writing again**, which run a check on the spot when nothing has been checked yet.

Below those, every text field's menu ends with **Cut**, **Copy**, **Paste** and **Select all**, each showing its usual key. An item is greyed out when it does not apply: Cut and Copy with nothing selected (and always in a password field), Paste with nothing on the clipboard. In a field with nothing to say about the writing, such as an empty one, the menu is just those four.

When there is nothing to report, the menu says "No writing issues here". Use the arrow keys and `Enter` or `Tab` to pick an item, and `Escape` to close it. If the menu holds only the four edit commands, nothing is highlighted until you press an arrow key, so `Enter` and `Tab` carry on as normal. Typing or deleting closes the menu.

## Spellcheck

Separately from LanguageTool, every text box has the built-in spellchecker of the app's browser engine. It draws a red wavy underline under misspelled words. It uses the languages of your operating system first and always adds English (US), with at most three dictionaries active at once. On macOS the system spellchecker is used instead. Right-click a flagged word to see its suggestions in the writing menu.

Fields that hold things like keys and URLs turn spellcheck off on purpose.

## Voice input

Voice input lets you dictate a request instead of typing it. The speech model (Whisper) runs on your computer, so your audio is not sent to a speech service.

### Where you can dictate

The microphone button appears next to **Your request** in two places:

- the [Prompt Builder](prompt-builder.md) page, labeled **Record voice input**,
- the **Build Prompt** dialog of a project, labeled **Dictate**.

The **Build Prompt** dialog also has a second microphone, **Speak prompt**, above **Generated prompt**. It is for when you already know exactly what you want to say: speak in English and your words become the prompt as they are, with nothing generated and nothing translated. It always listens for English, whatever language Dictate is set to.

Only one microphone records at a time; the other one waits until you are done.

The buttons are hidden if your system cannot record audio. The pinned Build Prompt desktop widget has no microphone button.

### Dictate a request

1. Click the microphone button. The first time, allow microphone access when asked.
2. Speak. The button turns red and says **Stop recording** (in the dialog, **Stop** with a running clock such as **Stop 0:12**).
3. Click it again. The button shows **Transcribing…**, then your words are added to the end of whatever is already in the box, separated by a space.

In the dialog you can throw a recording away instead: press `Esc` or click the **×** next to **Stop**. Nothing is transcribed and the dialog stays open.

If the recording is very short or silent, nothing is sent to the speech model and you see "Didn't catch anything. Try again a little closer to the mic." This keeps the model from inventing words for silence.

### Dictation language

In the **Build Prompt** dialog, the chip next to **Dictate** (**EN**, **FA** and so on) shows the language Dictate listens for. Click it to pick another; the choice is saved as your **Spoken language** setting. The speech model has to be told the language up front, so speak the language the chip shows.

If the chip shows a warning sign, the current model is too small for that language. Persian needs **Large v3 Turbo**: the smaller models write Persian as a jumble of half-right words. Open the chip and pick **Use a model that understands Persian** to switch.

The very first use also downloads the speech model, and the button shows **Downloading model… N%** (just the percentage in the dialog). The model is downloaded once and then kept on disk, so later dictation works without internet. Long recordings are processed in 30 second pieces. **Large v3 Turbo** is slower than the others: on a typical laptop processor expect about two seconds of waiting for each second you spoke, and a short extra pause the first time it loads after the app starts.

If the dialog is closed while you are recording, the microphone is stopped and the recording is still transcribed into that project's saved request.

If something goes wrong a message appears, for example "Microphone access was blocked. Allow it to use voice input." or "No microphone was found."

### Voice input settings

In the **Voice input** card ("Local Whisper transcription for Prompt Builder. The model downloads once and stays cached."):

| Setting | Options |
| --- | --- |
| **Model** | **Tiny** (fastest, about 75 MB), **Base** (balanced, about 145 MB, the default), **Small** (about 490 MB), **Large v3 Turbo** (most accurate, about 760 MB, the one to use for Persian). A bigger model understands you better but is slower and takes more disk space. |
| **Spoken language** | English, Persian, Spanish, French, German, Arabic, Chinese, Russian, Hindi or Turkish. There is no auto-detect: the local model cannot tell languages apart, and left to guess it treats everything as English, which turns Persian speech into made-up English. Settings saved as Auto-detect by older versions now use your system language, or English. |

Switching the **Model** downloads the new one the next time you dictate.

## Translation

Translation turns text into another language. It needs an internet connection and no account or API key. The text is sent to Google's free online translation service, so do not translate anything you must keep private.

### Where translation is used

- **Prompt Builder page**: the **Translate** button under "or translate directly" converts your request into the language you choose in the picker next to it (English, Persian, Spanish, French, German, Arabic, Chinese (Simplified), Russian, Hindi or Turkish). **Generate Prompt** also translates your request to English first, whatever language you typed in, before the prompt is written.
- **Build Prompt dialog of a project**: **Translate** copies your request into English without generating a prompt.
- A project's **Blueprint** and the "Describe <project>" dialog (shown when AgentMate scaffolds a new project's files) translate your text to English the same way.

Long text is sent in pieces of about 1,200 characters, one after another, and put back together with your line breaks kept. Each piece gives up if the service does not answer within 15 seconds.

### Translation retries

If a translation request fails, AgentMate tries again. In the **Translation retries** card ("Extra attempts Prompt Builder makes if a translate request fails.") enter how many extra attempts you want, from 0 to 10. The default is 3. With 0, a failure is reported straight away. There is a short, growing pause between attempts. Press **Save changes** to keep the number.

If every attempt fails you see "Translation failed. Check your internet connection and try again."

## Tips

- If the online writing check feels slow or you do not want text to leave your computer, switch to the **Local server** and install Java 17 or newer.
- Dictating in a language other than English? Set **Spoken language** explicitly. It is more reliable than auto-detect for short phrases.
- Use **Tiny** for quick commands and **Small** for long, careful dictation.
- If the writing check never underlines anything, check that **Check my writing** is on and that **Underline as I type** is on. You can always right-click for a check on demand.

## Related

- [Prompt Builder](prompt-builder.md)
- [AI providers](ai-providers.md)
- [Settings](settings.md)
- [Troubleshooting](troubleshooting.md)
