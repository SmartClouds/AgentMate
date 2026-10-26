---
title: AI providers (OpenAI, Gemini, Ollama)
category: Settings
order: 20
summary: Add an OpenAI key, a Gemini key or a local Ollama server in Settings so Ask AI, Prompt Builder and the other AI features can talk to a model.
keywords: openai, gemini, ollama, api key, provider, model, chatgpt, google ai studio, local model, llm, context length, num_ctx, keep alive, test connection, prompt builder provider, ask ai, base url
---

AI providers are the three services Runova can call directly for a quick answer: OpenAI, Gemini and Ollama. You give Runova an API key (OpenAI, Gemini) or the address of a server (Ollama), pick a default model, and the features that need a model use it. Nothing here needs an AI CLI to be installed. Without a provider, Ask AI, Prompt Builder and the Help page's **Ask the guide** chat have nothing to talk to.

## Where to find it

Click **Settings** in the sidebar, then open the **AI** tab. The first card is **Providers** ("Keys and models used by Ask AI and Prompt Builder"). The **Voice input**, **Writing check** and **Translation retries** cards sit below it, see [Writing, voice and translation](writing-voice-translation.md). You can also type openai, gemini or ollama in the Settings search box to jump to it.

On Ask AI, the **Add API key** button next to the model picker opens Settings for you when the provider you chose has no key yet.

## Saving your changes

The **Providers** card does not save as you type. When you change a field, the Settings page shows "You have unsaved changes" and a bar at the bottom with **Discard** and **Save changes**. You can also press `Ctrl+S` (`Cmd+S` on macOS). A toast says "AI provider settings saved." when it worked. The **Test connection** button for Ollama works on what is typed in the box, before you save.

## Set up OpenAI

1. Create an API key at platform.openai.com/api-keys (the link under the field opens it).
2. In **Settings**, **AI**, **Providers**, find the **OpenAI** block and paste the key into **API key** (it starts with `sk-`). The small badge next to the heading changes from **No key** to **Key set**.
3. Check **Default model**. It is pre-filled with the app's default OpenAI model. Type another model id if you want a different one.
4. Click **Save changes**.

The **API key** field hides the key, with a button to show it. An empty key counts as not set, and you will see "Set an OpenAI API key in Settings first." in features that try to use it.

## Set up Gemini

1. Create a key at aistudio.google.com/apikey (the link under the field opens it).
2. In the **Gemini** block of **Providers**, paste it into **API key** (it starts with `AIza`). The badge shows **Key set**.
3. Check **Default model**. It is pre-filled with the app's default Gemini model. Type another model id if you prefer.
4. Click **Save changes**.

Once a Gemini key is saved, the Ask AI page loads the list of Gemini models your key can use, so you can pick from it there.

## Set up Ollama

Ollama runs models on your own computer (or on a server you control), so there is no API key and nothing leaves your network. Install Ollama from ollama.com and pull at least one model first (for example with `ollama pull <model>`).

1. In the **Ollama** block of **Providers**, check **Server URL**. The default is `http://localhost:11434`, which is right when Ollama runs on this machine. If it runs elsewhere, type that address.
2. Click **Test connection**. The badge next to **Ollama** turns to **Connected** (with the Ollama version) or **Not reachable**. A toast tells you how many models are installed. If Ollama answers but has no models, the toast suggests pulling one.
3. Open **Default model**. The list comes from the server. Use the refresh button beside it to reload the list after you pull a new model. You can clear the choice with the clear control.
4. Optionally set **Context length** and **Keep model in memory** (explained below).
5. Click **Save changes**.

### Context length

**Context length** is the number of tokens the model keeps in its window (Ollama calls it `num_ctx`). Leave it empty to use whatever the model ships with. Bigger values let you paste longer text but need more RAM or VRAM. The field only accepts digits.

### Keep model in memory

