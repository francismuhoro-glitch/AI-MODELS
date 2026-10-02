# ARIA → Android phone bridge (real alarms & music control)

This lets ARIA set a **real alarm in your phone's Clock app** and press **real media buttons**
(play / pause / next / previous / volume) and **open apps** — by talking to **Tasker** (or
MacroDroid) on your phone.

It works like a courier, not like a remote control:

1. ARIA writes a **command** into an outbox (nothing has happened yet).
2. Your phone **polls** `GET /api/phone/pending` with a bearer token.
3. Tasker runs the **real action** (Set Alarm, Media Control, …).
4. Tasker calls `POST /api/phone/ack` to say what it actually did.
5. **Only then** does ARIA say it happened. Before the ack ARIA always says
   *“sent to phone, waiting for confirmation.”*

If your phone never acks, ARIA tells you it is **queued/expired — not done**. It will never
pretend your alarm rang.

---

## 0. What you need

| Thing | Why |
| --- | --- |
| Tasker (Play Store) | Runs the poll + actions on the phone. MacroDroid works too — see §8. |
| ARIA reachable from your phone | A Vercel URL, a tunnel, or your PC's LAN address (e.g. `http://192.168.1.20:3000`). `127.0.0.1` on the phone means *the phone itself* — that will not work. |
| A long random bridge token | Shared secret between ARIA and Tasker. Generate one on your computer: `openssl rand -hex 24` |

---

## 1. Turn on the bridge in ARIA

1. Open ARIA → **Settings** → **📱 Android phone bridge**.
2. Paste your token into **Bridge token** and tick **Enable the phone bridge**.
3. Leave **Command TTL** at `1800` seconds (30 min) and **Tasker poll interval** at `300`
   seconds (5 min). ⚠️ **The TTL must be longer than the poll interval**, otherwise every
   command expires before your phone looks for it.
4. Press **Save all**.
5. Still in Settings → **🔐 Permissions**, tick the boxes you want:
   * `phone.alarm` — set/cancel a **real device alarm** (also needs your spoken/tapped confirm
     when the AI model is the one asking).
   * `phone.media` — play / pause / next / previous / volume.
   * `phone.app` — open an app.

Everything is default-deny: no tick, no command.

> The token is stored as a secret: it is blanked in every GET response, never logged, never
> given to the AI model, and never accepted in a URL query string.

---

## 2. Build the Tasker task “ARIA Poll”

Tasker → **TASKS** tab → **+** → name it `ARIA Poll`.

### 2.1 Get the pending commands

**Add Action → Net → HTTP Request**

| Field | Value |
| --- | --- |
| Method | `GET` |
| URL | `https://YOUR-ARIA-HOST/api/phone/pending` |
| Headers | `Authorization:Bearer PASTE_YOUR_TOKEN_HERE` |
| Timeout | `10` |
| Output File (leave blank) | — |

The response lands in the Tasker variable **`%HTTPD`**. It looks like:

```json
{ "ok": true, "count": 1, "commands": [
  { "id": "phc_1a2b…", "type": "set_alarm",
    "args": { "hour": 6, "minute": 30, "dayKey": "2026-10-03", "title": "ARIA alarm",
              "fireAtISO": "2026-10-03T03:30:00.000Z", "timezone": "Africa/Nairobi" },
    "expiresAt": 1790000000000 } ] }
```

One command is delivered at a time (oldest first). The next poll picks up the next one.

### 2.2 Read it (JavaScriptlet — copy/paste)

**Add Action → Code → JavaScriptlet**

