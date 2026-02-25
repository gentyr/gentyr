# API Endpoints

This document lists all available API endpoints.

## GET /api/data

Returns a list of data records.

```bash
curl http://localhost:3000/api/data \
  -H "Authorization: Bearer <token>"
```

**Response:**
```json
{ "records": [], "total": 0 }
```

## POST /api/data

Create a new data record.

```bash
curl -X POST http://localhost:3000/api/data \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "example"}'
```

## DELETE /api/data/:id

Delete a record by ID.

All endpoints return HTTP 401 when the token is missing or expired.
