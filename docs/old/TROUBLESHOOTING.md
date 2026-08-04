# Troubleshooting

## Bun + HTTPS tunnel: SSL certificate verification error

When using Bun to access Modal's HTTPS tunnel endpoints (`*.r443.modal.host`), you may encounter:

```
error: unknown certificate verification error
  code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"
```

### Cause

Bun uses its own TLS stack (BoringSSL) which does not read the Windows certificate store. This means Bun may fail to verify certificates that Node.js handles without issues.

`NODE_TLS_REJECT_UNAUTHORIZED=0` does **not** work reliably with Bun.

### Solutions

#### 1. Use `unencryptedPorts` (recommended)

If you control the Sandbox, use unencrypted (HTTP) tunnels instead of HTTPS. This avoids TLS entirely:

```typescript
const sandbox = await modal.sandboxes.create(app, image, {
  unencryptedPorts: [8080],
});

const tunnels = await sandbox.tunnels();
const [host, port] = tunnels[8080].tcpSocket;
const url = `http://${host}:${port}`; // No TLS, no certificate issues
```

#### 2. Set `NODE_EXTRA_CA_CERTS` (Bun v1.1.22+)

Export your system's root certificates to a PEM file and point Bun to it:

**Windows (PowerShell 7+):**

```bash
mkdir -p ~/.ssl
pwsh -Command "Get-ChildItem -Path Cert:\LocalMachine\Root | ForEach-Object { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String(\$_.RawData, 'InsertLineBreaks'); '-----END CERTIFICATE-----' }" > ~/.ssl/cacerts.pem
export NODE_EXTRA_CA_CERTS="$HOME/.ssl/cacerts.pem"
```

**macOS/Linux:**

```bash
# macOS
export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem

# Debian/Ubuntu
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
```

#### 3. Use Node.js instead of Bun

Node.js reads the system certificate store natively:

```bash
npx tsx your-script.ts
```

### References

- [Bun TLS docs](https://bun.com/docs/runtime/http/tls)
- [Bun #7200 - Error verifying HTTPS certificates](https://github.com/oven-sh/bun/issues/7200)
- [Bun #23735 - Regression: system CA certificates not used](https://github.com/oven-sh/bun/issues/23735)
- [Bun #13867 - NODE_EXTRA_CA_CERTS bundle PEM issue](https://github.com/oven-sh/bun/issues/13867)
