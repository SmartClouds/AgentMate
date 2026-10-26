---
title: Ask AI
category: Build
order: 20
summary: A chat with OpenAI, Gemini or a local Ollama model, available as a full page and as a quick popup from any screen.
keywords: ask ai, chat, chatgpt, openai, gemini, ollama, assistant, conversation, history, bookmark, retry, copy, popup, model, question, llm
route: /ask-ai
---

Ask AI is a simple chat with an AI model. You type a question, pick which provider and model should answer, and get the reply as formatted text. It is one conversation that you can open in two ways: the full **Ask AI** page, or a quick popup you can open from anywhere in the app. Both show the same thread, and it is kept between sessions.

Ask AI talks straight to a provider (OpenAI, Gemini or Ollama). It cannot read your files or run commands. For that, use an AI CLI in the [Workspace](workspace-terminals-agents.md). You need an API key or an Ollama server first, see [AI providers](ai-providers.md).

## Where to find it

There are two ways in:

- Click **Ask AI** in the sidebar under **Build** (or open the command palette with `Ctrl+K` and type Ask AI). This opens the full page.
- Click the speech bubble button named **Ask AI** at the right end of the top bar. This opens the popup over whatever page you are on. The popup is titled "Ask AI, Quick chat with your configured provider."

There is no keyboard shortcut for the popup. Close it with `Esc` or the close button.

## Choose a provider and model

At the top of the chat, three tabs choose who answers: **OpenAI**, **Gemini** and **Ollama**. Next to them is a model picker for the tab you chose.

- **OpenAI**: pick from the list of models. The model from your Settings is selected the first time.
- **Gemini**: the picker loads the models your Gemini key can use. A refresh button reloads the list. If it fails, the picker says "Could not load models, check your API key."
- **Ollama**: the picker lists the models installed on your Ollama server. A refresh button reloads the list. If it is empty, you see "No models found. Is Ollama running?"

Each provider remembers its own model, and the chat remembers the last tab you used. Your Settings defaults only fill in a model the first time.

If the tab you picked has no API key, an **Add API key** button appears next to the picker. Click it to open Settings and add one. Ollama needs no key, so that button never shows for it.

## Send a message

1. Make sure a model is chosen. Without one you see "Choose a <provider> model first."
2. Type in the box at the bottom ("Type your question…").
3. Press `Enter` to send, or `Shift+Enter` for a new line. You can also click the round send button.

While the answer is on its way, three bouncing dots show in the chat. Messages from you appear on the right. Replies appear on the left with a small robot icon, rendered as Markdown (headings, lists, tables, links, inline code and code blocks). Under each reply a small line names the provider and model that wrote it.

The chat sends the conversation so far with each new question, so the model remembers what you said earlier in the thread. If you switch provider or model in the middle of a conversation, the new model sees the earlier messages too.

The box also has the writing check: misspelled words are underlined and a right-click offers fixes. See [Writing check, voice input and translation](writing-voice-translation.md).

### Start with a suggestion

An empty chat shows three suggestion chips: "Summarize what this project does", "Help me write a commit message" and "Explain an error I ran into". Click one to put it in the box, then edit it and send. Remember the chat cannot see your project, so paste in the details it needs.

## Copy, bookmark and retry

Every message has two small buttons under it:

- **Copy message** copies the message text to the clipboard.
- **Bookmark message** marks the message with a highlighted bookmark icon. Click it again (**Remove bookmark**) to unmark it. A bookmark is only a visual mark. There is no separate list of bookmarks yet.

If a request fails (for example a wrong key, no connection, or a timeout), the reply bubble turns red and shows the error. A **Retry** link appears next to it. Click **Retry** to send the same question again with the same provider and model, and the red message is replaced by the new answer. Retry sits only on error messages.

OpenAI and Gemini requests are stopped after 3 minutes without an answer. Ollama requests are allowed 10 minutes because local models can be slow.

## The full page

The **Ask AI** page shows the whole conversation in a large card, with the same provider tabs, model picker, message list and input box. Its header reads "Full conversation history, the same thread the Ask AI popup uses."

At the top right of the card, **Clear history** deletes every message in the thread. It is disabled when the chat is empty. There is no undo.

## The popup

The popup is a smaller dialog with the same chat in a fixed-height message area. When there is at least one message, two links appear under the box:

- **Clear** deletes the thread.
- **View full history** closes the popup and opens the full **Ask AI** page.

## Where your conversation is stored

The thread, the provider tab and the models you picked are saved on your computer and are still there after you restart Runova. Clearing the history removes the messages but keeps your provider and model choices.

## Tips

- Pick a fast, small model for quick questions and a stronger one for harder ones. You can change the model between messages.
- For a prompt that is meant to be handed to a coding agent, use [Prompt Builder](prompt-builder.md) instead. It writes the prompt for you and can open it in an agent.
- If answers keep failing with an authentication error, re-check the key in [AI providers](ai-providers.md).

## Related

- [AI providers](ai-providers.md)
- [Prompt Builder](prompt-builder.md)
- [Writing check, voice input and translation](writing-voice-translation.md)
- [Command palette and search](command-palette-search.md)
