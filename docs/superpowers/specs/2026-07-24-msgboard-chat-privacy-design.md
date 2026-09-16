# MsgBoard Chat & Privacy — design directions

Status: exploration / inspiration. Not a committed build plan yet. Seeded by a senior dev's notes
on a **privacy feedback platform** (an E2E-encrypted feedback/chat widget), mapped onto MsgBoard's
architecture to decide what's worth building for msgboard messaging (Channel / Whisper / encrypted
rooms / a widget).

---

## 1. The reference architecture (captured verbatim from the notes)

A zero-knowledge feedback system where no one — not even the server — can read submissions; only
admins with the right keys can decrypt.

**What it does.** Users submit bug reports / feature requests / feedback from any web app via an
embeddable widget: a message, optional screenshot, browser console logs, network traces. Everything
is E2E-encrypted in the browser before it leaves. Admins decrypt in a separate tracker app.

**How it works.**
1. **Key derivation** — the user signs a fixed message with their wallet; that signature is fed
   through **HKDF-SHA512** to deterministically derive a **Curve25519** keypair. Once per session;
   cached in SessionStorage, itself encrypted with a non-extractable AES-256-GCM key in IndexedDB.
2. **Encryption** — feedback is encrypted client-side with **NaCl secretbox (XSalsa20-Poly1305)**
   under a random 32-byte **data encryption key (DEK)**. The DEK is then **wrapped individually for
   each authorized recipient** (admins + the sender) using **X25519 ECDH + ChaCha20-Poly1305**. The
   server never sees plaintext or DEK.
3. **Proof of Work** — before submit, the client mines an **Argon2id** PoW (4 MB memory-hard,
   adaptive 10–14 bit difficulty), bound to the ciphertext + timestamp, with replay protection. No
   accounts, no CAPTCHAs.
4. **Storage** — the encrypted blob is pinned to **IPFS** (content-addressed, immutable); wrapped
   keys + metadata indices live in **Cloudflare KV**. Ciphertext and the keys that unlock it are in
   completely separate systems.
5. **Decryption** — an admin derives their own Curve25519 keypair from their wallet, fetches the
   wrapped key for their address, does ECDH to recover the DEK, decrypts.

**Privacy protections.** E2E (server is a dumb relay — a full DB breach yields nothing); no
accounts/emails (identity = wallet address, no PII server-side); client-side PII redaction of
logs/traces/URLs before encryption; **sender self-sovereignty** (revoke your own key → your
submission is permanently unreadable, even by admins — ciphertext lingers but is garbage without the
DEK); **per-submission forward secrecy** (fresh ephemeral keypair per DEK wrap — one submission's
keys reveal nothing about another); **separated storage** (IPFS content vs KV keys — one breach is
insufficient).

**Abuse protections.** Argon2id memory-hard adaptive PoW; PoW replay prevention (proof bound to
ciphertext + sender + timestamp, nonce hash in KV with 10-min TTL); per-sender sliding-window rate
limit on top of PoW; superadmin CRUD + real deletion (destroy keys + unpin IPFS).

---

## 2. Map onto MsgBoard — what we already have, what to adopt

| Their primitive | MsgBoard today | Verdict |
|---|---|---|
| Server as a dumb relay it can't read | **The board IS that** — a public, node-level PoW mempool; no app server to breach. Ciphertext in the message `data`. | We're *more* trustless: there's no Pinata/Cloudflare/KV to compromise. Adopt their E2E; drop their backend entirely. |
| **Wallet sign → HKDF → Curve25519 keypair** (deterministic, portable) | Whisper identity is a **random localStorage secret** — un-portable, no backup (the exact gap the user hit). | **ADOPT — this is the single best idea.** Deterministic key-from-signature makes identity restorable on any device by re-signing. Opt-in (links to a wallet). Fixes Whisper backup AND yields an encryption keypair. |
| Random DEK + secretbox for content; **DEK wrapped per recipient** via X25519 ECDH | Encrypted rooms in progress use ONE **shared room key** (MVP). | Shared key = the simplest form; **per-recipient DEK-wrap is the upgrade**: named recipients, DMs, revocation, per-message forward secrecy. Adopt the hybrid pattern as the next tier. |
| Argon2id memory-hard PoW bound to ciphertext + replay protection | **The board already PoW-gates every message natively** (secp256k1 challenge, ~1–2s via pow-grinder), rooted to a recent block hash (built-in freshness/replay window). | We get spam-resistance **for free at the transport layer** — no per-app Argon2id, no KV nonce store, no rate-limit service. Their whole abuse-protection section collapses into "post to the board." |
| IPFS pin + Cloudflare KV, separated storage | Board is **ephemeral (~120 blocks)**; durable history = the **archive** (cosign-archive / relayer sink). | For durable encrypted history, an **opt-in archive sink stores ciphertext** (the board/archive already can't read it — separation is inherent, keys never leave the client). No IPFS needed; the archive is the content-addressed store. |
| Sender self-sovereignty / revocation | none yet | Adopt with per-recipient wrapping: destroy your key → your messages are garbage; drop a recipient by re-keying forward. |
| Client-side PII redaction, embeddable widget | none yet | **Great product surface** — an embeddable msgboard chat/feedback widget (see §4). |
| No accounts, wallet = identity | msgboard needs **no wallet at all** to post (PoW is the toll); wallet is opt-in for key derivation. | We go further on approachability; wallet becomes a *choice* for portability/encryption, not a requirement. |

**The headline:** their design spends enormous effort rebuilding, at the app layer, things MsgBoard
provides at the protocol layer — a serverless relay that can't read content, and accountless PoW
spam-resistance. Swap their IPFS+KV+Cloudflare+Argon2id backend for "post to the board," and the
architecture gets *smaller* and more trustless while keeping every privacy property.

---

## 3. The crypto we should standardize on

- **Content encryption:** XChaCha20-Poly1305 (AEAD, 24-byte random nonce — safe for many writers
  under one key; already the choice for the shared-room-key MVP). Random 32-byte DEK per message or
  per room depending on tier.
- **Key agreement / DEK wrap:** X25519 ECDH → HKDF → ChaCha20-Poly1305, wrapping the DEK to each
  recipient's Curve25519 public key (the reference's exact scheme). Ephemeral sender key per message
  for per-message forward secrecy.
