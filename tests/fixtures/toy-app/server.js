#!/usr/bin/env node
/**
 * Minimal Toy App Server
 *
 * A single-file HTTP server with web UI, REST API, and SQLite database.
 * Intentionally contains bugs for feedback agents to discover.
 *
 * Intentional bugs:
 * 1. Login form submits but shows no error on wrong password (just redirects back to login)
 * 2. No confirmation dialog before deleting tasks
 * 3. The "Settings" page has a broken link to "Privacy Policy"
 * 4. API returns 200 instead of 201 for successful task creation
 * 5. No --help flag for the CLI
 */

import http from 'http';
import { URL } from 'url';
import Database from 'better-sqlite3';

// ============================================================================
// Database Setup
// ============================================================================

const db = new Database(':memory:');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Seed data
  INSERT OR IGNORE INTO users (username, password) VALUES ('admin', 'admin123');
  INSERT OR IGNORE INTO tasks (title, completed) VALUES ('Buy groceries', 0);
  INSERT OR IGNORE INTO tasks (title, completed) VALUES ('Write documentation', 1);
`);

// ============================================================================
// Helper Functions
// ============================================================================

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        if (req.headers['content-type']?.includes('application/json')) {
          resolve(JSON.parse(body));
        } else {
          // Parse URL-encoded form data
          const params = new URLSearchParams(body);
          const obj = {};
          for (const [key, value] of params) {
            obj[key] = value;
          }
          resolve(obj);
        }
      } catch (err) {
        reject(err);
      }
    });
  });
}

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function getSessionFromToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
}

// ============================================================================
// HTML Pages
// ============================================================================

function loginPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Toy App - Login</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    input { display: block; width: 100%; padding: 8px; margin: 10px 0; }
    button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; }
    button:hover { background: #0056b3; }
  </style>
</head>
<body>
  <h1>Toy App Login</h1>
  <form method="POST" action="/api/auth/login">
    <input name="username" placeholder="Username" required>
    <input name="password" type="password" placeholder="Password" required>
    <button type="submit">Login</button>
  </form>
</body>
</html>`;
}

