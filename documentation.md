# API Documentation

This project exposes a REST API, a Socket.IO realtime channel, and outbound webhooks.

## Base URL

All REST endpoints are mounted under:

```text
/api
```

Uploaded media files are served from:

```text
/media
```

## Common Response Format

Most successful endpoints return:

```json
{
  "success": true,
  "data": {}
}
```

Common error responses return:

```json
{
  "success": false,
  "error": {
    "message": "Readable error message"
  }
}
```

The health check is an exception and returns a plain JSON object.

## Health

### `GET /api/health`

Returns the service status and version.

Response:

```json
{
  "status": "online",
  "version": "1.0.0"
}
```

## Sessions

Sessions represent WhatsApp connections tracked by the gateway.

### Session View

Session endpoints return a `SessionView` object with these fields:

- `id`
- `workspaceId`
- `connectionId`
- `status`
- `connectionState`
- `qr`
- `phone`
- `displayName`
- `battery.level`
- `createdAt`
- `updatedAt`

### `POST /api/sessions`

Creates a new session.

Request body:

```json
{
  "workspaceId": "workspace_123",
  "connectionId": "connection_abc"
}
```

Validation rules:

- `workspaceId` is required
- `connectionId` is required
- `connectionId` must be 3-128 characters and contain only letters, numbers, hyphens, or underscores

Success response:

- Status: `201`
- Body: the created session view

### `GET /api/sessions`

Lists all sessions.

Success response:

- Status: `200`
- Body: an array of session views

### `GET /api/sessions/:id`

Fetches a single session by id.

Success response:

- Status: `200`
- Body: a session view

Common errors:

- `404 Session not found`
- `400 id must be a valid UUID`

### `GET /api/sessions/:id/qr`

Returns the QR code for a session when available.

Success response:

```json
{
  "success": true,
  "data": {
    "id": "session-id",
    "qr": "qr-string"
  }
}
```

Common errors:

- `404 Session not found`
- `409 QR not available`

### `DELETE /api/sessions/:id`

Deletes a session.

Success response:

- Status: `200`
- Body: the deleted session view

### `POST /api/sessions/:id/reconnect`

Restarts an existing session connection.

Success response:

- Status: `200`
- Body: the restarted session view

## Messages

### `POST /api/messages/text`

Sends a text message through a connected session.

Request body:

```json
{
  "connectionId": "connection_abc",
  "chatId": "15551234567@s.whatsapp.net",
  "text": "Hello"
}
```

Validation rules:

- `connectionId` is required
- `chatId` is required
- `text` is required

Success response:

- Status: `201`
- Body:

```json
{
  "messageId": "message-id",
  "timestamp": "2026-07-03T18:00:00.000Z",
  "status": "SENT"
}
```

Common errors:

- `404 Session not found`
- `409 Session is not connected`
- `409 Session client is unavailable`
- `502 Failed to send message`

### `POST /api/messages/media`

Sends a media message through a connected session.

Request type:

- `multipart/form-data`

Form fields:

- `connectionId` required
- `chatId` required
- `caption` optional
- `file` required, uploaded under the field name `file`

Success response:

- Status: `201`
- Body:

```json
{
  "messageId": "message-id",
  "status": "SENT",
  "mediaUrl": "http://localhost:3001/media/uploaded-file-name"
}
```

Notes:

- The server stores uploaded files under `uploads/media`
- The returned `mediaUrl` is an absolute URL built from the current request
- Unsupported media types return `415 Unsupported media type`

Common errors:

- `404 Session not found`
- `409 Session is not connected`
- `409 Session client is unavailable`
- `413` when the uploaded file exceeds the configured multer limit
- `415 Unsupported media type`
- `502 Failed to send media message`

## Webhooks

Webhooks let you subscribe to session and message events.

### Supported Events

- `session.connected`
- `session.disconnected`
- `message.received`
- `message.sent`
- `message.delivered`
- `message.read`

### `POST /api/webhooks`

Registers a webhook.

Request body:

```json
{
  "url": "https://example.com/webhooks/whatsoba",
  "secret": "optional-shared-secret",
  "events": ["session.connected", "message.sent"]
}
```

Validation rules:

- `url` is required
- `url` must use `http` or `https`
- `secret` is optional
- `events` is optional
- `events` may be sent as an array or as a comma-separated string
- invalid event names are rejected

If `secret` is omitted, the server generates one and returns it once in the create response.

Success response:

- Status: `201`
- Body:

```json
{
  "id": "webhook-id",
  "url": "https://example.com/webhooks/whatsoba",
  "events": ["session.connected", "message.sent"],
  "enabled": true,
  "secretConfigured": true,
  "createdAt": "2026-07-03T18:00:00.000Z",
  "updatedAt": "2026-07-03T18:00:00.000Z",
  "secret": "shared-secret"
}
```

