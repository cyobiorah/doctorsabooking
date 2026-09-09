# Doctorsa — visit booking

A small server-rendered doctor marketplace: a patient requests care in a service area, matching doctors bid, the patient chooses a doctor, and an authenticated mock payment webhook assigns the visit.

## Run

Install Docker with Compose and start its engine, then run from this directory:

```sh
docker compose up
```

Open [the booking application](http://localhost:3000). The mock checkout runs at [localhost:3001](http://localhost:3001). The first start downloads images, builds TypeScript, migrates the databases, and creates demo users. No local Node.js, MySQL, environment file, or payment keys are required. Subsequent source changes require `docker compose up --build`.

| Role    | Email               | Password     |
| ------- | ------------------- | ------------ |
| Patient | patient@demo.local  | DemoPass123! |
| Patient | patient2@demo.local | DemoPass123! |
| Patient | patient3@demo.local | DemoPass123! |
| Patient | patient4@demo.local | DemoPass123! |
| Patient | patient5@demo.local | DemoPass123! |
| Doctor  | doctor1@demo.local  | DemoPass123! |
| Doctor  | doctor2@demo.local  | DemoPass123! |
| Doctor  | doctor3@demo.local  | DemoPass123! |

### Try the flow

1. Sign in as the patient and request a future visit in one of the catalogued service areas. Time entry and display are explicitly UTC.
2. In another browser profile/private window, sign in as a doctor, choose your service areas from **Service areas**, and submit a price and note for a matching request. Optionally bid as the second doctor.
3. As the patient, open the visit and choose **Select bid & pay**. The selection is now locked.
4. Choose **Simulate decline** at checkout. Return to the visit: it remains `bidding`, the attempt is declined, and every existing bid is selectable again.
5. Choose **Continue / retry payment** for the original doctor, or select a different bid such as Dr. Morgan. The newly selected doctor and price lock while checkout is pending.
6. Choose **Approve payment** on the checkout. Return to see `assigned` and the selected doctor.
7. Click **Resend confirmation** at checkout multiple times. The assignment and lifecycle history remain unchanged.
8. Sign in as the winning doctor to view the assigned visit.

If callback delivery fails, the checkout retains the outcome and offers resend. If payment-service creation fails, retry from the visit; the stored attempt identifier is reused. Checkout links contain random bearer tokens and should be treated as private.

### Tests

```sh
docker compose --profile test run --build --rm test
```

Tests migrate and use a separate, ephemeral `doctorsa_test` MySQL database. A safety guard refuses to run against the demo database. Tests cover the complete lifecycle; duplicate and concurrent webhooks; repeated and competing checkout submissions; decline and retry; conflicting terminal outcomes; invalid callbacks; ownership and role checks; CSRF and SSR login/logout; and rollback after writes followed by successful redelivery. The mock delivery test injects a network failure; transaction tests use actual MySQL, not mocked Prisma calls.

Stop services with `docker compose down`. Data and generated local secrets persist in named volumes. `docker compose down --volumes` **deletes demo data and secrets** and resets the exercise. Test-only services can be stopped with `docker compose --profile test down`.

## Verification performed

- Docker images built successfully; initial migrations, generated secrets, seed accounts and service health checks verified.
- All 18 Jest/Supertest tests passed against MySQL.
- Browser walkthrough completed: patient request, doctor bid, declined checkout, retry, successful webhook, duplicate resend, and assigned doctor dashboard.
- Strict TypeScript compilation and Prisma schema validation passed. Production dependency audit reported zero known vulnerabilities at verification time.

## Architecture and decisions

- **Node.js 22, strict TypeScript, Express 5:** a small HTTP layer, explicit validation and business services; no framework-specific dependency injection or generic repository abstraction.
- **EJS and plain CSS:** the server fetches data and renders HTML. Standard forms submit to Express and redirect to GET pages. Templates display data; the booking and location-matching rules live in TypeScript. Escaped EJS output is used for user data.
- **Prisma 6 and MySQL 8.4 / InnoDB:** Prisma API (with a patched `deepmerge-ts` tooling override), typed queries, checked-in SQL migrations, foreign keys and transactions. Money uses integer minor units in USD. The bid is immutable, so it remains the source of the selected doctor's identity and price; each attempt stores its original bid, expected amount, and currency.
- **Database sessions:** a small express-session store backed by Prisma, with expiration checks and hourly cleanup. Passwords are bcrypt hashed. Login regenerates the session; cookies are HttpOnly and SameSite=Lax. Synchronizer tokens protect forms. Set `COOKIE_SECURE=true` when serving through HTTPS; the local demo uses HTTP.
- **Separate mock service:** service-to-service requests authenticate using a generated shared secret. The callback URL is configured by the service, never supplied by the browser. The mock persists its outcome before sending the callback, and its creation endpoint is idempotent by attempt ID.
- **Database isolation:** the mock has its own MySQL container and persistent volume, making the simulated provider independent of the application's tables and transactions. Both use the same schema migration for a small build pipeline, although each service only uses its relevant tables. This costs an extra MySQL process; a shared server with separate schemas/users would be a leaner deployment.
- **Docker secrets for the demo:** a one-shot container generates random database, session, and payment secrets into a named volume. None are committed. Root database access and shared volume access simplify local provisioning; production would use scoped database accounts and managed secrets.
- **Location matching:** active service areas live in a shared `Location` catalog. Doctors select at least one through `/settings/locations`; open requests are visible and bid-able only when the doctor covers the request's location. A visit keeps the catalog ID plus a display-name snapshot, and an inactive legacy location preserves historical records from before the catalog existed.

### Lifecycle and concurrency

```text
Visit:    open → bidding → paid → assigned
Attempt:  pending → succeeded | declined
```

The first bid moves a visit to `bidding`. Selection is represented by `selectedBidId`, not another visit status. A pending attempt locks the selection. A confirmed decline clears the selection and reopens bidding, while preserving all bids and payment history; the patient can retry the original doctor or choose another bid. Cancellation and changing the selected doctor during checkout are deliberately not supported.

All booking mutations acquire `SELECT ... FOR UPDATE` on the visit before changing bids, selection, payments or assignment. Concurrent operations for that visit serialize. Transactions use READ COMMITTED so reads after waiting for the lock see the preceding commit, including events and attempt outcomes. A nullable unique `pendingVisitId` additionally permits only one pending payment attempt per visit; final attempts release it. Unique `(visitId, doctorId)` prevents duplicate bids.

The webhook validates authentication, schema, attempt, original bid, amount and currency. Inside the visit-locked transaction it checks the unique event ID, records the event, finalizes the attempt, then either clears the matching selection on decline or applies a guarded `bidding → paid` update and assigns the selected doctor on success. Both `paid` and `assigned` history entries commit together. `paid` is therefore an auditable transition, not a separately visible UI state. A failure rolls back all effects, including event consumption, so delivery can be retried. Terminal and duplicate events are handled from the attempt's original bid before inspecting the visit's current selection, so a late event from an older declined attempt cannot clear a newer selection.

Repeated identical events return 200. Reusing an event ID with different data or attempting to reverse a final outcome returns 409. A new event ID reporting the same terminal outcome is recorded without repeating assignment. Database constraints back up service checks; authentication and ownership are enforced on the server, not just by hiding controls.

### Interfaces

| Endpoint                                              | Purpose                                     |
| ----------------------------------------------------- | ------------------------------------------- |
| `GET /login`, `POST /login`, `POST /logout`           | Session authentication                      |
| `GET /`, `GET /visits/new`, `GET /visits/:id`         | Role-aware SSR pages                        |
| `POST /visits`                                        | Patient creates a request                   |
| `GET /settings/locations`, `POST /settings/locations` | Doctor service-area management              |
| `POST /visits/:id/bids`                               | Doctor submits an immutable bid             |
| `POST /visits/:id/pay`                                | Owner selects a bid or retries its checkout |
| `POST /webhooks/payment`                              | Authenticated payment callback              |
| Mock: `POST /api/payments`                            | Authenticated idempotent checkout creation  |
| Mock: `GET/POST /checkout/:token`                     | Simulate outcome or resend it               |
| Both: `GET /health`                                   | Database readiness                          |

Callback JSON contains `eventId`, `attemptId`, `outcome` (`succeeded` or `declined`), `amount` (integer minor units), and `currency` (`USD`). Internal endpoints require `Authorization: Bearer <generated PAYMENT_SECRET>`. Browser routes require sessions and CSRF tokens for POSTs; checkout uses its high-entropy capability token for both access and form verification.

## Trade-offs

Kept the scope to location-aware booking correctness and a readable end-to-end demo. No registration, email, maps, specialty taxonomy, schedule matching, travel radius, scheduling conflicts, cancellation, refunds, bid editing, real payment SDK, pagination, automatic provider retries, or frontend framework. Patients may request an uncovered active location for demand discovery and receive an explicit warning; doctors cannot create free-form catalog locations. A decline reopens existing bidding so the patient can choose another submitted bid; the product still does not add a separate bid-rejection workflow. Failed delivery is retried manually through the mock checkout. Generic validation errors show an explanation and allow browser-back correction rather than maintaining a form-state framework. The mock outcome POST renders the result directly; refreshing it is safe because the terminal outcome and callback are idempotent.

The public demo has no login rate limiter, password recovery, or production deployment configuration. Local Docker uses root database credentials, includes development tooling for the test command, and binds HTTP ports only to localhost. Currency and timezone are deliberately fixed. Retries on transient database failures are caller driven; there is no background reconciliation worker.

## With more time

1. Add provider delivery retries with backoff and payment reconciliation, plus structured audit logs and alerts for pending attempts that remain unresolved.
2. Add production auth hardening, rate limits, scoped database credentials, HTTPS configuration, and a smaller non-root production image.
3. Add browser automation and richer field-level validation; introduce pagination and patient timezone handling.
4. Define cancellation, refunds, appointment conflicts and bid-selection expiry with product stakeholders before implementing them.

## Code map

- `src/services.ts`: validation, locks and booking transitions.
- `src/app.ts`: session-backed SSR routes and the webhook.
- `src/mock.ts`: independent mock checkout and callback delivery.
- `prisma/`: schema and migrations; `tests/`: MySQL integration tests.
- `views/` and `public/`: server-rendered interface and styling.

To discuss the implementation, start with `selectAndPay` and `confirmPayment`: why external HTTP calls happen outside the database transaction, why the visit lock comes first, and why webhook event recording must commit with assignment. Then trace a form through an Express route, a service, Prisma, and an EJS view.
