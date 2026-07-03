# whatsoba-gateway

Standalone Node.js gateway for Whatsoba using Express, Socket.IO, and Baileys.

## Production Deployment

### Environment Variables

Set these in Railway:

- `PORT` - Railway injects this automatically. The app listens on it.
- `NODE_ENV=production`
- `FRONTEND_URL` - comma-separated list of allowed frontend origins
- `SESSION_PATH=/data/sessions`
- `LOG_LEVEL=info`

Optional:

- `SESSION_PATH` can be overridden if you mount a different persistent volume path.
- `FRONTEND_URL` can include multiple origins separated by commas.

### Railway Notes

- The server trusts the proxy, so Railway headers work correctly.
- Sessions are stored on disk under `SESSION_PATH` and should be backed by a Railway volume.
- Media uploads are written to `uploads/media` and exposed from `/media`.
- The gateway performs startup checks before binding the port.

### Docker

Build and run locally:

```bash
docker build -t whatsoba-gateway .
docker run --rm -p 3001:3001 -e NODE_ENV=production -e FRONTEND_URL=http://localhost:5173 -e PORT=3001 whatsoba-gateway
```

## API

Health:

- `GET /api/health`

Sessions:

- `POST /api/sessions`
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/qr`
- `DELETE /api/sessions/:id`
- `POST /api/sessions/:id/reconnect`

Messages:

- `POST /api/messages/text`
- `POST /api/messages/media`

Webhooks:

- `POST /api/webhooks`
- `GET /api/webhooks`
- `GET /api/webhooks/:id`
- `GET /api/webhooks/:id/deliveries`
- `DELETE /api/webhooks/:id`

## Session Storage

Authentication files are stored in:

```text
/data/sessions/{connectionId}
```

This path is Railway-friendly and can be mounted to persistent storage.

## Startup Checks

On startup the gateway verifies:

- frontend origins are configured
- the session directory exists and is writable
- the process is ready to listen on the configured `PORT`

## Webhooks

Register any number of webhook URLs through the API. Each webhook can subscribe to any subset of:

- `session.connected`
- `session.disconnected`
- `message.received`
- `message.sent`
- `message.delivered`
- `message.read`

Webhook deliveries are:

- queued in the background
- signed with HMAC SHA-256 using the webhook secret
- retried automatically on failure
- logged in memory per webhook

The delivery request includes these headers:

- `X-Webhook-Id`
- `X-Webhook-Event`
- `X-Webhook-Delivery-Id`
- `X-Webhook-Signature`
- `X-Webhook-Timestamp`

Payloads are sent as signed JSON envelopes.

## Development

```bash
npm install
npm run dev
```
