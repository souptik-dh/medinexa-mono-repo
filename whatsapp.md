# WAHA Local API — curl Cheatsheet

Local instance: `http://localhost:3000`
API key: `666` (sent as `X-Api-Key` header)
Session name used below: `default`

## Sessions

### List sessions

```bash
curl -s http://localhost:3000/api/sessions \
  -H "X-Api-Key: 666"
```

### Create & start a session

```bash
curl -X POST http://localhost:3000/api/sessions \
  -H "X-Api-Key: 666" \
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
curl -s http://localhost:3000/api/sessions/default \
  -H "X-Api-Key: 666"
```

## Pairing

### Get QR code (scan with WhatsApp → Linked Devices)

```bash
curl -X GET "http://localhost:3000/api/default/auth/qr" \
  -H "X-Api-Key: 666" \
  -o qr.png
```

### Request pairing code (alternative to QR)

```bash
curl -X POST "http://localhost:3000/api/default/auth/request-code" \
  -H "X-Api-Key: 666" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "12132132130",
    "method": "sms"
  }'
```

## Contacts

### Check if a phone number exists on WhatsApp

```bash
curl -G "http://localhost:3000/api/contacts/check-exists" \
  -H "X-Api-Key: 666" \
  --data-urlencode "session=default" \
  --data-urlencode "phone=917001993236"
```

## Chatting

### Send a text message

```bash
curl --location 'http://localhost:3000/api/sendText' \
--header 'X-Api-Key: 666' \
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
