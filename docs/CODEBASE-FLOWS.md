# QuoteLane: Codebase Flows

A visual map of the code, module by module: **which function runs, when, who calls it, and what it calls next.**

> **Viewing the diagrams:** they render automatically on GitHub. In VS Code, install the *Markdown Preview Mermaid Support* extension, then open the preview (`Ctrl+Shift+V`).

**How to read this doc**

| Section | Answers |
|---|---|
| [1. The big picture](#1-the-big-picture) | What are the layers and who depends on whom? |
| [2. One visitor, end to end](#2-one-visitor-end-to-end) | In what order does everything run for a single lead? |
| [3. `proxy.ts`](#3-proxyts--the-request-pipeline) | What happens before any page renders? |
| [4. Domain: input cleaning + prefill](#4-domain-input-cleaning--prefill) | How does a raw URL value become a trusted answer? |
| [5. Domain: tracking](#5-domain-tracking) | How do click_id / aff_id survive the journey? |
| [6. Domain: A/B variant](#6-domain-ab-variant) | How is A or B decided? |
| [7. Domain: step engine](#7-domain-step-engine) | Which step does the visitor see, and what's next? |
| [8. Pages (server components)](#8-pages-server-components) | What does each route render and read? |
| [9. Client funnel](#9-client-funnel-store--funnel--steps) | How do the store, `Funnel` and step components work together? |
| [10. `POST /api/leads`](#10-post-apileads--lead-capture) | What happens when "Get My Quotes" is clicked? |
| [11. Partner delivery](#11-partner-delivery-outbox) | How is the lead sent exactly once, with a timeout and a retry? |
| [12. Cron + health](#12-cron--health-routes) | How are stuck deliveries recovered? |
| [13. Shared server utilities](#13-shared-server-utilities) | config, logger, crypto, http, db |
| [14. Cookies](#14-cookie-lifecycle) | Who writes and who reads each cookie? |
| [15. Database](#15-database-tables-and-who-touches-them) | Which function touches which table? |
| [16. Where do I find…?](#16-where-do-i-find) | Quick lookup |

---

## 1. The big picture

Four layers. **Arrows point from caller to callee.** The rule that keeps it testable: `domain/` never imports from anything else.

```mermaid
flowchart TB
    subgraph EDGE["Request entry"]
        PROXY["src/proxy.ts<br/>runs before every page"]
    end

    subgraph APP["src/app — routes"]
        LAND["page.tsx<br/>landing /"]
        QUOTE["quote/v/[variant]/page.tsx<br/>form /quote"]
        TY["thank-you/page.tsx"]
        API["api/leads/route.ts<br/>POST"]
        CRON["api/cron/deliveries/route.ts"]
        HEALTH["api/health/route.ts"]
    end

    subgraph UI["src/components — browser"]
        LZ["LandingZip.tsx"]
        FUN["funnel/Funnel.tsx"]
        STEPS["funnel/steps.tsx"]
        STORE["funnel/store.ts"]
        KIT["ui.tsx"]
    end

    subgraph SERVER["src/server — Node only"]
        LS["leads/lead.service.ts"]
        OUT["delivery/outbox.ts"]
        PC["delivery/partner-client.ts"]
        PAY["delivery/payload.ts"]
        RL["rate-limit.ts"]
        PPC["prepop-cookie.ts"]
        PGC["page-context.ts"]
        UTIL["config · logger · http<br/>crypto/seal · db/client · db/schema"]
    end

    subgraph DOMAIN["src/domain — pure logic, no imports from other layers"]
        D1["sanitize · fields · prepop"]
        D2["tracking · tracking-cookie"]
        D3["variant · bots · cookies"]
        D4["steps · consent · lead-schema"]
    end

    PROXY --> D1 & D2 & D3
    PROXY --> PPC
    LAND --> PGC --> PPC
    QUOTE --> PGC
    LAND --> LZ
    QUOTE --> FUN
    FUN --> STEPS & STORE & D4
    LZ --> STORE & STEPS
    STEPS --> KIT & D1 & D4
    API --> LS --> RL & PPC & D1 & D2 & D3 & D4
    API -. "after response" .-> OUT
    CRON --> OUT
    OUT --> PC & PAY
    LS & OUT & RL & PPC --> UTIL
    FUN -. "fetch POST" .-> API
```

| Layer | Folder | Runs where | Job |
|---|---|---|---|
| Entry | `src/proxy.ts` | Server, before routing | Capture tracking + prefill, strip PII from the URL, pick the variant |
| Routes | `src/app/` | Server | Render pages, expose the API |
| UI | `src/components/` | Browser | Show the steps, hold answers, submit |
| Server | `src/server/` | Server (Node) | DB, crypto, delivery, logging |
| Domain | `src/domain/` | **Both** browser and server | Every rule and validator, as pure functions |

---

## 2. One visitor, end to end

The full timeline for one affiliate visitor, from click to partner delivery. Each box is a real function name.

```mermaid
sequenceDiagram
    autonumber
    actor V as Visitor browser
    participant PX as proxy.ts<br/>proxy()
    participant PG as quote page<br/>QuotePage()
    participant FN as Funnel.tsx<br/>Funnel()
    participant ST as store.ts<br/>funnelStore
    participant API as api/leads<br/>POST()
    participant SVC as lead.service<br/>submitLead()
    participant DB as Postgres
    participant OB as outbox.ts<br/>deliverLead()
    participant P as Partner

    V->>PX: GET /?click_id=abc&aff_id=42&email=sam%40x.com&zip=90210
    Note over PX: parseTracking() · mergeTracking()<br/>parsePrepop() · sealPrepop()<br/>resolveVariant()
    PX-->>V: 303 → /quote (clean URL) + cookies ql_vid ql_trk ql_pp ql_v
    V->>PX: GET /quote
    PX->>PG: rewrite → /quote/v/a (URL stays /quote)
    PG->>PG: readPrepopForPage() → unsealPrepop()
    PG-->>V: HTML with Funnel(variant, prepop)
    V->>FN: hydrate
    FN->>ST: applyPrepop(prepop) — once per nonce
    FN->>FN: resolveStep() → first unanswered step
    loop each step
        V->>FN: click an answer
        FN->>ST: setAnswers()
        FN->>FN: nextStep() → goTo() pushState ?step=…
    end
    V->>FN: click "Get My Quotes"
    FN->>API: fetch POST /api/leads + Idempotency-Key
    API->>SVC: submitLead(ctx, body)
    SVC->>DB: rate limit · validate · locks · dedupe · INSERT lead+consent+outbox
    SVC-->>API: created
    API-->>FN: 201 { leadId }
    FN->>ST: reset()
    FN-->>V: router.replace /thank-you?ref=…
    API-)OB: after(): deliverLead(leadId)
    OB->>DB: claim()
    OB->>P: sendToPartner() — 5s timeout, max 2 attempts
    OB->>DB: recordAttempt() · finish(delivered)
```

---

## 3. `proxy.ts` — the request pipeline

**When:** on every `GET` to `/`, `/quote` and `/quote/*` (see `config.matcher`), before the page renders.
**File:** [src/proxy.ts](../src/proxy.ts)

```mermaid
flowchart TD
    START(["proxy(req)"]) --> INTERNAL{"path starts with /quote/v ?"}
    INTERNAL -->|yes| R307["307 redirect → /quote<br/>(stops people bypassing the split)"]
    INTERNAL -->|no| FLAGS["isPrefetch = prefetch headers<br/>isBot = isSearchBot(UA)<br/>writable = !isPrefetch && !isBot"]

    FLAGS --> VID{"ql_vid cookie valid?"}
    VID -->|no| NEWVID["visitorId = crypto.randomUUID()<br/>queue Set-Cookie ql_vid (if writable)"]
    VID -->|yes| PARAMS
    NEWVID --> PARAMS["hasConsumable = URL has tracking/prefill/variant keys<br/>params = lowerCaseKeys(searchParams)"]

    PARAMS --> W{"writable?"}
    W -->|no — bot / prefetch| ROUTE
    W -->|yes| TRK["existing = decodeTrackingCookie(ql_trk)<br/>incoming = parseTracking(params)<br/>mergeTracking(existing, incoming)"]
    TRK --> NEWCLICK{"isNewClick or no cookie?"}
    NEWCLICK -->|yes| MINT["qlClickId = prefix_ + ulid()<br/>landedAt = now"]
    NEWCLICK -->|no| SETTRK
    MINT --> SETTRK["queue Set-Cookie ql_trk = encodeTrackingCookie()"]
    SETTRK --> HC{"hasConsumable?"}
    HC -->|no| ROUTE
    HC -->|yes| PP["prepop = parsePrepop(params)<br/>secret = getAppSecretOrNull()"]
    PP --> HASPP{"valid prefill values?"}
    HASPP -->|yes| SEAL["sealPrepop({nonce: ulid(), values})<br/>queue Set-Cookie ql_pp (2h, HttpOnly)"]
    HASPP -->|no, but new click| DELPP["queue delete ql_pp<br/>(don't inherit old click's PII)"]
    HASPP -->|no| STRIP
    SEAL --> STRIP
    DELPP --> STRIP
    STRIP["clean URL = remove consumed params<br/>if path is / and prepop.zip → path = /quote"] --> R303["303 redirect<br/>Cache-Control: no-store<br/>Referrer-Policy: no-referrer<br/>+ applyVariantCookies() + queued cookies"]

    ROUTE{"path = /quote ?"}
    ROUTE -->|yes| DECIDE["decide() → resolveVariant()"]
    DECIDE --> REWRITE["rewrite → /quote/v/{a|b}<br/>Cache-Control: private, no-store<br/>applyVariantCookies() if writable"]
    ROUTE -->|no| NEXT["NextResponse.next() + queued cookies"]
```

**Helper functions inside `proxy.ts`**

| Function | Called when | Does |
|---|---|---|
| `proxy(req)` | Every matched request | The pipeline above |
| `decide(req, visitorId, params, isBot)` | Rewrite for `/quote`, and from `applyVariantCookies` | Collects cookies + `?variant=` + split config → `resolveVariant()` |
| `applyVariantCookies(...)` | On the 303 redirect and the `/quote` rewrite | Writes `ql_vo` (session) / deletes it, writes `ql_v` (sticky). Never for bots. |
| `lowerCaseKeys(sp)` | Once per request | `Click_ID` and `EMAIL` match like `click_id` and `email` |

---

## 4. Domain: input cleaning + prefill

**When:** the proxy calls `parsePrepop()` on arrival; the server calls `revalidatePrepop()` every time it reads the prefill back from the cookie.
**Files:** [sanitize.ts](../src/domain/sanitize.ts) · [fields.ts](../src/domain/fields.ts) · [prepop.ts](../src/domain/prepop.ts)

### 4a. One raw value → trusted value

```mermaid
flowchart LR
    RAW["raw value from URL<br/>e.g. ' sam%40x.com '"] --> FP["firstParam(params, aliases)<br/>tries zip, zipcode, zip_code…"]
    FP --> CP["cleanParam(raw)"]

    subgraph CLEAN["cleanParam — sanitize.ts"]
        direction TB
        C1{"length > 512?"} -->|yes| NULL1["null"]
        C1 -->|no| C2["decodeResidual()<br/>one more % decode"]
        C2 --> C3["NFC normalize · strip control chars<br/>collapse spaces · trim"]
        C3 --> C4{"isNullish() or isMacro()?<br/>null, undefined, {sub5}, [EMAIL], %%x%%"}
        C4 -->|yes| NULL2["null"]
        C4 -->|no| OK["clean string"]
    end

    CP --> CLEAN
    OK --> NORM["field normalizer — fields.ts"]
    NORM --> VALID{"returns value?"}
    VALID -->|yes| KEEP["added to Prepop"]
    VALID -->|no| DROP["dropped silently<br/>step shows as normal"]
```

### 4b. Field normalizers (fields.ts)

```mermaid
flowchart TB
    subgraph NORMALIZERS["fields.ts — each returns canonical value or null"]
        Z["normalizeZip<br/>'90210-1234' → '90210'<br/>rejects 1234, 00000, 000xx"]
        N["normalizeName<br/>'SAM' → 'Sam'<br/>letters, ' - . only"]
        E["normalizeEmail<br/>lower-case, restore '+'<br/>needs real TLD"]
        PH["normalizePhone<br/>'+1 (555) 123-4567' → '5551234567'<br/>rejects letters, N11, 1111111111"]
        Y["normalizeYear<br/>1981 … next year"]
        I["normalizeInsured<br/>yes/y/true/1 → true"]
        MK["normalizeMake"]
        AG["normalizeAgeRange"]
    end

    PARSE["parsePrepop()<br/>prepop.ts"] --> Z & N & E & PH & Y & I
    REVAL["revalidatePrepop()<br/>prepop.ts"] --> PARSE
    SCHEMA["leadSubmissionSchema<br/>lead-schema.ts — via field()"] --> Z & N & E & PH & Y & I & MK & AG
    UIV["steps.tsx<br/>ZipStep / ContactStep validate()"] --> Z & N & E & PH
    STEPENG["steps.ts<br/>isStepAnswered()"] --> Z & Y & MK & AG
```

**Same validators, three callers.** The proxy uses them to decide what to prefill, the browser to show instant errors, and the API as the final authority. One rule, one place.

### 4c. Validation schema used by the API

```mermaid
flowchart LR
    BODY["request body (unknown)"] --> SP["leadSubmissionSchema.safeParse()"]
    SP --> DU{"discriminatedUnion on variant"}
    DU -->|"a"| SA["zip, insured, contact fields<br/>+ vehicleYear, vehicleMake, ageRange"]
    DU -->|"b"| SB["zip, insured, contact fields"]
    SA & SB --> COMMON["consentVersion → isConsentVersion()<br/>pageUrl → origin + path only"]
    COMMON --> RES{"success?"}
    RES -->|no| FE["fieldErrors(error)<br/>→ { field: message }"]
    RES -->|yes| LS["LeadSubmission (normalized)"]
```

---

## 5. Domain: tracking

**When:** captured by the proxy on arrival; read back by `submitLead()` on submit.
**Files:** [tracking.ts](../src/domain/tracking.ts) · [tracking-cookie.ts](../src/domain/tracking-cookie.ts)

```mermaid
flowchart TD
    URL["?click_id=abc&aff_id=42&channel=SMS&sub1=x"] --> PT["parseTracking(params)"]
    PT --> PICK["pick() per key with strict regex<br/>click_id: [A-Za-z0-9._~-] ≤128<br/>aff_id: [A-Za-z0-9_-] ≤64"]
    PT --> PCH["parseChannel()<br/>SMS/text/mms → sms<br/>push → unknown + channelRaw=push"]
    PICK & PCH --> INC["incoming Tracking"]

    COOKIE["ql_trk cookie"] --> DEC["decodeTrackingCookie()<br/>base64 → JSON"]
    DEC --> REV["revalidateTracking()<br/>re-runs parseTracking rules<br/>checks qlClickId format"]
    REV --> EX["existing Tracking"]

    INC & EX --> MT["mergeTracking(existing, incoming)"]
    MT --> Q{"new, different click_id?"}
    Q -->|yes| REPLACE["incoming replaces all<br/>isNewClick = true<br/>(last click wins)"]
    Q -->|no| FILL["keep existing, fill gaps<br/>isNewClick = false"]
    REPLACE & FILL --> ENC["encodeTrackingCookie() → ql_trk"]

    ENC -. "later, on submit" .-> SUBMIT["submitLead()<br/>decodeTrackingCookie(ql_trk)<br/>→ aff_click_id, aff_id, channel,<br/>ql_click_id, sub_ids on the lead"]
```

**Two click IDs:** `affClickId` is the affiliate's ID, stored as given. `qlClickId` is ours, minted in the proxy as `ql_<ULID>`. They are never mixed.

---

## 6. Domain: A/B variant

**When:** the proxy calls it to choose which form to render; `submitLead()` calls it again to record *why* the visitor saw that version.
**File:** [variant.ts](../src/domain/variant.ts)

```mermaid
flowchart TD
    IN(["resolveVariant(input)"]) --> F{"force = parseForceParam(?variant=)"}
    F -->|"a or b"| FORCED["variant = forced<br/>source = forced<br/>setOverride = a/b (session cookie)"]
    F -->|"clear"| CLR["setOverride = null (delete)<br/>continue below"]
    F -->|none| OV{"override cookie ql_vo valid?"}
    OV -->|yes| FORCED2["variant = cookie<br/>source = forced"]
    OV -->|no| UNF
    CLR --> UNF

    subgraph UNF["resolveUnforced()"]
        direction TB
        B{"isBot?"} -->|yes| BOT["A · source = bot · no cookies"]
        B -->|no| K0{"percentB ≤ 0?"}
        K0 -->|yes| KA["A · source = killswitch"]
        K0 -->|no| K100{"percentB ≥ 100?"}
        K100 -->|yes| KB["B · source = killswitch"]
        K100 -->|no| S{"sticky cookie ql_v valid?"}
        S -->|yes| STK["that variant · source = sticky"]
        S -->|no| BK["bucketOf(visitorId) < percentB ? B : A<br/>source = assigned · setSticky"]
    end
```

| Helper | Does |
|---|---|
| `parseSplitPercent(env)` | `"37"` → 37. Garbage, empty or out of range → **0** (safe default: everyone sees A) |
| `bucketOf(visitorId)` | FNV-1a hash → 0..99. Same visitor, same bucket, forever |
| `parseForceParam(raw)` | `a` / `b` / `clear` / null |
| `isVariant(v)` | Type guard, used to reject junk cookie values |

---

## 7. Domain: step engine

**When:** `Funnel.tsx` calls it on every render and every click.
**File:** [steps.ts](../src/domain/steps.ts)

```mermaid
flowchart LR
    subgraph LISTS["STEPS"]
        A["a: zip → year → make → insured → age → contact"]
        B["b: zip → insured → contact"]
    end

    ISA["isStepAnswered(step, answers)<br/>re-validates the stored answer<br/>contact → always false"]
    FU["firstUnansweredStep()<br/>first step where isStepAnswered = false"]
    RS["resolveStep(variant, ?step, answers)<br/>allowed if ≤ frontier, else frontier"]
    NS["nextStep(variant, current, answers)<br/>skips forward over answered steps"]
    PS["prevStep(variant, current)<br/>previous step in the list, never skips"]
    PR["progress(variant, current)<br/>Step i of n + percent"]

    LISTS --> FU & NS & PS & PR
    ISA --> FU & NS
    FU --> RS
```

**Example, variant A with zip + insured prefilled:**

```mermaid
flowchart LR
    zip["zip ✓ prefilled"] --> year["year ← lands here"] --> make --> insured["insured ✓ prefilled"] --> age --> contact
    make -. "nextStep() skips insured" .-> age
    age -. "prevStep() Back goes to insured" .-> insured
```

---

## 8. Pages (server components)

**When:** each time the route is requested (all are dynamic: they read cookies).

```mermaid
flowchart TD
    subgraph LANDING["/ — app/page.tsx · LandingPage()"]
        L1["readPrepopForPage()"] --> L2["render SiteHeader + hero + LandingZip(prepop)"]
    end

    subgraph QUOTEPG["/quote → rewritten to /quote/v/[variant] — QuotePage()"]
        Q1["await params → isVariant()? else notFound()"] --> Q2["readPrepopForPage()"]
        Q2 --> Q3["render SiteHeader + main[data-variant] + Suspense + Funnel(variant, prepop)"]
    end

    subgraph TYPG["/thank-you — ThankYouPage()"]
        T1["searchParams.ref → must match ULID regex"] --> T2["render confirmation + reference"]
    end

    RPP["page-context.ts · readPrepopForPage()<br/>cookies() → ql_pp → unsealPrepop()"]
    L1 --> RPP
    Q2 --> RPP
    RPP --> UPP["prepop-cookie.ts · unsealPrepop()<br/>→ seal.ts unseal() → revalidatePrepop()"]
```

The layout ([layout.tsx](../src/app/layout.tsx)) only sets **static** metadata (title, viewport), so no visitor data can reach the tab title.

---

## 9. Client funnel (store + Funnel + steps)

### 9a. The store — [store.ts](../src/components/funnel/store.ts)

A tiny external store, persisted to `sessionStorage` under `ql_funnel_v1`.

```mermaid
flowchart LR
    subgraph STATE["FunnelState"]
        S1["answers"]
        S2["prefilled[] (UI hint)"]
        S3["prepopNonce"]
        S4["idempotencyKey (UUID)"]
    end

    GET["get()<br/>lazy load() from sessionStorage"] --> STATE
    AP["applyPrepop(env)<br/>if env.nonce ≠ prepopNonce →<br/>fresh state with prefilled answers"] --> COMMIT
    SA["setAnswers(patch)<br/>merge · drop edited keys from prefilled[]"] --> COMMIT
    RS["reset()<br/>fresh() — new idempotencyKey"] --> COMMIT
    COMMIT["commit(next)<br/>save to sessionStorage<br/>notify listeners"] --> STATE
    HOOK["useFunnelState()<br/>useSyncExternalStore<br/>null on server → skeleton"] --> GET
```

| Function | Called by | When |
|---|---|---|
| `applyPrepop` | `Funnel`, `LandingZip` (in `useLayoutEffect`) | First paint of a page that received a prefill |
| `setAnswers` | `answerAndAdvance`, `ContactStep` `onBlur`, `submit` | Each answer |
| `reset` | `Funnel.submit` | After `201`/`200` |
| `useFunnelState` | `Funnel`, `LandingZip` | Every render |

### 9b. `Funnel.tsx` — render + navigation

**File:** [Funnel.tsx](../src/components/funnel/Funnel.tsx)

```mermaid
flowchart TD
    R(["Funnel({variant, prepop}) render"]) --> LE["useLayoutEffect → funnelStore.applyPrepop(prepop)"]
    R --> ST["state = useFunnelState()"]
    ST --> NULL{"state null / done?"}
    NULL -->|yes| SK["FunnelSkeleton"]
    NULL -->|no| RSV["step = resolveStep(variant, ?step, answers)"]
    RSV --> SYNC["useEffect: if URL ≠ step →<br/>history.replaceState(?step=step)"]
    RSV --> UI["progress() → progress bar<br/>prevStep() → Back button<br/>render step component"]

    UI --> PICK{"step"}
    PICK -->|zip| ZS["ZipStep"]
    PICK -->|year| YS["YearStep"]
    PICK -->|make| MS["MakeStep"]
    PICK -->|insured| IS["InsuredStep"]
    PICK -->|age| AS["AgeStep"]
    PICK -->|contact| CS["ContactStep key=errorsVersion"]

    ZS & YS & MS & IS & AS -->|onAnswer| AAA["answerAndAdvance(step)(patch)<br/>1. funnelStore.setAnswers(patch)<br/>2. clear serverErrors for those fields<br/>3. goTo(nextStep(...))"]
    AAA --> GO["goTo(s)<br/>history.pushState(?step=s)<br/>scrollTo top"]
    BACK["Back button"] --> GO
    CS -->|onSubmit| SUB["submit(contact) — see 9c"]
```

### 9c. Submitting — `Funnel.submit()`

```mermaid
flowchart TD
    S(["submit(contact)"]) --> G{"submitting?"}
    G -->|yes| X["ignore (double-click guard #1)"]
    G -->|no| A["funnelStore.setAnswers(contact)<br/>build body: variant, answers,<br/>consentVersion, pageUrl"]
    A --> F["fetch POST /api/leads<br/>header Idempotency-Key = store key<br/>(double-click guard #2)"]
    F --> NET{"network error?"}
    NET -->|yes| NE["formError: connection message<br/>key kept for retry"]
    NET -->|no| ST{"status"}
    ST -->|"201 / 200"| OK["setDone(true) → skeleton<br/>funnelStore.reset()<br/>router.replace(/thank-you?ref=leadId)"]
    ST -->|"422 + fieldErrors"| FE["setServerErrors · errorsVersion++<br/>find earliest step with an error<br/>goTo(that step) unless contact"]
    ST -->|"409 / 429 / 5xx"| ME["formError = server message"]
```

### 9d. Step components — [steps.tsx](../src/components/funnel/steps.tsx)

| Component | Input | Validation | Advances by |
|---|---|---|---|
| `ZipStep` | text input | `normalizeZip` on submit | `onAnswer({zip})` |
| `YearStep` | 8 recent-year buttons + an older-years `<select>` | buttons only offer valid years | click |
| `MakeStep` | popular-make buttons + other `<select>` | list only | click |
| `InsuredStep` | Yes / No buttons | n/a | click |
| `AgeStep` | age range buttons | list only | click |
| `ContactStep` | first, last, email, phone + consent text | `validate()` runs all four normalizers; focuses the first bad field | `onSubmit(values)` |

`ContactStep.bind(field)` wires each input: value, error, a "prefilled" hint, `onChange` (clears that error) and `onBlur` (saves the valid value to the store, so a refresh keeps it).

UI building blocks come from [ui.tsx](../src/components/ui.tsx): `SiteHeader`, `PrimaryButton`, `OptionButton`, `TextField`, `FieldError`, `PrefilledNote`.

### 9e. Landing → form — [LandingZip.tsx](../src/components/LandingZip.tsx)

```mermaid
flowchart LR
    LZ["LandingZip(prepop)"] --> AP["useLayoutEffect → applyPrepop"]
    LZ --> ZS["ZipStep key=client|server<br/>remounts once client state loads"]
    ZS -->|onAnswer| SA["funnelStore.setAnswers({zip})"] --> RP["router.push('/quote')<br/>→ proxy rewrites to variant"]
```

---

## 10. `POST /api/leads` — lead capture

### 10a. The route adapter — [route.ts](../src/app/api/leads/route.ts)

```mermaid
flowchart TD
    P(["POST(req)"]) --> O{"isAllowedOrigin()?"}
    O -->|no| E403["403 forbidden"]
    O -->|yes| CT{"content-type JSON?"}
    CT -->|no| E415["415"]
    CT -->|yes| IK{"Idempotency-Key matches IDEMPOTENCY_KEY_RE?"}
    IK -->|no| E400["400 missing_idempotency_key"]
    IK -->|yes| SZ{"body ≤ 16KB and valid JSON?"}
    SZ -->|no| E413["413 / 400"]
    SZ -->|yes| CALL["submitLead(ctx, body)<br/>ctx = getConfig(), getDb(), getSplitConfig(),<br/>clientIp(headers), user-agent header,<br/>cookies ql_trk ql_pp ql_v ql_vo ql_vid"]
    CALL --> K{"result.kind"}
    K -->|created| C201["after(() → deliverLead()) if partner configured<br/>201 {leadId} · delete ql_pp"]
    K -->|replay| C200["200 {leadId} · Idempotent-Replayed · delete ql_pp"]
    K -->|duplicate| C409["409"]
    K -->|idempotency_conflict| C422a["422"]
    K -->|invalid| C422["422 {fieldErrors}"]
    K -->|rate_limited| C429["429 + Retry-After"]
    CALL -. throws .-> C500["log.error · 500 generic message"]
```

### 10b. The use case — `submitLead()` in [lead.service.ts](../src/server/leads/lead.service.ts)

```mermaid
flowchart TD
    S(["submitLead(ctx, body)"]) --> RL["1 · hmacHex(ip) → consumeRateLimit(db, ipKey)"]
    RL --> RLQ{"ok?"}
    RLQ -->|no| RLX["return rate_limited"]
    RLQ -->|yes| V["2 · leadSubmissionSchema.safeParse(body)"]
    V --> VQ{"valid?"}
    VQ -->|no| VX["return invalid + fieldErrors()"]
    VQ -->|yes| CTX["3 · server-side context<br/>decodeTrackingCookie(ql_trk)<br/>unsealPrepop(ql_pp) → computeProvenance()<br/>resolveVariant() → variantSource or 'mismatch'<br/>routing profile from PARTNER_SOURCE_IDS[channel]<br/>toE164(phone) · hmacHex(canonical(input))"]
    CTX --> TX["4 · db.transaction"]

    subgraph TXN["inside one transaction"]
        direction TB
        L["pg_advisory_xact_lock × 3<br/>idem:key · email:x · phone:y — sorted"] --> I{"lead with this idempotency key?"}
        I -->|"yes, same requestHash"| REP["return replay"]
        I -->|"yes, different hash"| CON["return idempotency_conflict"]
        I -->|no| D{"same email OR phone<br/>in last 24h?"}
        D -->|yes| DUP["return duplicate"]
        D -->|no| INS["INSERT leads (publicId = ulid())<br/>INSERT consents (server text, ip, ua)<br/>INSERT partner_deliveries<br/>status pending | skipped_unconfigured"]
        INS --> CR["return created"]
    end

    TX --> TXN
    TX -. "unique violation on idempotency_key" .-> BS["isUniqueViolation() → re-select → replay"]
```

**`computeProvenance(input, prepop)`**: for each submitted field, if the sealed prefill had that field it records `{source: "prefill", modified: value changed?}`; otherwise `{source: "typed"}`.

---

## 11. Partner delivery (outbox)

**When:** started by `after()` right after the `201` is sent; also by the cron sweep.
**Files:** [outbox.ts](../src/server/delivery/outbox.ts) · [partner-client.ts](../src/server/delivery/partner-client.ts) · [payload.ts](../src/server/delivery/payload.ts)

### 11a. `deliverLead()` loop

```mermaid
flowchart TD
    DL(["deliverLead(deps, leadId)"]) --> U{"PARTNER_WEBHOOK_URL set?"}
    U -->|no| UC["return unconfigured"]
    U -->|yes| CL["claim(db, leadId)<br/>atomic UPDATE … RETURNING<br/>status → sending, attempts+1, lease 30s"]
    CL --> CQ{"got a row?"}
    CQ -->|no| NC["return not_claimed<br/>(someone else has it, or done)"]
    CQ -->|yes| LD["load lead ⨝ consent"]
    LD --> BP["buildPartnerPayload(lead, consent, sourceId)"]
    BP --> SEND["sendToPartner({url, body, idempotencyKey: publicId,<br/>timeoutMs, signingSecret})"]
    SEND --> RA["recordAttempt() → delivery_attempts row"]
    RA --> R{"result"}
    R -->|ok 2xx| DEL["finish(status delivered) → return delivered"]
    R -->|"retryable AND attempt < 2"| RW["finish(status retry_wait, nextAttemptAt +1s)<br/>sleep(1s)"]
    RW --> CL
    R -->|"permanent 4xx OR attempt 2 failed"| FAIL["finish(status failed) → return failed"]
```

### 11b. The delivery state machine (`partner_deliveries.status`)

```mermaid
stateDiagram-v2
    [*] --> pending: submitLead() INSERT
    [*] --> skipped_unconfigured: no PARTNER_WEBHOOK_URL
    pending --> sending: claim()
    retry_wait --> sending: claim() after nextAttemptAt
    sending --> delivered: 2xx
    sending --> retry_wait: timeout / network / 5xx / 408 / 425 / 429 (attempt 1)
    sending --> failed: other 4xx, or attempt 2 fails
    sending --> sending: lease expired → claim() again (attempts < 2)
    sending --> failed: lease expired on attempt 2 (sweepDeliveries)
    delivered --> [*]
    failed --> [*]
```

### 11c. One HTTP attempt — `sendToPartner()`

```mermaid
flowchart LR
    IN(["sendToPartner(opts)"]) --> H["headers: content-type, user-agent,<br/>idempotency-key = publicId"]
    H --> SIG{"signingSecret?"}
    SIG -->|yes| HM["x-quotelane-timestamp = ts<br/>x-quotelane-signature = v1=hmacHex(secret, ts.body)"]
    SIG -->|no| F
    HM --> F["fetch POST · AbortSignal.timeout(ms)<br/>redirect: error"]
    F --> RES{"outcome"}
    RES -->|"2xx"| OK["ok · retryable false"]
    RES -->|"5xx · 408 · 425 · 429"| RT["retryable true · http_NNN"]
    RES -->|"other 4xx"| PM["retryable false · http_NNN"]
    RES -->|"TimeoutError / AbortError"| TO["retryable true · timeout"]
    RES -->|"other throw"| NW["retryable true · network"]
```

**`finish(db, leadId, attemptNo, set)`** only updates the row `WHERE status = 'sending' AND attempts = attemptNo`. A slow worker that lost its lease can't overwrite the newer worker's result.

### 11d. Payload shape — `buildPartnerPayload()`

```mermaid
flowchart LR
    LEAD["leads row"] --> PL
    CONS["consents row"] --> PL
    SRC["sourceId from PARTNER_SOURCE_IDS"] --> PL
    PL["payload v1"] --> F1["lead_id · created_at · brand · test"]
    PL --> F2["click_id (affiliate's) · aff_id<br/>sub_id (ours, ql_…) · source_id · channel · sub_ids"]
    PL --> F3["contact: first/last name, email, phone E.164, zip"]
    PL --> F4["vehicle · driver · variant"]
    PL --> F5["consent: version, text, consented_at, ip, user_agent, page_url"]
```

---

## 12. Cron + health routes

```mermaid
flowchart TD
    subgraph CRONR["GET /api/cron/deliveries — Vercel cron daily"]
        C1["safeEqual(Authorization, Bearer CRON_SECRET)?"] -->|no| C401["401"]
        C1 -->|yes| C2["sweepDeliveries({db, config})"]
        C2 --> C3["1 · mark failed: sending + lease expired + attempts ≥ 2"]
        C3 --> C4["2 · select due rows: pending/retry_wait due<br/>or sending with expired lease, attempts < 2"]
        C4 --> C5["3 · deliverLead() for each — same claim() guard"]
        C5 --> C6["purgeExpiredRateLimits(db)"]
        C6 --> C7["log.info · 200 {processed, exhausted, purged}"]
    end

    subgraph HEALTHR["GET /api/health"]
        H1["getSplitConfig()"] --> H2["getDb().execute(select 1)"]
        H2 -->|ok| H3["200 {db: up, splitPercentB, splitConfigValid}"]
        H2 -->|error| H4["503 {db: down}"]
    end
```

---

## 13. Shared server utilities

```mermaid
flowchart LR
    subgraph CFG["config.ts"]
        GC["getConfig()<br/>zod-parses env, memoized<br/>throws a clear error if invalid"]
        GSC["getSplitConfig()<br/>parseSplitPercent(SPLIT_PERCENT_B)"]
        GAS["getAppSecretOrNull()<br/>proxy-safe, never throws"]
        GBP["getBrandClickPrefix()"]
    end

    subgraph SEAL["crypto/seal.ts"]
        DK["deriveKey(secret, purpose)<br/>HKDF → AES-256-GCM key, cached"]
        SE["seal(data, secret, purpose, ttl)"]
        US["unseal(token, secret, purpose)<br/>null if tampered / expired"]
        HX["hmacHex(secret, msg)"]
        SE & US --> DK
    end

    subgraph HTTP["http.ts"]
        IP["clientIp(headers)<br/>x-real-ip / first x-forwarded-for, isIP()"]
        JS["json(body, status)<br/>adds Cache-Control: no-store"]
        AO["isAllowedOrigin(headers, url)"]
    end

    subgraph LOG["logger.ts"]
        LG["log.info / warn / error(event, fields)"] --> SC["scrub()<br/>allow-list keys · others → [redacted]<br/>errors cut to first line"]
    end

    subgraph DBM["db/client.ts"]
        CD["createDb(url)<br/>postgres.js pool, prepare:false"]
        GD["getDb()<br/>one pool per instance on globalThis"]
        GD --> CD
    end

    PPC["prepop-cookie.ts<br/>sealPrepop · unsealPrepop"] --> SE & US
    LS["lead.service"] --> HX
    PCL["partner-client"] --> HX
```

| Utility | Main callers |
|---|---|
| `getConfig` | `api/leads`, `api/cron` |
| `getSplitConfig` | `proxy` (via `decide`), `api/leads`, `api/health` |
| `getAppSecretOrNull` | `proxy`, `page-context` |
| `seal` / `unseal` | `prepop-cookie` only |
| `hmacHex` | `lead.service` (IP key, request hash), `partner-client` (signature) |
| `clientIp`, `isAllowedOrigin`, `json` | API routes |
| `log` | proxy, lead.service, outbox, API routes |

---

## 14. Cookie lifecycle

```mermaid
flowchart LR
    subgraph WRITERS["Written by"]
        PX["proxy()"]
        AV["applyVariantCookies()"]
        API["POST /api/leads"]
    end

    subgraph COOKIES["Cookies — all HttpOnly, SameSite=Lax"]
        VID["ql_vid · visitor id · 1y"]
        TRK["ql_trk · tracking · 30d"]
        PP["ql_pp · sealed prefill · 2h"]
        V["ql_v · sticky variant · 1y"]
        VO["ql_vo · forced variant · session"]
    end

    subgraph READERS["Read by"]
        PXR["proxy()"]
        PAGE["readPrepopForPage()"]
        SVC["submitLead()"]
    end

    PX --> VID & TRK & PP
    AV --> V & VO
    API -- "delete on success" --> PP

    VID --> PXR & SVC
    TRK --> PXR & SVC
    PP --> PAGE & SVC
    V --> PXR & SVC
    VO --> PXR & SVC
```

Browser JavaScript can't read any of these. The only browser-side storage is `sessionStorage` `ql_funnel_v1` (answers + idempotency key), cleared on submit.

---

## 15. Database tables and who touches them

```mermaid
flowchart LR
    subgraph FUNCS["Functions"]
        SL["submitLead()"]
        CRL["consumeRateLimit()"]
        PRL["purgeExpiredRateLimits()"]
        CLM["claim()"]
        FIN["finish()"]
        REC["recordAttempt()"]
        SWP["sweepDeliveries()"]
        DLV["deliverLead()"]
    end

    subgraph TABLES["Postgres — db/schema.ts"]
        L[("leads")]
        C[("consents")]
        PD[("partner_deliveries")]
        DA[("delivery_attempts")]
        RL[("rate_limits")]
    end

    SL -- "select idem/dupe · insert" --> L
    SL -- insert --> C
    SL -- insert --> PD
    CRL -- upsert --> RL
    PRL -- delete --> RL
    CLM -- "update … returning" --> PD
    FIN -- "fenced update" --> PD
    REC -- insert --> DA
    DLV -- "select lead ⨝ consent" --> L & C
    SWP -- "select due · mark exhausted" --> PD
```

Schema details and indexes: [docs/ARCHITECTURE.md §10](ARCHITECTURE.md#10-data-model). Migrations: [drizzle/](../drizzle).

---

## 16. Where do I find…?

| I want to change… | Go to |
|---|---|
| What counts as a valid ZIP / phone / email | [src/domain/fields.ts](../src/domain/fields.ts) |
| Which macros are ignored | [src/domain/sanitize.ts](../src/domain/sanitize.ts) → `MACRO_PATTERNS`, `NULLISH` |
| URL parameter names / aliases for prefill | [src/domain/prepop.ts](../src/domain/prepop.ts) → `PREPOP_PARAM_ALIASES` |
| Tracking params or channel aliases | [src/domain/tracking.ts](../src/domain/tracking.ts) |
| Split rules (kill switch, sticky, bots) | [src/domain/variant.ts](../src/domain/variant.ts) → `resolveVariant` |
| Which questions each version asks | [src/domain/steps.ts](../src/domain/steps.ts) → `STEPS` |
| Consent wording | [src/domain/consent.ts](../src/domain/consent.ts) (add a new version key; never edit an old one) |
| Error messages shown to visitors | [src/domain/lead-schema.ts](../src/domain/lead-schema.ts) → `MESSAGES` |
| Rate limits | [src/server/rate-limit.ts](../src/server/rate-limit.ts) → `LEAD_RATE_RULES` |
| Retry count / timeout / lease | [src/server/delivery/outbox.ts](../src/server/delivery/outbox.ts) → `MAX_ATTEMPTS`, `LEASE_SECONDS`, `RETRY_DELAY_MS`; env `PARTNER_TIMEOUT_MS` |
| What we send the partner | [src/server/delivery/payload.ts](../src/server/delivery/payload.ts) |
| Which log fields are allowed | [src/server/logger.ts](../src/server/logger.ts) → `SAFE_KEYS` |
| Security headers / CSP | [next.config.ts](../next.config.ts) |
| Cookie names and lifetimes | [src/domain/cookies.ts](../src/domain/cookies.ts) |
| Env vars | [src/server/config.ts](../src/server/config.ts) and [.env.example](../.env.example) |

### Tests that prove each module

| Module | Test file |
|---|---|
| sanitize, prepop | [tests/unit/prepop.test.ts](../tests/unit/prepop.test.ts) |
| fields, lead-schema | [tests/unit/fields.test.ts](../tests/unit/fields.test.ts) |
| variant | [tests/unit/variant.test.ts](../tests/unit/variant.test.ts) |
| tracking, steps, bots | [tests/unit/tracking-steps.test.ts](../tests/unit/tracking-steps.test.ts) |
| seal, logger | [tests/unit/security.test.ts](../tests/unit/security.test.ts) |
| submitLead (DB) | [tests/integration/leads.test.ts](../tests/integration/leads.test.ts) |
| outbox, sweep (DB + fake partner) | [tests/integration/delivery.test.ts](../tests/integration/delivery.test.ts) |
| Full browser journeys | [tests/e2e/funnel.spec.ts](../tests/e2e/funnel.spec.ts) |