function dashboardPage(tasks) {
  const taskRows = tasks.map(t => `
    <tr>
      <td>${t.id}</td>
      <td>${t.title}</td>
      <td>${t.completed ? 'Yes' : 'No'}</td>
      <td>
        ${!t.completed ? `<button onclick="completeTask(${t.id})">Complete</button>` : ''}
        <button onclick="deleteTask(${t.id})">Delete</button>
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Toy App - Dashboard</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f4f4f4; }
    input { padding: 8px; margin-right: 10px; width: 300px; }
    button { padding: 8px 16px; background: #007bff; color: white; border: none; cursor: pointer; }
    button:hover { background: #0056b3; }
    nav { margin-bottom: 20px; }
    nav a { margin-right: 15px; }
  </style>
</head>
<body>
  <nav>
    <a href="/dashboard">Dashboard</a>
    <a href="/settings">Settings</a>
    <a href="/api/auth/logout">Logout</a>
  </nav>
  <h1>Task Dashboard</h1>

  <div>
    <h2>Create New Task</h2>
    <form onsubmit="createTask(event)">
      <input id="taskTitle" placeholder="Task title" required>
      <button type="submit">Add Task</button>
    </form>
  </div>

  <h2>Tasks</h2>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Title</th>
        <th>Completed</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${taskRows}
    </tbody>
  </table>

  <script>
    async function createTask(e) {
      e.preventDefault();
      const title = document.getElementById('taskTitle').value;
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      if (response.ok) {
        window.location.reload();
      } else {
        alert('Failed to create task');
      }
    }

    async function completeTask(id) {
      const response = await fetch('/api/tasks/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: 1 })
      });
      if (response.ok) {
        window.location.reload();
      }
    }

    // BUG #2: No confirmation dialog before deleting tasks
    async function deleteTask(id) {
      const response = await fetch('/api/tasks/' + id, { method: 'DELETE' });
      if (response.ok) {
        window.location.reload();
      }
    }
  </script>
</body>
</html>`;
}

function settingsPage() {
  // BUG #3: Broken link to "Privacy Policy"
  return `<!DOCTYPE html>
<html>
<head>
  <title>Toy App - Settings</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
    nav { margin-bottom: 20px; }
    nav a { margin-right: 15px; }
    .settings-section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; }
  </style>
</head>
<body>
  <nav>
    <a href="/dashboard">Dashboard</a>
    <a href="/settings">Settings</a>
    <a href="/api/auth/logout">Logout</a>
  </nav>
  <h1>Settings</h1>

  <div class="settings-section">
    <h2>Account Settings</h2>
    <p>Username: admin</p>
    <button disabled>Change Password</button>
  </div>

  <div class="settings-section">
    <h2>Privacy</h2>
    <p>Manage your privacy settings and data.</p>
    <a href="/privacy-policy">View Privacy Policy</a>
  </div>

  <div class="settings-section">
    <h2>Notifications</h2>
    <label>
      <input type="checkbox"> Email notifications
    </label>
  </div>
</body>
</html>`;
}

// ============================================================================
// Request Handler
// ============================================================================

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS headers for API
  if (path.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // Extract session token from cookies
  const cookies = {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach(cookie => {
      const [key, value] = cookie.trim().split('=');
      cookies[key] = value;
    });
  }
  const sessionToken = cookies.token;

  try {
    // ============================================================================
    // Auth Routes
    // ============================================================================

    if (path === '/api/auth/login' && method === 'POST') {
      const body = await parseBody(req);
      const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?')
        .get(body.username, body.password);

      // BUG #1: No error shown on wrong password, just redirects back to login
      if (!user) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }

      const token = generateToken();
      db.prepare('INSERT INTO sessions (token, username) VALUES (?, ?)').run(token, user.username);

      res.writeHead(302, {
        Location: '/dashboard',
        'Set-Cookie': `token=${token}; Path=/; HttpOnly`
      });
      res.end();
      return;
    }

    if (path === '/api/auth/logout') {
      if (sessionToken) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(sessionToken);
      }
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': 'token=; Path=/; HttpOnly; Max-Age=0'
      });
      res.end();
      return;
    }

    // ============================================================================
    // Protected Routes (require authentication)
    // ============================================================================

    const session = getSessionFromToken(sessionToken);

    if (path === '/' && method === 'GET') {
      if (session) {
        res.writeHead(302, { Location: '/dashboard' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(loginPage());
      }
      return;
    }

    if (path === '/dashboard' && method === 'GET') {
      if (!session) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }

      const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(dashboardPage(tasks));
      return;
    }

    if (path === '/settings' && method === 'GET') {
      if (!session) {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(settingsPage());
      return;
    }

    // ============================================================================
    // API Routes
    // ============================================================================

    if (path === '/api/tasks' && method === 'GET') {
      const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks }));
      return;
    }

    if (path === '/api/tasks' && method === 'POST') {
      const body = await parseBody(req);
      const result = db.prepare('INSERT INTO tasks (title) VALUES (?)').run(body.title);

      // BUG #4: Returns 200 instead of 201 for successful creation
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: result.lastInsertRowid, title: body.title }));
      return;
    }

    if (path.startsWith('/api/tasks/') && method === 'PATCH') {
      const id = path.split('/')[3];
      const body = await parseBody(req);

      db.prepare('UPDATE tasks SET completed = ? WHERE id = ?').run(body.completed, id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (path.startsWith('/api/tasks/') && method === 'DELETE') {
      const id = path.split('/')[3];
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');

  } catch (err) {
    console.error('Request error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

// ============================================================================
// Server Startup
// ============================================================================

const PORT = process.env.PORT || 0; // 0 = pick any free port
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  const address = server.address();
  const actualPort = address.port;
  console.log(`Toy app running at http://localhost:${actualPort}/`);
  console.log(`Credentials: admin / admin123`);

  // Write port to a file for integration tests
  if (process.env.PORT_FILE) {
    import('fs').then(fs => {
      fs.writeFileSync(process.env.PORT_FILE, String(actualPort));
    });
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