```js
var out = [];
try { out = (JSON.parse(global('HTTPD')) || {}).commands || []; } catch (e) { out = []; }
var c = out[0] || null;
if (c) {
  setGlobal('ARIA_CMD_ID',     String(c.id));
  setGlobal('ARIA_CMD_TYPE',   String(c.type));
  setGlobal('ARIA_CMD_HOUR',   String((c.args||{}).hour   ?? ''));
  setGlobal('ARIA_CMD_MIN',    String((c.args||{}).minute ?? ''));
  setGlobal('ARIA_CMD_LABEL',  String((c.args||{}).label  || 'ARIA alarm'));
  setGlobal('ARIA_CMD_TITLE',  String((c.args||{}).title  || 'ARIA alarm'));
  setGlobal('ARIA_CMD_LEVEL',  String((c.args||{}).level  ?? ''));
  setGlobal('ARIA_CMD_APP',    String((c.args||{}).app    || ''));
  setGlobal('ARIA_CMD_QUERY',  String((c.args||{}).query  || ''));
} else {
  setGlobal('ARIA_CMD_ID', '');
  setGlobal('ARIA_CMD_TYPE', '');
}
```

*(No-Code alternative: the **AutoTools** plugin's “JSON Read” action can pull
`commands[0].args.hour` into `%hour` and `commands[0].id` into `%id`.)*

**Add Action → Task → Stop** with `If %ARIA_CMD_ID !Set` → then the task ends when there is
nothing to do. (In Tasker: `If %ARIA_CMD_ID !Set`.)

### 2.3 Do the action

Add these actions **after** the Stop. Only the matching one will fire.

**⏰ Real alarm — `%ARIA_CMD_TYPE ~ set_alarm`**

**Add Action → Alert → Set Alarm**

| Field | Value |
| --- | --- |
| Hour | `%ARIA_CMD_HOUR` |
| Minute | `%ARIA_CMD_MIN` |
| Label | `%ARIA_CMD_LABEL` |

> Tasker's **Set Alarm** creates a normal alarm in your Clock app. Some manufacturers block
> it — if no alarm appears, open Tasker → **3-dot menu → Run Log** to see the error, and let
> ARIA report it honestly (see §2.5: ack `failed`).

**⏰ Cancel an alarm — `%ARIA_CMD_TYPE ~ cancel_alarm`**

If your Tasker build has **Alert → Cancel Alarm**, use it (match on the label).
If it does **not**, ack it as `unsupported` (§2.5) — **do not** ack “done”, because ARIA
would then tell you the alarm was cancelled when it was not.

**🎵 Media keys — `%ARIA_CMD_TYPE ~ play | pause | next | previous`**

**Add Action → Media → Media Control** and set **Cmd**:

| Command type | Media Control Cmd |
| --- | --- |
| `play` | `Play` |
| `pause` | `Pause` (or `Toggle Pause`) |
| `next` | `Next` |
| `previous` | `Previous` |

> Alternative (more fussy): **Net → Send Intent**, Action `android.intent.action.MEDIA_BUTTON`
> with a key event extra. Media Control is far more reliable and needs no plugins; use it
> unless your headset/app ignores it.
>
> Note about honesty: **pause** on an app that already stopped is a no-op — Android gives no
> reliable “it is paused now” signal. Tasker acking `done` means *the button was sent and the
> action ran*, and ARIA words it that way.

**🔊 Volume — `%ARIA_CMD_TYPE ~ volume`**

**Add Action → Audio → Set Volume** → Stream: `Media`, Level: `%ARIA_CMD_LEVEL`.

If your phone's media volume scale is 0–15 instead of 0–100, convert it first with a
JavaScriptlet before the Set Volume action:

```js
var pct = Number(global('ARIA_CMD_LEVEL')) || 0;          // 0–100 from ARIA
setGlobal('ARIA_CMD_VOL15', String(Math.round(pct * 15 / 100))); // 0–15 for the slider
```

**🚀 Open an app — `%ARIA_CMD_TYPE ~ open_app`**

**Add Action → App → Launch App** → App: pick the app; then in its **If** condition use
`%ARIA_CMD_APP ~ *whatsapp*` (add one Launch App action per app you allow, each with its own
If). ARIA sends the app name you spoke (e.g. “WhatsApp”).

### 2.4 Send the ack (always after the action)

**Add Action → Net → HTTP Request**

