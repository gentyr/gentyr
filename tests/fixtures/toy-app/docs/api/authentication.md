# Authentication

The Toy App API uses bearer token authentication. All API requests must include a valid token.

## Obtaining a Token

Send a POST request to `/auth/token` with your credentials:

```bash
curl -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/json" \
  -d '{"username": "user", "password": "secret"}'
```

The response includes an `access_token` field.

## Using the Token

Include the token in the `Authorization` header:

```bash
curl http://localhost:3000/api/data \
  -H "Authorization: Bearer <your-token>"
```

Tokens expire after 24 hours. Request a new token before expiry to maintain access.