### `GET /api/webhooks`

Lists all registered webhooks.

Success response:

```json
{
  "success": true,
  "data": {
    "webhooks": []
  }
}
```

Each webhook includes:

- `id`
- `url`
- `events`
- `enabled`
- `secretConfigured`
- `createdAt`
- `updatedAt`

### `GET /api/webhooks/:id`

Fetches a webhook and its delivery summary.

Success response:

```json
{
  "success": true,
  "data": {
    "webhook": {},
    "deliveryStatus": {
      "pending": 0,
      "retrying": 0,
      "delivered": 0,
      "failed": 0,
      "total": 0
    }
  }
}
```

### `GET /api/webhooks/:id/deliveries`

Returns delivery logs for a webhook.

Success response:

```json
{
  "success": true,
  "data": {
    "webhookId": "webhook-id",
    "summary": {
      "pending": 0,
      "retrying": 0,
      "delivered": 0,
      "failed": 0,
      "total": 0
    },
    "logs": []
  }
}
```

Each delivery log includes:

- `id`
- `webhookId`
- `event`
- `status`
- `attempt`
- `responseStatus`
- `error`
- `nextAttemptAt`
- `createdAt`
- `updatedAt`
- `deliveredAt`

### `DELETE /api/webhooks/:id`

Deletes a webhook.

Success response:

```json
{
  "success": true,
  "data": {
    "deleted": {
      "id": "webhook-id",
      "url": "https://example.com/webhooks/whatsoba",
      "events": ["session.connected"],
      "enabled": true,
      "secretConfigured": true,
      "createdAt": "2026-07-03T18:00:00.000Z",
      "updatedAt": "2026-07-03T18:00:00.000Z"
    }
  }
}
```

## Webhook Delivery Format

When the server delivers an event to a registered webhook URL, it sends a `POST` request with:

- `Content-Type: application/json`
- `X-Webhook-Id`
- `X-Webhook-Event`
- `X-Webhook-Delivery-Id`
- `X-Webhook-Signature`
- `X-Webhook-Timestamp`

The signed body looks like:

```json
{
  "id": "delivery-id",
  "event": "message.sent",
  "occurredAt": "2026-07-03T18:00:00.000Z",
  "data": {}
}
```

The signature is `HMAC-SHA256` over the raw JSON body using the webhook secret.

## Realtime Socket Events

The server also broadcasts session and message events over Socket.IO.

### Connection

Connect to the same server that hosts the API. The socket server uses the same CORS settings as the REST app.

### Emitted Events

- `session.created`
- `session.updated`
- `session.qr`
- `session.connected`
- `session.disconnected`
- `session.deleted`
- `message.received`

### Event Payloads

`session.created`, `session.updated`, and `session.deleted` use the session view shape.

`session.qr`:

```json
{
  "id": "session-id",
  "qr": "qr-string"
}
```

`session.connected` and `session.disconnected`:

```json
{
  "id": "session-id",
  "status": "CONNECTED",
  "connectionState": "CONNECTED"
}
```

`message.received` uses the incoming message shape:

```json
{
  "id": "message-id",
  "chatId": "15551234567@s.whatsapp.net",
  "sender": "sender-id",
  "timestamp": "2026-07-03T18:00:00.000Z",
  "type": "conversation",
  "text": "Hello"
}
```

## Notes

- REST routes are mounted under `/api`
- Static media files are served from `/media`
- Session data is stored on disk under `/data/sessions` in production
- Media uploads are written to `uploads/media`

## Supabase Sync

The synchronization engine writes WhatsApp data into Supabase as the source of truth for the frontend.

### Required Environment Variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

If either value is missing, synchronization is skipped.

### Tables

- `public.whatsapp_contacts`
- `public.whatsapp_conversations`
- `public.whatsapp_messages`

### Workspace Isolation

Row Level Security is enabled on all sync tables.

Policies use the `workspace_id` claim from the authenticated JWT:

```sql
auth.jwt() ->> 'workspace_id'
```

The authenticated token must include the correct `workspace_id` value for reads and writes to succeed.

### Uniqueness Rules

- Contacts are unique by `workspace_id`, `connection_id`, and `jid`
- Conversations are unique by `workspace_id`, `connection_id`, and `chat_jid`
- Messages are unique by `workspace_id`, `conversation_id`, and `message_id`

### Key Indexes

- Contact search indexes on `display_name`, `push_name`, `jid`, and `phone`
- Conversation lookup indexes on `chat_jid`, `contact_id`, and latest message time
- Message lookup indexes on `conversation_id`, `message_id`, and latest message time

### Update Timestamps

All sync tables use an `updated_at` trigger so modifications automatically refresh the timestamp in UTC.

## REST Inbox API

