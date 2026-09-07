# Data Encryption and Privacy Plan

Status: Proposed  
Scope: Orion hosted product  
Last updated: 2026-09-06

## Objective

Protect customer data in transit and at rest while preserving Orion's hosted transcription, AI summarization, semantic search, calendar synchronization, and cross-device features.

This plan establishes five required controls:

1. Encrypt and authenticate all production network traffic.
2. Encrypt sensitive database content with KMS-backed, per-account envelope encryption.
3. Encrypt attachments before storing them in a private Backblaze B2 bucket.
4. Treat embeddings and vector metadata as sensitive derived customer data.
5. Prevent plaintext customer data from leaking into temporary or secondary systems.

This is server-readable encryption, not end-to-end encryption. The Orion backend may decrypt authorized content briefly to provide product features. Orion must not market this design as zero-knowledge or end-to-end encrypted.

## Privacy and threat model

The design should protect against:

- Network interception and server impersonation.
- A leaked Postgres database or database backup.
- Unauthorized access to the B2 bucket or copied objects.
- Accidental disclosure through logs, queues, caches, traces, and exports.
- A database operator who has database access but no access to the production key service.
- Cross-account ciphertext substitution or replay.

The design does not protect plaintext from:

- A compromised, running Orion backend that is authorized to use the key service.
- A person or workload with both production application access and KMS decrypt permission.
- Third-party processors that intentionally receive plaintext for a requested feature, such as transcription or AI generation.
- The user's own unlocked device.

These residual risks must be reduced through least privilege, short-lived credentials, access auditing, deployment separation, vendor controls, and data minimization.

## Existing foundations

Orion already has several relevant controls:

- Electron main owns the Supabase session and persists it with Electron `safeStorage` when secure OS-backed storage is available.
- Local recording drafts use `safeStorage` and remain memory-only when secure persistence is unavailable.
- Calendar provider access and refresh tokens are encrypted with versioned AES-256-GCM keys before database storage.
- The Go backend connects as the dedicated, least-privilege `orion_backend` database role and verifies its effective role during startup.
- Application data is accessed through the Go backend rather than directly from the Electron renderer.

The existing token encryption code is a useful pattern, but general customer-content encryption should use per-account data-encryption keys protected by a managed KMS instead of a single application keyring stored directly in environment variables.

## Target architecture

```text
Electron application
    |
    | HTTPS / WSS with certificate validation
    v
Orion Go backend
    |
    |-- authorized, short-lived KMS unwrap
    |       `-- per-account data-encryption key
    |
    |-- TLS + ciphertext ----------> Supabase Postgres
    |-- TLS + encrypted objects ---> private Backblaze B2
    |-- TLS + minimal envelopes ---> Redis
    |-- TLS + scoped plaintext ----> Deepgram / OpenAI
    `-- TLS + isolated vectors ----> Pinecone
```

Plaintext should exist only on the user's unlocked device, in the authorized backend operation that needs it, and in an explicitly selected processor request. It must not be persisted incidentally.

## 1. Encryption in transit

### Required controls

- Serve every production API and web route over HTTPS only.
- Use WSS for general and transcription WebSockets.
- Reject plaintext production origins and callback URLs during configuration validation.
- Enable HSTS on production web and API hosts after confirming all subdomains support HTTPS.
- Keep normal platform certificate validation enabled for every outbound integration. Never use insecure TLS verification bypasses.
- Use TLS for Redis and any other managed queue or cache connection.
- Require HTTPS for Backblaze B2, Pinecone, OpenAI, Deepgram, Google, Microsoft, Stripe, and Supabase HTTP APIs.

### Supabase Postgres

- Enable Supabase Postgres SSL enforcement before production customer data is stored.
- Configure the backend database connection with `sslmode=verify-full`.
- Install and reference the Supabase database CA certificate through the deployment secret/configuration system.
- Fail backend startup if production database TLS is absent or cannot verify the server hostname.
- Consider Supabase network restrictions or PrivateLink when the production hosting topology provides stable egress or private networking.