- **Identity keys:** two paths, user's choice —
  - *Portable (opt-in):* wallet `personal_sign` of a fixed domain-separated message → HKDF-SHA512 →
    Curve25519 keypair (+ the Semaphore identity secrets for Whisper). Restore anywhere by re-signing.
  - *Walletless (default today):* random secret in localStorage, exportable as the Base58Check
    recovery key we just shipped for Whisper.
  Both can coexist: the recovery key IS the backup for the walletless path; the wallet IS the backup
  for the portable path.
- **Libraries:** `@noble/ciphers` (xchacha/chacha) + `@noble/curves` (x25519) + `@noble/hashes`
  (hkdf/sha512) — audited, tiny, already in the tree via viem's deps. No NaCl/libsodium needed.

---

## 4. Inspired builds for MsgBoard chat (prioritized)

**Tier 0 — in flight / just shipped.**
- Public Channel (handle-identified) ✓; Whisper (ZK-anonymous, plaintext) ✓ with backupable
  Base58Check identity + proof inspector ✓; shared-room-key encrypted rooms (🔒 on Channel) — in
  progress.

**Tier 1 — adopt the two best ideas.**
- **Wallet-derived portable identity (opt-in).** `sign fixed message → HKDF → keypair`. One switch
  that turns Whisper's "gone if you clear your browser" into "restore on any device by re-signing,"
  and simultaneously mints the Curve25519 encryption key the next tiers need. Directly closes the
  identity-portability gap the user flagged.
- **Per-recipient encryption = real DMs + named-recipient rooms.** Random DEK + XChaCha content
  encryption, DEK wrapped to each recipient's X25519 pubkey. Gives: 1:1 DMs, small closed groups
  with a real membership (not "anyone with the link"), member revocation via forward re-keying, and
  per-message forward secrecy. This is the secure upgrade beyond the shared-room-key MVP.

**Tier 2 — the flagship product.**
- **An embeddable encrypted feedback/chat widget over MsgBoard.** Literally the reference platform,
  minus its backend: a drop-in `<script>` any site embeds. Feedback (message + optional
  screenshot/console/network, with client-side PII redaction) is E2E-encrypted to the site's admin
  X25519 keys, PoW-gated **by the board** (no Argon2id, no KV, no rate-limit service), delivered over
  msgboard (no server to breach), optionally archived as ciphertext. A separate tracker app decrypts.
  This is a complete, sellable use-case that showcases msgboard as *the* trustless transport — and it
  could itself become the "featured app" tab in the msgboard.xyz Try-it shell.

**Tier 3 — durability & self-sovereignty.**
- Opt-in encrypted archive (ciphertext only) for history beyond the ~120-block window, via the
  existing relayer/cosign-archive sink.
- Key revocation / self-destruct (destroy your key → your messages are unreadable), member
  drop-and-rekey.

**Explicitly NOT adopting:** Argon2id app-PoW, IPFS pinning, Cloudflare KV nonce store, per-app rate
limiters — MsgBoard's protocol-level PoW + ephemeral board already cover spam-resistance, replay
freshness, and "server can't read it," so these are redundant weight.

---

## 5. Open questions to settle before building Tier 1/2

1. Wallet-derived identity: which signature scheme + exact domain-separation string (must be stable
   forever — it defines everyone's keys). `personal_sign` vs EIP-712.
2. Recipient key **discovery**: how does a sender learn a recipient's X25519 pubkey? Options: publish
   pubkeys to a well-known board category (a keyserver-over-board), an on-chain registry, or
   out-of-band. This is the DM equivalent of Whisper's "group definition" problem.
3. Group re-keying policy for revocation (forward secrecy vs simplicity).
4. Does the widget's featured-app slot replace/augment the current Channel/Whisper/Mechanics tabs?
   (User has floated collapsing Channel+Whisper into one Chat tab with a public/anonymous/encrypted
   privacy toggle, freeing a slot for a featured app like Cosign or a game.)
