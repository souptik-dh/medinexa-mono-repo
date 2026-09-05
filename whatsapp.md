# WAHA API — curl Cheatsheet

Session name used below: `default`

Set these before running any command below:

```bash
# Local dev (matches WAHA_API_KEY in your local run command)
# export WAHA_URL="http://localhost:3000"
# export WAHA_API_KEY="666"

# Render / production (use the real value from Render's Environment tab,
# never hardcode it in this file)
export WAHA_URL="https://jido-waha-gateway.onrender.com"
export WAHA_API_KEY="<paste from Render env, do not commit>"
```

> **Security note**: this file is tracked in git (unlike `.env`, which is
> gitignored). Never replace `$WAHA_API_KEY` below with a real production
> key — always reference the env var so secrets don't end up in commit
> history.

## Sessions

### List sessions

```bash
curl -s "$WAHA_URL/api/sessions" \
  -H "X-Api-Key: $WAHA_API_KEY"
```

### Create & start a session

```bash
curl -X POST "$WAHA_URL/api/sessions" \
  -H "X-Api-Key: $WAHA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "default",
    "start": true,
    "config": {
      "debug": false
    }
  }'
```

### Get session status

```bash
curl -s "$WAHA_URL/api/sessions/default" \
  -H "X-Api-Key: $WAHA_API_KEY"
```

## Pairing

### Get QR code (scan with WhatsApp → Linked Devices)

```bash
curl -X GET "$WAHA_URL/api/default/auth/qr" \
  -H "X-Api-Key: $WAHA_API_KEY" \
  -o qr.png
```

### Request pairing code (alternative to QR)

```bash
curl -X POST "$WAHA_URL/api/default/auth/request-code" \
  -H "X-Api-Key: $WAHA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "12132132130",
    "method": "sms"
  }'
```

## Contacts

### Check if a phone number exists on WhatsApp

```bash
curl -G "$WAHA_URL/api/contacts/check-exists" \
  -H "X-Api-Key: $WAHA_API_KEY" \
  --data-urlencode "session=default" \
  --data-urlencode "phone=917001993236"
```

## Chatting

### Send a text message

```bash
curl --location "$WAHA_URL/api/sendText" \
--header "X-Api-Key: $WAHA_API_KEY" \
--header 'Content-Type: application/json' \
--data-raw '{
    "session": "default",
    "chatId": "917001993236@c.us",
    "text": "Hello from Jido Service!"
}'
```

## Notes

- `chatId` format: `<countrycode><number>@c.us` for individuals, `<id>@g.us` for groups.
- `phone` in `check-exists` / pairing requests: digits only, international format, no `+`, no leading `00`.
- Engine currently running: `NOWEB` (switched from `WEBJS` after `sendText` failed with `No LID for user` for a cold/unresolved contact).
- Every request needs a valid `X-Api-Key` matching `WAHA_API_KEY` on the server; a wrong/missing key returns `401 Unauthorized`.
