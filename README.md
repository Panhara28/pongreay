# Pongreay

Secure Docker deployment CLI for modern applications.

Pongreay simplifies the process of building, uploading, and deploying Docker containers to remote servers via SSH. It includes built-in safety checks, health monitoring, and automatic rollback capabilities.

## Features

- **Branch Protection:** Ensures deployments only happen from the correct Git branches.
- **Git Safety:** Requires a clean Git state before deployment.
- **Automated Tests:** Runs your test suite before building the image.
- **Zero-Downtime-ish Deployment:** Stops the old container and starts the new one, with quick health checks.
- **Automatic Rollback:** If the new container fails its health check, Pongreay automatically rolls back to the previous version.
- **Simple Configuration:** Single YAML file to manage all your environments.

## Installation

```bash
npm install -g pongreay
```

*(Note: Ensure you have `docker`, `ssh`, and `scp` installed on your machine and accessible via CLI.)*

## Quick Start

### 1. Initialize Configuration

Run the following command in your project root to create a `pongreay.config.yml` file:

```bash
# Using defaults (deploy@your-ip-address)
pongreay init

# Or with custom server details
pongreay init --hostname deploy --ip 192.168.0.1
```

### 2. Configure Your Environments

Edit `pongreay.config.yml` to match your server details:

```yaml
project: my-awesome-app
healthPath: /health

environments:
  uat:
    server: deploy@uat-server.com
    branch: develop
    appName: my-app-uat
    imageName: my-app
    envFileOnServer: /etc/pongreay/my-app/uat.env
    hostPort: 3000
    containerPort: 3000

  production:
    server: deploy@prod-server.com
    branch: main
    appName: my-app-prod
    imageName: my-app
    envFileOnServer: /etc/pongreay/my-app/prod.env
    hostPort: 8080
    containerPort: 3000
```

### 3. Deploy

Deploy to UAT:

```bash
pongreay uat
```

Deploy to Production (requires confirmation):

```bash
pongreay production --confirm
```

## Commands

### `pongreay init`

Creates a default `pongreay.config.yml` in the current directory.

**Options:**

- `--hostname <hostname>`: The SSH user/hostname to use (default: `deploy`).
- `--ip <ip>`: The server IP address (default: `your-ip-address`).

### `pongreay [environment]`

Deploys the application to the specified environment.

**Options:**

- `--confirm`: Required for deploying to the `production` environment.
- `--dry-run`: Shows the deployment plan without executing any remote commands.
- `--skip-tests`: Skips running `npm test` before the build process.

## Environment File Security

Pongreay does not upload your local `.env` file and does not copy it into the Docker image. The container receives environment variables at runtime from `envFileOnServer`.

Before deployment, Pongreay requires:

- `.dockerignore` contains `.env` and `.env.*`.
- `envFileOnServer` is under `/etc/pongreay/`, outside the app directory.
- The server env file exists and is readable by the deploy user.
- The server env file owner is the deploy user or `root`.
- The server env file permissions are `600` or `400`; Pongreay attempts `chmod 600` before enforcing this.

Example server setup:

```bash
sudo mkdir -p /etc/pongreay/my-app
sudo nano /etc/pongreay/my-app/production.env
sudo chown deploy:deploy /etc/pongreay/my-app/production.env
sudo chmod 600 /etc/pongreay/my-app/production.env
```

## Requirements

- **Local Machine:**
  - Docker
  - SSH / SCP
  - Git
  - Node.js (for running the CLI)
- **Remote Server:**
  - Docker
  - A protected environment file under `/etc/pongreay/` specified by `envFileOnServer`.

## How it Works

1. **Pre-flight Checks:** Verifies the current Git branch and ensures there are no uncommitted changes.
2. **Testing:** Runs `npm test` to ensure code quality.
3. **Build:** Builds a Docker image tagged with the current environment and commit hash.
4. **Export:** Saves and compresses the Docker image.
5. **Upload:** Transfers the image to the remote server via `scp`.
6. **Remote Execution:**
   - Loads the Docker image on the server.
   - Stops and removes the existing container.
   - Starts the new container with the specified ports and environment file.
   - Performs a health check against the `healthPath`.
7. **Cleanup/Rollback:** 
   - On success: Removes the temporary image file from the server.
   - On failure: Restarts the previous container and exits with an error.

## License

MIT
