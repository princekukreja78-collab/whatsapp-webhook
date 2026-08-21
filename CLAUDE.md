# Mr. Car / VehYra — working notes

Read this before touching anything here. It exists so none of it has to be
re-explained.

## What this is

**Mr. Car** is a pre-owned car dealership in Ashok Vihar, Delhi (Prince's second
business alongside GrehYug — unrelated codebases, don't mix them up).
**VehYra** is the customer-facing brand: a WhatsApp bot and a website that price
cars, quote EMI, and list the dealership's stock.

Two halves, one inventory:

| | |
|---|---|
| **Bot** | this repo — Node/Express, WhatsApp Cloud API, deployed on Render |
| **Site** | `~/vehyra-frontend` — Next.js on Vercel, serves `vehyra.in` |
| **Studio** | admin UI for the inventory, served two ways (see below) |

## Live services

- **Backend**: `whatsapp-gpt-bot-wp63.onrender.com` — Starter instance, persistent
  disk at `/var/data/inventory` (+ `/var/data/inventory-media`). Deploys from
  `origin/main` on push. **This is the only backend that matters.**
- **Site**: `vehyra.in` (Vercel, repo `vehyra-frontend`, deploys from `main`).
  `MR_CAR_API` points it at the backend above.
- **`whatsapp-gpt-crm.onrender.com`** — a stale service on January code. Ignore it.
- Studio is served **twice**: `vehyra.in/studio` (hosted, from `public/studio.*`
  in this repo) and `~/Desktop/mr-car-dashboard` (local copy with a backend
  picker). **Patch both** when changing Studio.

## WhatsApp

WABA `841729318418120` ("Mr car"), two numbers:

| Number | ID | Role |
|---|---|---|
| +91 99999 48844 | `954494841079169` | the live bot — customers, intake, quotes |
| +91 99587 45638 | `788100031061238` | broadcast / dealer alerts |

- `webhook.cjs` drops any message whose `phone_number_id` isn't its own or in
  `ALT_PHONE_NUMBER_IDS`. Replies leave through the number the message arrived on
  (`whatsapp.cjs` keeps it in an AsyncLocalStorage).
- `BROADCAST_PHONE_NUMBER_ID` restricts that number to opt-outs and hand-offs;
  deal admins are exempt.
- ⚠️ **Two apps are subscribed to this WABA** — `MR CAR AV` (ours) and `vehyra`.
  Meta delivers to both, so every message is answered twice until the `vehyra`
  app is unsubscribed from its own dashboard. Not fixable from our side.
- Display name is "Pristhi"; a change to "VehYra" has been pending review since
  mid-August and blocks any other name request.

## Inventory model

- Store: `data/inventory.json` (`INVENTORY_DATA_DIR` on Render), photos under
  `media_store/inventory/<carId>/`.
- A car is `draft` until published; only `status === 'live'` reaches customers.
- IDs are `MC-####`, continuing past **both** the stored counter and the highest
  id on disk — deleted ids are never reissued.
- `photo.private` marks paperwork (RC, price sheets). Filtered out of every
  customer surface through `publicPhotos(car)` — use it, never `car.photos`.
- **Creating a listing is refused unless the real store is loaded** — an
  unmounted disk used to look like an empty dealership and silently ate cars.
  Never `mkdirSync` the data dir when `INVENTORY_DATA_DIR` is set.

## Two logins

- `INVENTORY_ADMIN_TOKEN` — owner, everything.
- `INVENTORY_STAFF_TOKEN` — staff: add cars, fix details on drafts **and** live
  listings. Refused: price, status, type, deal, trade price, consignment, loan
  schemes, deleting. The check compares **values, not key presence** — Studio
  sends the whole car back on every save.

## Gotchas that cost real time

- **A button tap arrives as its title in `msgText`.** "Yes, Compare" went
  through the intent engine, which cleared the quote context and answered it as
  a two-car comparison. Our own button ids blank `msgText` now.
- **`trySmartNewCarIntent` runs ~175 lines before the button handler** and will
  eat anything it recognises. Intercept early or list the wording in its
  `btnTitles`.
- **Verifying a client-rendered Next page**: grep the deployed JS chunks, not
  the HTML — anything rendered after a fetch is never in the server response.
- **Verifying a Render deploy**: poll `GET /api/inventory/storage` with the
  admin token; `uptimeMin` resets and `pid` changes. It also reports
  `storeReady`, `nextId`, disk usage and whether the sheet webhook is set.
- **`GET /api/inventory/intake`** (admin) shows the last 30 intake events,
  batches still collecting, and who owes details. Use it instead of asking for
  screenshots.
- Don't `--build` docker images repeatedly — ten rebuilds left 39 dangling
  1.29 GB images and filled the disk. Local staging is `3011`, prod `3002`;
  `3001` belongs to the GrehYug dev server.

## Conventions

- Commit messages: what changed and **why it was wrong before**, in prose. No
  bullet-list-of-files.
- Never auto-post to social; never automate Prince's personal WhatsApp.
- Never expose vendor or infrastructure names on customer-facing surfaces —
  photos and the staff tool go through `vehyra.in`, never the Render host.
- Prices, publishing and anything that moves money stay owner-only.

## Open

- `vehyra` app still subscribed to the WABA → double replies.
- Display-name change stuck in review.
- Disk is 1 GB; ~7.7 MB per car, so ~100 cars needs it raised (Prince's call:
  buy disk rather than downscale photos).
- No tests anywhere. Every bug so far was found by Prince using the product.
