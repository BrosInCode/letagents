# Live demos preview

A try-out of live demos (shared cursors, drawing and saved marks on HTML demos) against the
preview server `https://x.letagents.chat`. The preview has its own database: sign in fresh with
GitHub; nothing here touches letagents.chat or an installed LetAgents app.

## Run it (macOS or Linux)

```sh
git fetch origin
git checkout try/live-demos-preview
npm ci
(cd apps/desktop && npm ci)
scripts/live-demos-preview/build.sh
scripts/live-demos-preview/start.sh
```

1. Click **Continue with GitHub** and approve the code in your browser.
2. Ask the room owner to add you to the test room (rooms are members-only), then open it.
3. A message with an `.html` file shows the demo inside the chat. Move your pointer over it,
   click **Draw**, add strokes and pins, and try **Send to thread**.

Your preview sign-in is kept in `scripts/live-demos-preview/.home` (ignored by git). Delete that
folder to sign out.