| Field | Value |
| --- | --- |
| Method | `POST` |
| URL | `https://YOUR-ARIA-HOST/api/phone/ack` |
| Headers | `Authorization:Bearer PASTE_YOUR_TOKEN_HERE` |
| Content-Type | `application/json` |
| Body | see below |

**On success:**

```json
{"id":"%ARIA_CMD_ID","status":"done","detail":"Set Alarm action ran"}
```

**If the action failed or does not exist on your phone:**

```json
{"id":"%ARIA_CMD_ID","status":"failed","detail":"Tasker has no Cancel Alarm action"}
```

ARIA will say: *“⚠️ The phone reported it could NOT run: … Nothing was confirmed.”*

Re-sending the same ack is safe — the first ack wins and later ones are ignored (idempotent),
so a flaky connection can never double-run anything.

### 2.5 Run it and test

1. **Settings → Android phone bridge → ⏰ Queue a test alarm (2 min)**.
2. Tap ▶ (play) on the `ARIA Poll` task in Tasker (or wait for the profile, §3).
3. Your phone should create an alarm ~2 minutes from now, and ARIA's Settings card should
   flip that command from `queued` to `acked`.
4. Ask ARIA (Assistant tab): **“is my phone connected?”** → it answers with the last poll
   time, queue depth and last ack.
5. Ask: **“set an alarm on my phone for tomorrow at 6:30 am”** → ARIA replies
   *“📲 Sent to your phone … waiting for confirmation”* and switches to acked once Tasker
   reports in.

---

## 3. Make it automatic (Tasker profile)

Tasker → **PROFILES** tab → **+** → **Event → Time**

* **From** `00:00` **To** `23:59`
* Tick **Repeat**, every **5 minutes**

→ link it to the **ARIA Poll** task.

Notes
* 5 minutes is a good balance. Tasker can repeat every 1 minute, but that wakes the phone
  constantly. **Always keep ARIA's Command TTL longer than this interval.**
* Battery optimisation can delay Tasker. Exempt Tasker from battery optimisation
  (Android Settings → Apps → Tasker → Battery → Unrestricted).
* Prefer lower latency? Add a second profile: **Event → UI → Display Unlocked** → same task
  (polls right when you pick the phone up).
* Out of your home network? Add an If condition so the poll only runs when
  `%WIFII` contains your SSID, or make sure your ARIA host is reachable over the internet.

---

## 4. Command reference (what ARIA can send)

| `type` | Extra `args` | Tasker action | What the ack means |
| --- | --- | --- | --- |
| `set_alarm` | `hour`, `minute`, `dayKey`, `fireAtISO`, `timezone`, `title`, `label` | Alert → Set Alarm | The alarm exists in the Clock app |
| `cancel_alarm` | `title` | Alert → Cancel Alarm (if available) | The alarm was removed |
| `play` / `pause` / `next` / `previous` | — | Media → Media Control | The media key was sent |
| `volume` | `level` (0–100) | Audio → Set Volume (Media) | Volume changed |
| `open_app` | `app` | App → Launch App | The app was launched |

Times are always resolved in **Africa/Nairobi**. If you say *“set an alarm on my phone”*
without a clock time, ARIA **asks first** and queues nothing.

---

## 5. Web-push fallback (optional, no polling)

If the PWA is installed with notifications enabled, every queued command also fires a
web-push with a **fixed, machine-readable title**:

| Command | Notification title |
| --- | --- |
| `set_alarm` | `ARIA ALARM 06:30` |
| `cancel_alarm` | `ARIA ALARM CANCEL` |
| `play` / `pause` / `next` / `previous` | `ARIA MEDIA PLAY` / `ARIA MEDIA PAUSE` / `ARIA MEDIA NEXT` / `ARIA MEDIA PREVIOUS` |
| `volume` | `ARIA MEDIA VOLUME 40` |
| `open_app` | `ARIA APP WHATSAPP` |

