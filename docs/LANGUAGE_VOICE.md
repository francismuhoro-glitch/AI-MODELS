# 🗣️ Swahili, Kikuyu & Sheng — language, voice and the phrase dictionary

ARIA speaks and listens in **English (en-KE), Swahili (sw-KE)** and **as much Kikuyu as is
honestly possible**. This document is deliberately explicit about the third one: no browser ships a
Kikuyu speech-recognition model, so Kikuyu works by **typing** (plus any phrases you add to the
dictionary), and ARIA says so in the UI rather than pretending.

```
Settings → Language            settings.language.mode  =  auto | en | sw | ki
        │
        ├── SpeechRecognition.lang   sw → sw-KE · en → en-KE · auto → device · ki → mic DISABLED
        ├── speechSynthesis voice    sw voice → Kikuyu voice → en-KE → any English → (silent)
        └── prompt + routing         phrase dictionary rewrites Swahili/Kikuyu commands to English
```

## 1. The language setting

`settings.language = { mode, sttLocale }` — one document, one source of truth, mirrored per device
in `localStorage['aria.lang']` so switching is instant.

| mode | What ARIA does | Microphone |
|---|---|---|
| `auto` (default) | Mirrors whatever you write/speak. Browsers recognise Swahili where they support it. | device default |
| `en` | Listens and answers in English (`en-KE` preferred). | `en-KE` |
| `sw` | Listens as `sw-KE`, answers in Swahili (deterministic replies are Swahili today; the model is instructed to answer in Swahili). | `sw-KE` |
| `ki` | Grounds Kikuyu phrases, answers in Swahili/English when unsure. | **disabled** — type instead |

`GET /api/language` returns the capability table (what the browser can and cannot do). The Settings
card shows the same truth in one line under the selector.

## 2. Speech-to-text — an honest capability negotiation

* **English / Swahili** — the mic is live and the recogniser is created with the right locale
  (`sw-KE`, `sw-TZ`, `en-KE`…). If the browser has no Swahili recogniser it raises
  `language-not-supported`, which ARIA already turns into a plain "voice input does not support this
  language" toast — no silent failure.
* **Kikuyu** — `SpeechRecognition` has no `ki` model in Chrome, Edge, Safari or Firefox. So with
  `ki` active the mic button is **disabled, badged ⌨️ and titled** "Kikuyu voice input is not
  supported by any browser — type your Kikuyu instead", and the status line says the same. Clicking
  it never opens the microphone (asserted in the tests), so there is no garbled English transcript
  of Kikuyu speech.
* Typed Kikuyu goes through the same assistant path as everything else and matches the dictionary.

**Custom STT future path (documented, not built):** a real Kikuyu recogniser needs a model — either
a cloud STT that offers Kikuyu/`ki-KE`, or an on-device model such as a Whisper variant fine-tuned
on Kikuyu, run through the same bridge pattern as the Android connector. The UI is ready for it:
`sttLocale()` returns the locale, `sttSupported()` decides the badge, and `create()` uses whatever
locale the policy reports — adding a recogniser is a policy change plus a transport, not a rewrite.

## 3. Text-to-speech — voice selection and safe fallbacks

`pickVoiceFor(list, gender, mode)` is a pure function (unit-tested with fake voice lists):

1. Look for a voice whose locale matches the mode: `ki` → `ki*`, `sw` → `sw-KE`/`sw-TZ`/`sw`,
   `en` → `en-KE` then `en-US`/`en-GB`.
2. If the device has no voice for that language, **fall back in a documented order**:
   Kikuyu → Swahili → Kenyan English → any English; Swahili → Kenyan English → any English.
3. Inside the chosen pool, the existing gender preference wins (ARIA defaults to a male voice).

If `speechSynthesis` is missing or the list is empty, `speak()` resolves `false` without throwing and
the hands-free loop still closes (text reply, no audio). ARIA never claims she spoke when she could
not.

## 4. The editable phrase dictionary (`/api/dictionary`)

A real store (`db.meta`/document store, seeded once, then yours to edit) of **55 seed phrases**
covering Swahili, Kikuyu and Sheng. Each entry is:

```json
{ "phrase": "weka kengele", "lang": "sw", "intent": "alarm-set",
  "command": "set an alarm {rest}", "note": "set an alarm", "enabled": true }
```

* `{rest}` keeps whatever followed the phrase ("weka kengele **kesho asubuhi**" → `set an alarm
  tomorrow morning`; `leo/kesho/jana/asubuhi/mchana/jioni/usiku` are substituted best-effort).
