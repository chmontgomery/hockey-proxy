# Ngrok Demo Mode Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `--tunnel` flag to startup that exposes the Express server on the public internet via ngrok for temporary remote demos.

**Architecture:** Check process.argv after the server starts listening. If `--tunnel` is present, dynamically import ngrok and expose port 3000 publicly. Log the public URL to stdout. On Ctrl+C, both Express and ngrok shut down cleanly.

**Tech Stack:** ngrok npm package, process.argv for CLI parsing, dynamic import for ngrok initialization.

---

### Task 1: Add ngrok Dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Read package.json to see current structure**

```bash
cat /Users/chris/git/hockey-proxy/package.json
```

Expected: JSON with `dependencies` object containing express, other packages.

- [ ] **Step 2: Add ngrok to dependencies**

In the `dependencies` object, add:
```json
"ngrok": "^5.3.0"
```

Save the file.

- [ ] **Step 3: Run npm install**

```bash
cd /Users/chris/git/hockey-proxy && npm install
```

Expected: `npm install` succeeds, ngrok is downloaded.

- [ ] **Step 4: Verify ngrok is installed**

```bash
npm ls ngrok
```

Expected: Shows `ngrok@5.3.0` (or similar version).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add ngrok dependency for demo mode"
```

---

### Task 2: Implement --tunnel Flag Logic in server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Read server.js to understand current startup**

```bash
cat /Users/chris/git/hockey-proxy/server.js
```

Expected: Find where `server.listen(port, ...)` is called, identify the callback.

- [ ] **Step 2: Add ngrok initialization logic after server.listen()**

After the `server.listen()` callback (where the app is currently listening), add this code:

```javascript
// If --tunnel flag is present, expose via ngrok
if (process.argv.includes('--tunnel')) {
  (async () => {
    try {
      const ngrok = await import('ngrok');
      const url = await ngrok.connect(port);
      console.log(`\n🌐 Public URL (share this): ${url}`);
      console.log('Ctrl+C to stop\n');
      
      // Clean up ngrok on process exit
      process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await ngrok.kill();
        process.exit(0);
      });
    } catch (error) {
      if (error.message.includes('ERR_NGROK_108')) {
        console.error('\n❌ ngrok not authenticated. Run:\n  ngrok config add-authtoken <token>\n');
        console.error('Get a free token at https://dashboard.ngrok.com/auth\n');
      } else {
        console.error('\n❌ Failed to start ngrok tunnel:', error.message);
      }
      process.exit(1);
    }
  })();
}
```

Insert this **after** the `server.listen()` callback completes (so Express is already listening on port 3000). The exact line number depends on your current server.js — find the closing brace of the listen callback and add this before it.

- [ ] **Step 3: Verify the code is syntactically correct**

```bash
node --check /Users/chris/git/hockey-proxy/server.js
```

Expected: No output (syntax is valid). If there's an error, check the closing braces and indentation.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add --tunnel flag to expose app via ngrok"
```

---

### Task 3: Manual Test Without Flag

**Files:**
- No changes, just testing

- [ ] **Step 1: Start the app normally (no --tunnel)**

```bash
cd /Users/chris/git/hockey-proxy && npm start
```

Expected output should include:
```
Hockey Proxy running on http://localhost:3000
```

And **no ngrok URL** (because we didn't pass --tunnel).

- [ ] **Step 2: Verify the app is running locally**

In another terminal:
```bash
curl http://localhost:3000/
```

Expected: HTTP 200, HTML response (the main page).

- [ ] **Step 3: Stop the app**

Press Ctrl+C in the original terminal. App should exit cleanly.

---

### Task 4: Manual Test With Flag

**Files:**
- No changes, just testing

- [ ] **Step 1: Ensure ngrok is authenticated**

```bash
ngrok config add-authtoken <your-token>
```

If you don't have a token, go to https://dashboard.ngrok.com/auth, create a free account, copy the token, and run the above command once.

- [ ] **Step 2: Start the app with --tunnel flag**

```bash
cd /Users/chris/git/hockey-proxy && npm start -- --tunnel
```

Expected output should include:
```
Hockey Proxy running on http://localhost:3000
🌐 Public URL (share this): https://abc-123-def.ngrok.io
Ctrl+C to stop
```

The public URL will be different each time (ngrok generates a random subdomain).

- [ ] **Step 3: Test the public URL from another machine or browser tab**

Open the ngrok URL from the output (e.g., `https://abc-123-def.ngrok.io`) in a browser on a different device or tab.

Expected: The hockey-proxy app loads normally.

- [ ] **Step 4: Verify local access still works**

In another terminal:
```bash
curl http://localhost:3000/
```

Expected: HTTP 200 response (local access is unaffected).

- [ ] **Step 5: Stop the app**

Press Ctrl+C. Both Express and ngrok should shut down cleanly.
