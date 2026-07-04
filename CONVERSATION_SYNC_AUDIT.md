# Conversation Sync Audit

1. `messaging-history.set` is handled in `src/services/sync/service.ts` inside `bindSocket()` and `handleHistorySync()`.
2. `chats.upsert` is handled in `src/services/sync/service.ts` inside `bindSocket()` and `handleChatsSync()`.
3. `chats.update` is handled in `src/services/sync/service.ts` inside `bindSocket()` and `handleChatsSync()`.
4. `messages.upsert` is handled in `src/services/sync/service.ts` inside `bindSocket()` and `handleMessagesSync()`.
5. Rows in `whatsapp_conversations` are created by `src/services/sync/repositories/conversation-repository.ts` and by `src/services/sync/repositories/message-repository.ts` when a message arrives for a missing conversation.
6. Contact-based conversation seeding is currently performed by `src/services/sync/service.ts` through `runContactBootstrap()`, which uses contacts to seed conversations only as a fallback.
7. Unread counts are updated in `src/services/sync/repositories/conversation-repository.ts` when chats are upserted or conversation summaries are written from messages.
8. `last_message` is updated in `src/services/sync/repositories/conversation-repository.ts` during chat upserts and message summary upserts.

## Refactor Boundary

The refactor keeps conversation creation deterministic and event-driven:

- History sync creates conversations from discovered chats first.
- Live chat events upsert missing conversations next.
- Incoming messages create missing conversations as the final fallback.
- Contact bootstrap only runs when initial history sync completed, no conversations exist, no chats were discovered, and contacts are available.