* Matching is deterministic: whole-word, longest-phrase-first, leading fillers allowed ("hey ARIA,
  habari"). An **actionable** phrase beats a social one, so *"habari, weka kengele"* is an alarm —
  not a greeting.
* Longest match wins, so `habari ya asubuhi` never degrades to `habari`.

| Endpoint | What it does |
|---|---|
| `GET /api/dictionary` | All entries + counts by language + current mode |
| `POST /api/dictionary` | Add a phrase (`phrase`, `lang`, `intent`, optional `command`/`note`) |
| `PUT\|PATCH /api/dictionary/:id` | Edit any field (including `enabled: false` to park one) |
| `DELETE /api/dictionary/:id` | Delete a phrase |
| `POST /api/dictionary/reset` | Restore the seeds (your own phrases are kept) |
| `POST /api/dictionary/match` | Debug: what would the normalizer do with this text? |

Every write is audited under `integration: 'dictionary'`. The editor lives in **Second Brain →
🗣️ Language & phrases** (add / edit / delete / restore), so adding a Kikuyu command you use daily
takes ten seconds and works on the very next message — no restart, no model retraining.

Seeded out of the box include: `habari ya asubuhi`, `mambo vipi`, `sema`, `poa`, `asante sana`,
`kwaheri`, `wĩ mwega`, `ũhoro waku`, `nĩ wega`, `ndĩ mwega`, `ũmĩthĩ mwega`, `kĩhana`, `ngatho`,
`thiĩ na wega`, `tiga`, and the commands `panga siku yangu`, `weka kengele`, `nikumbushe`,
`ongeza kazi`, `cheza muziki`, `simamisha muziki`, `weka sauti`, `sahau`, `kumbuka`, `piga simu kwa`.

## 5. Grounding: what the model receives

Two injections, both from the same store (`dictionary.promptBlock`):

1. **Language policy** — reply in the language the user wrote in, mirror Kenyan code-switching
   (English + Swahili + Sheng mixed) instead of forcing one language, and keep Kikuyu to short
   well-known phrases — *never invent Kikuyu grammar* — falling back to Swahili/English when unsure.
2. **Ground truth** — every phrase detected in the current message, plus the active non-English
   vocabulary (up to 40 entries), so a model with weak Swahili/Kikuyu tokenisation still gets the
   meaning right.

The block is only added when it can change behaviour (a non-English mode, or a dictionary phrase),
so an English-only install sends exactly the same prompt as before. Deterministic social intents
(greeting, thanks, goodbye, help, the honest "I cannot dial" answer) never reach the model at all.

## 6. Honest limits

* **Kikuyu speech recognition does not exist in browsers.** ARIA says this in Settings, on the mic
  button, in `GET /api/language` (`stt.kikuyu: false`) and here. Typed Kikuyu + dictionary phrases are
  what work today.
* **Kikuyu replies are conservative.** ARIA answers in Swahili (stated in the reply) rather than
  generating Kikuyu she cannot verify. Add your own phrases — including reply-worthy ones — in the
  dictionary.
* Dictionary matching is **phrase mapping, not translation**. Long Swahili/Kikuyu sentences that do
  not start with a dictionary phrase go to the model, which may answer in the wrong language; the
  language block tells it not to guess.
* Swahili time idioms ("saa mbili") are **not** converted to clock times — say the time in digits or
  the English word ("at 8am", "kesho asubuhi"). This is documented rather than half-implemented.
* Nothing here adds a dependency, a paid service or a network hop: it is Web Speech APIs + one JSON
  store.

## 7. Tests

`scripts/test-app.js`:

* `[3p]` — 64 checks: seeded dictionary (Swahili/Kikuyu/Sheng), normalization
  (`weka kengele kesho asubuhi` → `set an alarm tomorrow morning`), longest-match and whole-word
  safety, multi-phrase messages, CRUD + duplicates + validation + 404s + disable/enable + reset +
  audit, language modes in settings and `/api/state`, Kikuyu STT reported unavailable, prompt
  injection (policy + grounding + no English bloat), all deterministic intents, an owner-added phrase
  routing immediately, and the mode restored afterwards.
* `[5d]` — 39 checks: STT locale routing, the TTS fallback table, the silent no-TTS path, the
  Settings language selector persisting server-side, Kikuyu mic degradation (disabled, badged,
  clicking does nothing), and a real `sw-KE` recognizer locale.
