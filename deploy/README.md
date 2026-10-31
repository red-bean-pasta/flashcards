# Deploy Flashcards with Caddy

Run from a source checkout outside `/srv/flashcards`. The server must already have an active Caddyfile-based `caddy.service` whose reload uses `/etc/caddy/Caddyfile`, plus Bash, Python 3, `flock`, and the matching `caddy` executable. Keep existing global options, including Cloudflare DNS configuration, in the root Caddyfile. The deployment script does not install Caddy or read its environment file.

Build and deploy as a sudo-capable user with Node.js >=22.12 and npm available:

```sh
sudo ./deploy/setup.sh --domain flashcards.example.com
```

The script runs `npm ci` and `npm run build` as the invoking non-root sudo user. For a user-local Node installation, build in that user's shell first:

```sh
npm ci
npm run build
sudo ./deploy/setup.sh --domain flashcards.example.com --skip-build
```

Environment arguments also work without preserving the whole shell environment:

```sh
sudo DOMAIN=flashcards.example.com PORT=443 ./deploy/setup.sh --skip-build
```

The script never prompts for deployment parameters. `sudo` may still request your password. Custom deployment/configuration directory flags are no longer supported: assets are served through `/srv/flashcards/dist` and the managed site is `/etc/caddy/conf.d/flashcards.caddy`.

Assets are copied into a separate release before activation. Existing configuration is backed up in a private directory under `/etc/caddy`; Caddy's adapted configuration confirms the site is imported exactly once. Syntax is checked without provisioning certificates, then the systemd reload validates/provisions using the service's own environment. Failed checks restore the previous configuration and assets; a failed activation also reloads the restored configuration. Failures exit nonzero, including rollback failures.

Successful redeployments replace the `dist` symlink atomically. The first deployment over an existing real `dist` directory moves it into the releases directory before creating the symlink. Backups and previous asset releases are retained for recovery; remove older unused releases and backups according to your server's retention policy. Forced termination such as SIGKILL or power loss cannot run the rollback trap.

`Caddyfile.example` can also be used manually. Its site block is the template consumed by `setup.sh`; keep the `# BEGIN FLASHCARDS SITE` marker and address placeholder intact. When Cloudflare proxies the site, use Full (Strict) SSL and an HTTPS port supported by Cloudflare.
