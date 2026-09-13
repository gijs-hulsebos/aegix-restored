# Hosted deployment

## Vercel frontend
- Root: packages/dashboard; preset: Next.js; build: npm run build; output/install: automatic.
- Include source files outside the root directory.
- `/` and `/landing` show the landing page; `/dashboard` opens the app.
- Server environment: HELIUS_API_KEY. Explicit AEGIX_DEVNET_RPC / AEGIX_MAINNET_RPC URLs override it.
- Set AEGIX_DEVNET_GATEWAY_URL, AEGIX_MAINNET_GATEWAY_URL and AEGIX_DEMO_GATEWAY_URL to your hosted services' HTTPS base URLs. These are NOT RPC URLs.
- Missing hosted gateways return a configuration error. Importing this repository into Vercel does not deploy the gateway processes.

## Payment server
Run one persistent Node service per network, with a separate persistent volume and stable secrets. Keep one instance per network: sessions and concurrency controls currently live in process memory.

From the repository root:
```
npm ci
npm run build --workspace=@aegix/gateway
npm run start --workspace=@aegix/gateway
```

Set HOST=0.0.0.0 and PORT to the host's assigned port. Set AEGIX_MODE to devnet or mainnet, HELIUS_API_KEY, AEGIX_USE_PAYAI=true and AEGIX_DATA_DIR to the persistent mount path. Set AEGIX_STORAGE_KEY, SESSION_KEY_SECRET and INCO_BYTES_KEY to stable 32-byte hex secrets (64 hex characters each), separate per network. Generate each with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

For demo, use AEGIX_MODE=demo; it requires no wallet or RPC credentials. Demo state is temporary.

The optional Dockerfile.gateway builds the gateway from repository root; mount your persistent disk at the configured AEGIX_DATA_DIR. Put a TLS reverse proxy in front of the service. Configure the three resulting URLs on Vercel, then redeploy the frontend.

Do not migrate old encrypted wallet files without their matching storage keys. Do not use disposable filesystem storage or multiple independently writing replicas for wallet data.

Verification: node scripts/test-hosting.cjs. Mainnet payment verification still requires a configured, funded backend; a successful frontend build alone does not establish that payments work.