The notification body carries the command **id**, so a Tasker profile using the
**AutoNotification** plugin (or MacroDroid's notification trigger) can react immediately
instead of waiting for the next poll. **Web push alone cannot create an alarm** — it only
pokes your phone; the Tasker action above is what actually does the work. Treat push as a
bonus trigger, not a replacement for polling.

---

## 6. Security & guarantees

* **Off by default.** No token, no enabled flag, no commands.
* **Default deny.** `phone.alarm`, `phone.media`, `phone.app` grants are required and every
  command is written to the audit log (`/api/audit`).
* **The model cannot self-confirm.** If the LLM asks for a phone alarm, ARIA asks you to
  confirm in chat / tap Confirm. The model never sees the token and never gets to press it.
* **Token handling.** Secret-key rules blank it in every GET body and set
  `phone.bridgeTokenConfigured: true`. Rotate it any time by pasting a new one in Settings
  (leave blank to keep the old one).
* **Expiry.** Commands older than the TTL are never delivered and are labelled `expired`.
* **Idempotency.** Repeating the same alarm intent reuses the same queued command; repeating
  an ack never re-runs anything.
* **Honesty.** Every ARIA reply about the phone says “waiting for confirmation” until an ack
  exists, and “the phone could not do it” when the ack says `failed`.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401 Invalid bridge token` | Token in Tasker ≠ token in Settings. Re-copy it (no spaces, include nothing else after `Bearer `). |
| `409 Phone bridge is disabled` | Tick **Enable the phone bridge** and Save. |
| `409 … no token yet` | Paste a token, save, and put the same one in Tasker. |
| ARIA says “not allowed to use phone.alarm” | Grant it in Settings → 🔐 Permissions. |
| Pending list always empty | Tasker can't reach the host, or commands expired. Test from the phone's browser: open `https://YOUR-ARIA-HOST/api/health` — you should see `{"ok":true}`. Raise the TTL above your poll interval. |
| Nothing happens although Tasker runs | Check the Run Log; make sure the JavaScriptlet runs **before** the action, and that the ack body uses `%ARIA_CMD_ID`. |
| Alarm created but ARIA still says “waiting” | The ack HTTP Request didn't run or returned an error — open it in a browser-based run log. |
| Local server unreachable from the phone | `localhost`/`127.0.0.1` on the phone = the phone. Use your PC's LAN IP (`ipconfig` / `ifconfig`) or deploy ARIA (Vercel) and use that URL. |

---

## 8. MacroDroid instead of Tasker

MacroDroid can do the same job with its own actions:

1. **Macro → Trigger: Regular Interval** (5 minutes).
2. **Action: HTTP Request** → `GET https://YOUR-ARIA-HOST/api/phone/pending`, add the header
   `Authorization: Bearer <token>`, tick *Save response to variable* (`[http_response]`).
3. Read the first command from the response. MacroDroid versions differ here — newer builds
   have a **JSON** variable/parse action; if yours does not, either
   * use the **web-push** titles from §5 as the trigger (MacroDroid notification trigger), or
   * keep Tasker for polling and use MacroDroid only for the media/volume actions.
4. **Actions:** `Set Alarm` (Alarm category) for `set_alarm`; `Media Control → Next/Previous/
   Play/Pause` for the media commands; `Set Volume`; `Launch Application` for `open_app`.
5. **Action: HTTP Request** → `POST .../api/phone/ack` with
   `{"id":"<command id>","status":"done"}` (header `Authorization: Bearer <token>`).

The contract is identical — MacroDroid is a client of the same two endpoints.

---

## 9. Honest limitations

* A web page/PWA still cannot set an OS alarm by itself. **Everything real happens in
  Tasker/MacroDroid on the phone**, and only the ack makes it true.
* Tasker's *Media Control* presses a key on whatever is currently playing; it cannot tell
  ARIA which track it skipped, and ARIA will not invent a track name.
* `cancel_alarm` and `volume` depend on your Tasker build and volume scale — ack honestly
  (`unsupported` / `failed`) if yours can't do it.
* No polling = no commands. If your phone is offline past the TTL, the command expires and
  ARIA tells you it expired rather than pretending.
