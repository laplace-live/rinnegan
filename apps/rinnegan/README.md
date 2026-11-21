# LAPLACE Rinnegan 輪廻眼

Detects **独轮车** (automated danmaku spammers looping the same or slightly mutated lines, typically via tools like
[LAPLACE Chatterbox](https://laplace.live/chatterbox)) in Bilibili Live rooms, and mutes them through Bilibili's
official silent-user API.

```bash
bunx @laplace.live/rinnegan offline archive.lca
bunx @laplace.live/rinnegan live --url ws://localhost:8080 --room 25034104 --dry-run
LOGIN_SYNC_TOKEN='uuid@password' bunx @laplace.live/rinnegan live --url ws://localhost:8080 --room 25034104
bunx @laplace.live/rinnegan login                                                   # or log in by QR code instead
```

Rinnegan requires [Bun](https://bun.sh) ≥ 1.3.7. How it detects, every option, the ban store and the audit log are in
the [README on GitHub](https://github.com/laplace-live/rinnegan#readme). The detector itself is published as
[`@laplace.live/rinnegan-sdk`](https://www.npmjs.com/package/@laplace.live/rinnegan-sdk) for other apps to use.

## License

AGPL-3.0-only