The inbox APIs are read-only and source their data from Supabase only.

Baileys is used for synchronization only. No inbox endpoint fetches historical chats or messages directly from Baileys.

### Workspace Scope

Every inbox endpoint requires a workspace scope.

Use either:

- `workspaceId` query parameter
- `X-Workspace-Id` request header

### `GET /api/chats`

Returns the inbox chat list.

Supported query parameters:

- `workspaceId` required
- `connectionId` optional
- `search` optional
- `limit` optional, default `20`
- `offset` optional, default `0`
- `sort` optional, `asc` or `desc`
- `latest` optional, alias for newest-first
- `oldest` optional, alias for oldest-first
- `unread` optional, `true` or `false`
- `groups` optional, `true` or `false`
- `archived` optional, `true` or `false`
- `pinned` optional, `true` or `false`

Search matches:

- phone
- display name
- push name
- last message

Example request:

```http
GET /api/chats?workspaceId=workspace_123&connectionId=connection_abc&search=ahmed&limit=20&sort=latest
```

Example response:

```json
{
  "success": true,
  "data": [
    {
      "id": "conversation-id",
      "chatJid": "15551234567@s.whatsapp.net",
      "displayName": "Ahmed",
      "phone": "15551234567",
      "avatar": "https://example.com/avatar.jpg",
      "lastMessage": "Hello",
      "lastMessageType": "conversation",
      "lastMessageAt": "2026-07-03T18:00:00.000Z",
      "unreadCount": 2,
      "isPinned": false,
      "isArchived": false,
      "isGroup": false,
      "connectionId": "connection_abc"
    }
  ]
}
```

### `GET /api/chats/:jid`

Returns a single conversation record, its contact, and latest message.

Supported query parameters:

- `workspaceId` required
- `connectionId` optional

Example response:

```json
{
  "success": true,
  "data": {
    "conversation": {},
    "contact": {},
    "latestMessage": {},
    "unreadCount": 2,
    "isGroup": false,
    "isPinned": false,
    "isArchived": false
  }
}
```

Common errors:

- `400 jid is required`
- `404 Chat not found`

### `GET /api/chats/:jid/messages`

Returns messages for one conversation.

Supported query parameters:

- `workspaceId` required
- `connectionId` optional
- `limit` optional, default `50`
- `before` optional ISO timestamp
- `after` optional ISO timestamp

Rules:

- `before` and `after` cannot be used together
- messages are returned ordered by timestamp
- duplicate message IDs are never returned

Example response:

```json
{
  "success": true,
  "data": [
    {
      "id": "row-id",
      "messageId": "message-id",
      "sender": "15551234567@s.whatsapp.net",
      "recipient": "15550001111@s.whatsapp.net",
      "direction": "outbound",
      "type": "conversation",
      "text": "Hello",
      "mediaUrl": null,
      "status": "SENT",
      "timestamp": "2026-07-03T18:00:00.000Z"
    }
  ]
}
```

### `GET /api/contacts`

Returns the contact list.

Supported query parameters:

- `workspaceId` required
- `search` optional
- `limit` optional, default `20`
- `offset` optional, default `0`
- `sort` optional, `asc` or `desc`

Search matches:

- phone
- display name
- push name
- last message

Example response:

```json
{
  "success": true,
  "data": [
    {
      "id": "contact-id",
      "displayName": "Ahmed",
      "phone": "15551234567",
      "avatar": "https://example.com/avatar.jpg",
      "isBusiness": false,
      "lastSeen": "2026-07-03T18:00:00.000Z",
      "conversationCount": 3,
      "lastMessageAt": "2026-07-03T18:00:00.000Z"
    }
  ]
}
```

### `GET /api/contacts/:id`

Returns contact details and conversation statistics.

Supported query parameters:

- `workspaceId` required

Example response:

```json
{
  "success": true,
  "data": {
    "contact": {},
    "latestConversation": {},
    "statistics": {
      "conversationCount": 3,
      "messagesSent": 8,
      "messagesReceived": 12,
      "lastActivity": "2026-07-03T18:00:00.000Z"
    }
  }
}
```

Common errors:

- `404 Contact not found`

### `GET /api/dashboard/summary`

Returns inbox summary metrics.

Supported query parameters:

- `workspaceId` required

Example response:

```json
{
  "success": true,
  "data": {
    "connectedAccounts": 2,
    "contacts": 40,
    "conversations": 18,
    "unreadConversations": 6,
    "messagesToday": 14,
    "messagesThisWeek": 86,
    "groups": 4,
    "lastSynchronization": "2026-07-04T09:35:00.000Z"
  }
}
```

### Error Responses

All inbox endpoints return the shared error envelope on failure.

Example:

```json
{
  "success": false,
  "error": {
    "message": "workspaceId is required"
  }
}
```
