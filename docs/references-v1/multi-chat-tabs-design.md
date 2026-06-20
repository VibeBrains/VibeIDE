# Multi-chat tabs — design notes (H.4)

> Status: normative for current behavior, with explicit backlog for the gaps.
> Source roadmap entries: H.4 — «Multi-chat tabs», K.4 — «Multi-chat tabs added risks».

## Current behavior

Implemented in `vibeideChatPane.ts` and related contributions:

- A new chat tab is opened by `VIBEIDE_NEW_CHAT_CMD` (default keybinding `Ctrl+Shift+T`,
  configurable).
- `vibeide.chat.maxOpenTabs` (default = 5) caps the number of open chat tabs per window.
- Each tab is bound to a `chatId` and a `threadId` via the chat thread service.
- Drag-and-drop between editor groups follows VS Code stock behavior — the tab carries its
  identity (chatId) into the new group.
- The lockdown listener prevents opening a chat tab while a blocking modal is active.

What is **not** implemented yet (open backlog from K.4):

1. Thread-deletion-while-tab-open policy.
2. Tab-limit edge-case UX (graceful close-LRU instead of plain block).
3. `IEditorSerializer` decision (right now: not serializable → tabs lost on reload).
4. Drag-and-drop verification across editor groups.

## Decision: thread deletion

When a thread is deleted (user invokes `Delete chat history` or
`vibeide.chatThread.delete`), the editor binding registry receives an
`onThreadDeleted(threadId)` event. Bound tabs are **closed with a one-line confirmation**:

> «Чат удалён, окно закрыто.»

We do not introduce a “rebind to another thread” flow — that produces zombie tabs whose
content disappears under the user's mouse. Closing is the simpler, more predictable
behavior. If the user wants the messages back, they had a chance to use “Save as skill”
before deletion.

## Decision: tab-limit edge case

When the user opens an N+1-th tab and N = `vibeide.chat.maxOpenTabs`:

- Look up the **least-recently-focused** tab in the window via
  `IBindingRegistry.getLastFocusedAt(tabId)`.
- If that tab has no streaming session active (`streamState === 'idle'`), close it
  silently and open the new tab in its place.
- If the LRU tab is streaming or paused on a guard, show a notification:

> «Достигнут лимит открытых чатов (N). Закройте один из активных чатов или измените
> `vibeide.chat.maxOpenTabs`.»

This is a strict behavior change from the current "block at limit" implementation — the
LRU close is the desirable one.

## Decision: editor serializer

We **do** ship a minimal serializer. It serializes `{ chatId, threadId }` only, never the
message body. On window reload:

- The serializer rehydrates the tab.
- The chat thread service is asked for the thread by id (`IChatThreadService.getThread`).
- If the thread no longer exists (was deleted in another window or by external script),
  the tab opens with an empty placeholder and a one-line notice: «Чат не найден, начните
  новый.»

Serializing message bodies into editor state is rejected because:

- Editor state is stored in workspace state, not in `.vibe/`. Cross-machine sync is via
  thread store, not editor state.
- The thread store is the source of truth; duplicating bodies into editor state creates
  drift after multi-window edits.

## Decision: drag-and-drop across editor groups

`chatId` survives drag-and-drop because it is part of the editor input identity (returned
by `IEditorInput.getResource()`). A unit test (`vibeChatTabBinding.test.ts`, backlog)
exercises split + drag.

## Backlog

- Implement `onThreadDeleted` event in `IChatThreadService` and the close-tab handler in
  `vibeideChatPane.ts`.
- Implement LRU close-and-replace for tab limit.
- Implement minimal `IEditorSerializer` for chat editors.
- Add `vibeChatTabBinding.test.ts` covering thread deletion, tab limit, reload, and DnD.
- Cross-link this document from `vibeideChatPane.ts` header comment.
