# Deploying the Profdictor registry

The extension works without this. Scanning, prediction, the fuzzy professor
lookup and locally saved moderator corrections all run offline. Deploy the
Worker only when you want:

- one-time access hashes gating who can install it,
- a **shared** verified-professor database, so one moderator's correction
  reaches every user,
- moderator sign-in that is not baked into the shipped files.

## 1. Create the KV namespace

```powershell
cd worker
npx wrangler kv namespace create PD_KV
```

Copy the printed `id` into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

## 2. Set the shared key

```powershell
npx wrangler secret put CLAIM_KEY
```

Any long random string. Every request from the extension must carry it as the
`x-profdictor-key` header. If you skip this step the registry answers anyone who
finds the URL.

## 3. Deploy

```powershell
npx wrangler deploy
```

Note the URL, e.g. `https://profdictor-registry.your-name.workers.dev`.

## 4. Generate and upload credentials

```powershell
cd ..
powershell -ExecutionPolicy Bypass -File .\tools\New-ProfdictorHashes.ps1 -AccessCount 100 -ModeratorNames "jared","kim"
```

That writes `secrets/codes.txt` (the passphrases you hand out — keep private)
and `secrets/seed.json` (hashes only). Upload the hashes:

```powershell
curl -X POST "https://YOUR-WORKER.workers.dev/admin/seed" `
  -H "content-type: application/json" `
  -H "x-profdictor-key: YOUR_CLAIM_KEY" `
  --data "@secrets/seed.json"
```

Confirm:

```powershell
curl "https://YOUR-WORKER.workers.dev/stats" -H "x-profdictor-key: YOUR_CLAIM_KEY"
```

## 5. Point the extension at it

In `extension/access-codes.js`:

```js
const PROFDICTOR_REGISTRY_URL = "https://YOUR-WORKER.workers.dev";
const PROFDICTOR_REGISTRY_KEY = "YOUR_CLAIM_KEY";
const PROFDICTOR_REQUIRE_ACCESS_GATE = true;
```

Reload the extension at `chrome://extensions`.

## Endpoints

| Method | Path             | Auth                  | Purpose                                     |
| ------ | ---------------- | --------------------- | ------------------------------------------- |
| POST   | `/claim`         | key                   | Burn a one-time access hash (globally)      |
| POST   | `/admin/verify`  | key                   | Moderator sign-in; returns an 8-hour token  |
| GET    | `/verified`      | key                   | Read shared ground truth (`?course=ARTS 1`) |
| POST   | `/verified`      | key + moderator token | Write ground truth                          |
| POST   | `/admin/seed`    | key                   | Load access hashes / moderator credentials  |
| GET    | `/stats`         | key                   | Counts of codes, moderators, verified rows  |

## Notes on the trust model

Only SHA-256 hashes are stored, so dumping KV does not reveal usable
passphrases. Burns are recorded server-side, which is the only way to stop a
hash being reused on a different PC — local storage alone cannot.

Like every browser extension, a determined user can patch the client JavaScript
to bypass the gate. What the registry does protect is the **hash list** and the
**shared database write path**: writes need a moderator token, so a normal user
cannot poison everyone else's predictions.