Supabase notes that its HTTP APIs already enforce SSL, while direct and pooled Postgres connections require database SSL enforcement to prevent non-TLS clients. See [Postgres SSL Enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement) and [Network Restrictions](https://supabase.com/docs/guides/platform/network-restrictions).

### Acceptance criteria

- No production service URL uses `http://`, `ws://`, or plaintext Redis/Postgres transport.
- The backend refuses to start with a production Postgres connection that does not use full certificate and hostname verification.
- Supabase reports that database SSL enforcement is enabled.
- Deployment configuration contains no TLS verification bypass.

## 2. KMS-backed envelope encryption for database content

### Key hierarchy

Use the following key hierarchy:

- **KMS key-encryption key (KEK):** managed by the deployment provider's KMS or HSM. It never enters the database or source-controlled configuration.
- **Account data-encryption key (DEK):** a random 256-bit key generated independently for each Orion account.
- **Record encryption:** sensitive record payloads are encrypted with the account DEK using AES-256-GCM and a fresh cryptographically random nonce for every encryption.

Store only the wrapped DEK and non-secret key metadata in Postgres. A proposed account-key record needs, at minimum:

- `account_id`
- `key_version`
- `encrypted_dek`
- `kms_key_id`
- `algorithm`
- `created_at`
- `retired_at`

The account-key table must not be exposed through the Supabase Data API. Access should be limited to the backend role and necessary migration/administrative roles. RLS and least-privilege grants remain required defense in depth; encryption does not replace authorization.

### Ciphertext format

Use an explicitly versioned envelope rather than an unlabelled base64 string. The serialized value should contain:

- Envelope format version
- Encryption algorithm
- Account key version
- Nonce
- Ciphertext and authentication tag

Bind every encryption operation to its context with AES-GCM additional authenticated data (AAD):

```text
account_id | table | column-or-payload | record_id | envelope_version
```

AAD is not secret. It prevents valid ciphertext from being silently copied to a different account, record, or field.

### Content boundaries

Prefer encrypting a small number of versioned content payloads over independently encrypting every column. Keep only fields needed for ownership, lifecycle, integrity, joins, and high-value indexes outside the encrypted payload.

Encrypt first:

- Note titles, Markdown, transcripts, transcript segments, summaries, and extracted insights.
- Conversation titles, summaries, messages, tool content, and stored model reasoning if retained.
- Calendar titles, descriptions, locations, meeting links, organizer/attendee details, and snapshots.
- User vocabulary, extraction prompts, summary templates, and email-draft prompts.
- Attachment names and other user-supplied attachment metadata where operationally practical.
- Provider credentials, continuing the existing OAuth token protection.

Fields that may remain plaintext initially include:

- Record and account identifiers.
- Ownership foreign keys.
- Creation, update, deletion, and revision values.
- State and lifecycle flags.
- Billing identifiers and non-content accounting values.
- Calendar start/end values when required for indexed range queries.
- File sizes and non-user-supplied MIME classifications when required operationally.

Plaintext metadata still reveals information. Every exception must be documented, minimized, and reconsidered when query requirements change.

### Search and lookup implications

Randomized authenticated encryption intentionally prevents equality matching, sorting, and full-text search over ciphertext. Do not replace it with deterministic encryption merely to preserve a query.

When an exact lookup is essential, use a narrowly scoped keyed HMAC blind index with a separate derived key and normalized input. Blind indexes reveal equality patterns and therefore require an explicit privacy review. General note search should use authorized backend decryption for bounded result sets or the separately controlled semantic-search design.

### Key access and caching

- Only the production backend workload identity receives KMS decrypt permission.
- Developers, database roles, build jobs, and client applications do not receive decrypt permission.
- Separate development, staging, and production KMS keys and identities.
- Cache unwrapped DEKs only in backend memory for a short bounded period; never write them to disk, Redis, logs, traces, or crash reports.
- Clear or naturally expire cached keys during account deletion, key retirement, and process shutdown.
- Rate-limit and audit unwrap operations to make unusual bulk decryption detectable.

### Rotation and recovery

Support two independent rotations:

- **KEK rotation:** rewrap stored account DEKs without decrypting and rewriting all customer content when the KMS supports it.
- **DEK rotation:** create a new account key version for new writes and migrate older ciphertext in bounded, restartable batches.

Old DEKs must remain available until all referenced ciphertext, retained backups, and recovery obligations have expired. Losing a DEK permanently loses the associated customer data, so encrypted backup and disaster-recovery procedures must be exercised before rollout.

### Acceptance criteria

- A raw database dump does not reveal protected customer content.
- Swapping ciphertext between accounts, records, or protected fields fails authentication.
- Production can rotate the KEK without rewriting all content.
- A DEK rotation can resume safely and reports remaining ciphertext by key version.
- Database-only access is insufficient to decrypt customer content.
- KMS decrypt operations are attributable to the production backend identity and auditable.

## 3. Encrypted private attachment storage

### Upload path

The backend should:

1. Authenticate the user and verify note ownership.
2. Generate a fresh random file DEK for the attachment.
3. Stream-encrypt the file with an authenticated streaming construction suitable for large objects.
4. Wrap the file DEK with the account DEK or directly through KMS, recording its version.
5. Upload only ciphertext to a private B2 bucket.
6. Persist the object locator, encryption metadata, ciphertext size, and integrity information in Postgres.

Do not buffer an entire attachment in memory solely to encrypt it. Define a versioned chunk format with unique nonces and authenticated chunk ordering so truncation, reordering, and substitution are detected.

### Download path

The backend should:

1. Authenticate the requester and authorize access to the note and attachment.
2. Fetch the encrypted object from B2.
3. Unwrap the required file/account key.
4. Authenticate and stream-decrypt the object to the requester.
5. Avoid writing plaintext temporary files.

The current attachment model includes a `public_url`. Private customer attachments must not depend on permanent public URLs. Prefer an authenticated Orion download endpoint. Any temporary URL must address ciphertext only, be short-lived, and require client-side decryption before it can safely bypass the backend.

### Operational controls

- Disable anonymous/public bucket access.
- Use a narrowly scoped B2 application key restricted to the production bucket and required operations.
- Separate production objects from development and staging.
- Ensure incomplete multipart uploads and replaced object versions follow a bounded lifecycle policy.
- Delete both the object and its encryption metadata during attachment/account deletion.
- Do not log filenames, download URLs, object authorization tokens, or plaintext hashes.

### Acceptance criteria

- Direct B2 access returns no readable customer attachment.
- The application can upload and download large files without plaintext temporary files or unbounded memory use.
- Modified, truncated, reordered, or cross-account attachment ciphertext is rejected.
- Deleted attachments are removed from active storage and covered by the documented provider retention lifecycle.

## 4. Sensitive embeddings and vector data

Embeddings are derived customer data and can reveal semantic information even when the original text is not stored beside them. Normal field encryption cannot protect a vector while preserving ordinary similarity search.

### Required controls

- Send only the smallest useful text chunks for embedding.
- Remove unnecessary names, email addresses, external IDs, and other direct identifiers before embedding when doing so does not damage the feature.
- Keep vector metadata minimal. Do not store raw note content, transcript text, filenames, attendee lists, or prompts in Pinecone metadata.
- Isolate data by account namespace and enforce account filters in backend-owned code on every query and mutation.
- Use opaque Orion identifiers rather than user emails or names.
- Never allow a client-supplied account/namespace value to override the authenticated principal.
- Delete vectors when a source record, note, or account is deleted, and reconcile orphaned vectors periodically.
- Document the vector provider as a data processor, including region, retention, subprocessors, and deletion behavior.
- Do not log embedding inputs or returned vectors.

For customers who require a tighter trust boundary, evaluate a controlled Postgres/pgvector or private enterprise deployment. This is a future product option and does not make the hosted design end-to-end encrypted.

### Acceptance criteria

- Pinecone metadata contains no raw customer content or direct identity fields.
- Cross-account vector searches fail even when a caller supplies another account's identifiers.
- Source deletion reliably removes associated vectors and can be reconciled.
- The privacy documentation accurately describes that embedding inputs and vectors are processed outside Orion's primary database.

## 5. Plaintext control in temporary and secondary systems

### Logging, tracing, and errors

- Do not log request/response bodies containing notes, transcripts, messages, prompts, calendar descriptions, tokens, or attachment names.
- Use structured allowlists for observable fields instead of attempting to redact arbitrary payloads after logging.
- Scrub authorization headers, cookies, database URLs, signed URLs, OAuth codes, and KMS responses.
- Configure error reporting and tracing integrations not to capture sensitive bodies, local variables, or decrypted payloads.
- Use opaque record and request identifiers for debugging.

### Redis, queues, WebSockets, and caches

- Put identifiers and versioned invalidation events in Redis rather than resource content.
- For jobs that genuinely require content, store an encrypted reference or an authenticated ciphertext envelope, not plaintext.
- Use TLS, authentication, least-privilege credentials, bounded TTLs, and environment separation.
- Do not put unwrapped keys in queues or caches.
- Keep WebSocket events content-minimal; clients should retrieve authorized content through the normal API where practical.

### AI and transcription processors

- Send only content required for the user-requested operation.
- Keep system prompts and context bounded; do not attach unrelated notes or full account history.
- Avoid direct identifiers unless the feature requires them.
- Use provider configurations and contracts appropriate for customer data, retention, and model-training restrictions.
- Record which processor handled an operation without recording its plaintext input.
- Make processor use and unavoidable plaintext disclosure clear in Orion's privacy documentation.

### Backups, exports, and support access

- Ensure protected database fields and B2 objects remain ciphertext in backups.
- Encrypt any operator-created exports separately and give them explicit expiration and deletion ownership.
- Never use production customer content in development, staging, demos, fixtures, or support reproductions.
- Require audited, time-bounded production access for exceptional support operations.
- Define deletion behavior across Postgres, B2, Pinecone, Redis, backups, analytics, and processor retention windows.

### Acceptance criteria

- A review of production log schemas finds no customer-content fields or secrets.
- Redis inspection reveals no plaintext note, transcript, message, calendar description, or attachment content.
- Queue retries and dead-letter handling preserve ciphertext and deletion behavior.
- Account deletion has a documented outcome and maximum retention window for every data processor and backup class.

## Data classification summary

| Data class | Examples | Storage requirement | Processing rule |
| --- | --- | --- | --- |
| Secrets | OAuth tokens, session refresh tokens, database credentials, KMS material | OS secure storage, secret manager, or authenticated application encryption | Never expose to renderers, logs, analytics, or general database users |
| Customer content | Notes, transcripts, messages, summaries, prompts, calendar descriptions | Per-account envelope encryption | Decrypt only for an authorized request and only for its duration |
| Attachments | Documents, images, recordings | Stream-encrypted private object storage | Authorize before upload/download and never create public plaintext URLs |
| Sensitive derived data | Embeddings, extracted insights, model context | Isolated provider storage or encrypted database storage as applicable | Minimize, tenant-isolate, delete with the source, and disclose processor use |
| Operational metadata | IDs, timestamps, revisions, states, required query fields | Provider at-rest encryption plus strict authorization | Keep minimal and never treat it as anonymous by default |
| Observability data | Request IDs, metrics, error categories | Access-controlled monitoring storage | Use an explicit allowlist and exclude customer content and secrets |

## Rollout plan

### Phase 0: inventory and decisions

- Assign an owner for security architecture and key operations.
- Inventory every customer-data flow across Electron, Go, Postgres, B2, Redis, Pinecone, OpenAI, Deepgram, logs, analytics, and backups.
- Classify every persisted field and outbound processor payload.
- Choose the production KMS based on the backend deployment environment.
- Define recovery, retention, deletion, incident response, and privacy-policy requirements.
- Create metrics that count encryption versions and migration progress without exposing plaintext.

### Phase 1: transport enforcement

- Add production configuration validation for HTTPS/WSS/TLS endpoints.
- Enable Supabase database SSL enforcement.
- Configure and verify Postgres `sslmode=verify-full` with the Supabase CA.
- Require TLS for Redis and verify all outbound clients retain certificate validation.
- Apply network restrictions or private networking where deployment topology permits.

### Phase 2: encryption foundation

- Introduce a backend encryption package with versioned envelopes, AAD, and a KMS abstraction.
- Add the private account-key registry through Orion's Supabase migration workflow.
- Provision separate environment KEKs and a production workload identity.
- Add bounded in-memory DEK caching, KMS audit visibility, and operational failure handling.
- Document key loss, KMS outage, rotation, backup, and restore procedures.

### Phase 3: database content migration

- Encrypt new writes for one bounded content domain at a time.
- Support dual-read during each migration: accept legacy plaintext and new ciphertext, but write only ciphertext.
- Backfill existing rows in restartable, rate-limited batches.
- Measure migration completeness by envelope/key version.
- Remove plaintext read compatibility only after every active and retained record is accounted for.
- Start with notes/transcripts and conversations/messages, then calendar content and user-authored configuration.

### Phase 4: attachment migration

- Make the B2 bucket private and introduce the encrypted streaming object format.
- Route new uploads and downloads through authenticated encrypted paths.
- Migrate existing objects and verify ciphertext integrity before retiring plaintext copies.
- Remove permanent public plaintext URLs from the data model and application flows.

### Phase 5: secondary-system hardening

- Minimize Pinecone inputs and metadata and verify account isolation.
- Audit Redis payloads, background jobs, WebSocket events, logs, traces, analytics, and errors.
- Implement cross-system deletion reconciliation.
- Update privacy documentation and processor disclosures.

### Phase 6: operational readiness

- Exercise KEK rotation, DEK rotation, encrypted backup restore, KMS outage behavior, and account deletion in a non-production environment.
- Review KMS policies and production access with least privilege.
- Confirm alerts for unusual unwrap volume, decryption failures, plaintext migration regressions, and deletion reconciliation failures.
- Complete the deferred Supabase platform upgrade before storing real customer data.

## Failure behavior

- If KMS is unavailable, do not fall back to plaintext reads or writes. Return a temporary service error and preserve ciphertext.
- If ciphertext authentication fails, do not return partial data. Record only an opaque error with record ID, envelope version, and key version.
- If an encryption migration cannot encrypt a record, leave the source intact, record non-sensitive retry state, and retry safely.
- If encrypted attachment upload is incomplete, remove or expire the incomplete ciphertext object without publishing an attachment record.
- If downstream AI, transcription, or vector processing fails, do not retain extra plaintext for easier retries; retry from the encrypted source through the normal authorized path.

## Security invariants

- No renderer, web client, database user, queue worker without an explicit need, or third-party integration receives an account DEK.
- No protected write falls back to plaintext.
- Nonces are never reused with the same encryption key.
- Ciphertext is authenticated and bound to its account, record, and purpose.
- Authorization happens before decryption and before producing signed or streamed downloads.
- Decrypted customer content is never intentionally logged or persisted in temporary files.
- Database and object-store access alone cannot reveal protected customer content.
- Deleting source content also schedules deletion of attachments, vectors, caches, jobs, and derived content.
- Product and privacy claims distinguish encryption at rest from end-to-end encryption.

## Out of scope

- Full end-to-end or zero-knowledge encryption.
- Client-only key recovery and multi-device E2EE key synchronization.
- Searchable encryption over arbitrary note content.
- Local-only transcription, embeddings, and AI inference.
- Selecting a specific KMS vendor before the production compute environment is finalized.

These may become a separate privacy or enterprise mode later. They should not block the server-readable encryption baseline in this plan.

## References

- [Supabase secure product configuration](https://supabase.com/docs/guides/security/product-security)
- [Supabase Postgres SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Supabase network restrictions](https://supabase.com/docs/guides/platform/network-restrictions)
- [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod)
- [NIST SP 800-38D: Galois/Counter Mode](https://csrc.nist.gov/pubs/sp/800/38/d/final)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
