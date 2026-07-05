# Mobile Interaction Validation

Use this reference when the user needs to judge taps, forms, selects, dialogs, drag handles, auth callbacks, websocket behavior, or any other interaction through a phone-accessible URL.

## Principle

Verify the exact URL the phone will open. A localhost check proves the app can work locally; it does not prove the Tailscale, Tailscale Serve, or ngrok preview behaves the same way on mobile.

## Production Preview Preference

If the user needs to judge interaction behavior, prefer a production preview over a development server when the project supports it. For Next.js projects, prefer:

```bash
bun run build
bun run start -- -p <port> --hostname 0.0.0.0
```

Use development-server previews for quick visual checks only unless interaction has also been verified through the mobile URL.

Development runtimes can add HMR, overlays, websocket clients, or bundler behavior that differs through a tunnel from localhost. A dev tunnel can render the page while interaction state fails to update.

## Validation Checklist

1. Test the same control on localhost to distinguish app code from remote access behavior.
2. Test the final mobile URL, preferably with a mobile viewport.
3. For Tailscale direct, confirm the phone is connected, the peer is online, and the service listens on a reachable interface.
4. For Tailscale Serve, confirm the Serve URL resolves and that the config points to the intended local service.
5. For ngrok, check whether the user is still on ngrok's warning page and needs to tap `Visit Site`.
6. Report whether the issue was an app bug, a preview-runtime false negative, a tunnel/runtime issue, or a Tailscale reachability issue.

## Common Outcomes

| Symptom | Likely cause | Next step |
|---|---|---|
| Localhost works; Tailscale direct fails | Server listens only on loopback, firewall, or phone not connected to tailnet | Use Tailscale Serve or restart server with a reachable host |
| Page loads; interaction does nothing only through ngrok | Dev runtime, websocket, warning page, or public tunnel behavior | Test production preview through ngrok |
| Page loads; images missing | Served root or relative paths are wrong | Serve repo root or adjust preview path |
| Tailscale direct is slow but shows `direct` | Peer-to-peer path is alive but mobile network latency is high | Report latency caveat; DERP region changes may not help |
| ngrok URL opens warning page | Browser warning interstitial | Ask user to tap `Visit Site`; use validation header in scripted checks |
