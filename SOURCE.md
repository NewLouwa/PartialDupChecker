# Installing via a Stash plugin source

This lets you install and update Partial Duplicate Checker through Stash's normal
plugin UI (Settings > Plugins > Available Plugins > Add Source), exactly like the
community plugins - instead of copying files by hand.

## Ready-made source (GitHub, recommended)

The built package is published on this repo's `source` branch. In Stash,
Settings > Plugins > **Available Plugins** > **Add Source**:

- Name: `PartialDup`
- Source URL: `https://raw.githubusercontent.com/NewLouwa/PartialDupChecker/source/index.yml`
- Local path: `partialdup`

Do NOT use the repo page or any other GitHub URL as the source - Stash needs the
raw `index.yml` above, anything else fails with a YAML parse error
("mapping values are not allowed in this context").

To publish an update: rebuild (`./build_source.sh`, or the same steps on Windows),
then force-push `dist/` contents to the `source` branch. The version string embeds
a build stamp so Stash offers it as an update.

## Self-hosted alternative

## 1. Build the package

```
./build_source.sh
```

Produces `dist/index.yml` and `dist/partial_dup_checker.zip` (the zip bundles the
plugin plus its `_vendor/` Python deps, so the install is self-contained). Re-run
after any change and re-host - the version string includes a build stamp so Stash
sees it as an update.

## 2. Host `dist/` somewhere Stash can reach

Stash sources are HTTP(S) URLs. Pick one:

- Quick test (same host): `cd dist && python3 -m http.server 89000` then add
  `http://<host>:8900/index.yml`.
- Durable, internal (recommended for the media-vm): run a tiny static file server
  on the same Docker network as Stash, no auth in front, e.g. add to
  `docker-compose.yml`:

  ```yaml
    pdc-source:
      image: halverneus/static-file-server:latest
      container_name: pdc-source
      restart: unless-stopped
      networks: [arr_net]
      volumes:
        - /opt/arr/pdc-source:/web:ro
      environment:
        - FOLDER=/web
  ```

  Copy `dist/*` into `/opt/arr/pdc-source/`, `docker compose up -d pdc-source`,
  then the source URL is `http://pdc-source:8080/index.yml` (reachable from Stash
  on `arr_net`; no Authelia in the way).

- Public: commit `dist/` to a GitHub repo and use the raw/Pages URL, or serve it
  behind Caddy on a path that bypasses Authelia (Stash must fetch it unauthenticated).

## 3. Add the source in Stash

Settings > Plugins > **Available Plugins** > **Add Source**:

- Name: `PartialDup`
- Source URL: the `index.yml` URL from step 2
- Local path: `partialdup` (any label)

Then find "Partial Duplicate Checker" under that source and click Install. Updates
appear there whenever you rebuild + re-host with a newer build stamp.