**Keep model in memory** is how long Ollama holds the model in RAM after a request (Ollama's `keep_alive`). Use values like `5m` or `1h`, `0` to free the memory right away, or `-1` to keep the model loaded. The default is `5m`. If you clear the field and save, it goes back to `5m`.

### If Ollama is not reachable

You will see "Could not reach Ollama at <address>. Is it running?" Start Ollama, check the address, and click **Test connection** again. Local models can be slow to load and answer on a CPU, so Ollama requests are allowed up to 10 minutes before Runova gives up. OpenAI and Gemini requests are stopped after 3 minutes with no answer.

## Choose which provider Prompt Builder uses

At the bottom of the **Providers** card, **Prompt Builder provider** (OpenAI, Gemini or Ollama) decides which provider the other AI features use when they do not ask you. It uses the key and default model of that provider from the blocks above. The default is OpenAI.

If that provider has no model set, features show "Set a <provider> model in Settings first." Ollama has no pre-filled model, so pick one in **Default model** before using it.

Ask AI is the exception. It has its own provider tabs and model picker, so you can switch provider there without touching this setting. See [Ask AI](ask-ai.md).

## Which features use these providers

| Feature | What it uses |
| --- | --- |
| [Ask AI](ask-ai.md) (page and popup) | The provider tab and model you pick in the chat. The first time, the model fields start from your Settings defaults. |
| [Prompt Builder](prompt-builder.md) **Generate Prompt** (page and the Build Prompt dialog) | The **Prompt Builder provider** and its default model. |
| Project **Blueprint** (see [Projects](projects.md)) | The **Written by** choice **AI provider (Settings)**, which is the fallback when no suitable AI CLI is installed. |
| Deploy **Assistant** | The AI choice **AI provider (Settings)** in its composer (selected by default). See [Deploy: Assistant and logs](deploy-assistant-logs.md). |
| The **Ask AI** dialog on an SSH terminal and on a Remote Desktop session | The choice **AI provider (Settings)**. Remote Desktop needs a model that can see images, because it sends screenshots. See [Remote](remote.md) and [Remote Desktop](remote-desktop.md). |
| The Help page's **Ask the guide** chat | Whichever provider you set up here. It also uses that provider's embedding model to find the right articles, which you can change in **Settings** > **AI** > **Help search**. See [Help center](help-center.md#choose-the-search-model). |

Translation, voice input and the writing check do not use these providers. They have their own settings, see [Writing, voice and translation](writing-voice-translation.md).

## How this differs from AI CLIs

AI CLIs (Claude Code, Codex, Gemini CLI and the others) are separate programs that Runova launches in a terminal. They read and edit your files, run commands and use their own login or subscription. You manage them in [AI CLI Manager](cli-manager.md).

AI providers are plain model calls with an API key or a local server. They answer a question or write some text and do nothing else: no file access, no commands. They are billed to your API account (OpenAI, Gemini) or run free on your hardware (Ollama).

Some features use a CLI and never touch these providers:

- Commit message suggestions use the CLI you choose in **Settings**, **Agents**, **Commit messages**.
- The **Recommended run** panel in Prompt Builder asks your default AI CLI (**Settings**, **Agents**, **Default CLI**, or the first installed one) to size a prompt.
- Agents you open in the Workspace are CLIs.

If a feature says it needs a CLI, install and sign in to one in [AI CLI Manager](cli-manager.md). If it says it needs a provider, set one up on this page.

## Privacy and proxies

Your keys are saved in Runova's settings on this computer. OpenAI and Gemini requests go straight from Runova to those services, so the text you send is subject to their terms. Ollama requests go only to the server address you entered. If you are behind a proxy, the AI providers follow the proxy settings under **Settings**, **Network**.

## Tips

- Use Ollama if you do not want text to leave your network. Pick a model that fits your RAM, and raise **Context length** only when you need it.
- If **Test connection** works but chats are slow, the model may be loading. Raise **Keep model in memory** to `1h` or `-1` so it stays loaded.
- If Ask AI shows a different provider than the one you saved, that is fine. Ask AI remembers its own last choice.

## Related

- [Ask AI](ask-ai.md)
- [Prompt Builder](prompt-builder.md)
- [Writing, voice and translation](writing-voice-translation.md)
- [AI CLI Manager](cli-manager.md)
- [Settings](settings.md)
- [Help center](help-center.md)
