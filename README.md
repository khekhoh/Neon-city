# Neon-city
A browser-based, local two-player shooter.

## Play online

This is a static game, so GitHub Pages can host it without a game server. The
deployment workflow publishes `index.html`, `game.js`, and `style.css` whenever
you push to `main`.

1. Commit and push the game files and `.github/workflows/deploy-pages.yml` to
   the `main` branch.
2. In the GitHub repository, open **Settings → Pages** and set the build and
   deployment source to **GitHub Actions**.
3. Open the **Actions** tab and wait for **Deploy game to GitHub Pages** to
   complete.
4. Share `https://khekhoh.github.io/Neon-city/` with your friends.

Each friend can open and play their own copy. This does not connect players to
the same match; the current game supports two players sharing one keyboard.
