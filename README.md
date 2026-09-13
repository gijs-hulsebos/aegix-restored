# Aegix Restored

Restored original Aegix: a Solana payment gateway for AI agents, with the original dashboard and landing page, demo mode, devnet and mainnet configuration.

## Run locally

Requires Node.js 20 or newer and npm.

```sh
npm install
npm run local
```

Open http://127.0.0.1:3500/landing or the dashboard at http://127.0.0.1:3500/. The launcher starts separate demo, devnet and mainnet gateways. On first launch it creates an ignored `.env.local` with a random storage encryption key. Add `HELIUS_API_KEY=your-key` and `AEGIX_USE_PAYAI=true` to that file, preserving the generated storage key, then restart. Helius configures separate Solana/Light RPC endpoints for each network.

## Restoration status

The original compressed pool-to-burner-to-recipient flow and PayAI fee sponsorship were verified on devnet with a test token. Mainnet PayAI discovery was checked; an end-to-end mainnet PayAI payment was not verified by this restoration. Demo uses simulated data. The gateway includes wallet-signed authorization, encrypted local storage and request replay protection.

Burner wallets separate the immediate payment sender from the main wallet. Public funding paths, amounts and timing may still be correlated; ZK compression alone does not provide anonymity. Inco network attestations remain unverified. Additional historical routes require end-to-end validation.

## Local data

Wallets, API keys, recovery backups, `.env.local`, generated output and transaction data are intentionally excluded. Keep the storage key and encrypted data together in a private backup. This repository contains only Aegix; no video or Remotion project is included.
