#!/bin/sh
set -e

JWT_SECRET_FILE="/app/prisma/.jwt_secret"
CSRF_SECRET_FILE="/app/prisma/.csrf_secret"

# Ensure JWT secret exists for production startup.
# Backward compatibility: older installs may not have JWT_SECRET configured.
if [ -z "${JWT_SECRET:-}" ]; then
    echo "JWT_SECRET not provided, resolving persisted secret..."
    if [ -f "${JWT_SECRET_FILE}" ]; then
        JWT_SECRET="$(tr -d '\r\n' < "${JWT_SECRET_FILE}")"
    fi

    if [ -z "${JWT_SECRET}" ]; then
        echo "No persisted JWT secret found. Generating a new secret..."
        JWT_SECRET="$(openssl rand -hex 32)"
        umask 077
        printf "%s" "${JWT_SECRET}" > "${JWT_SECRET_FILE}"
    fi
else
    # Persist explicitly provided secret to support future restarts without env injection.
    umask 077
    printf "%s" "${JWT_SECRET}" > "${JWT_SECRET_FILE}"
fi

export JWT_SECRET

# Ensure CSRF secret exists for stable token validation across restarts.
# (Still recommend setting explicitly for multi-instance deployments.)
if [ -z "${CSRF_SECRET:-}" ]; then
    echo "CSRF_SECRET not provided, resolving persisted secret..."
    if [ -f "${CSRF_SECRET_FILE}" ]; then
        CSRF_SECRET="$(tr -d '\r\n' < "${CSRF_SECRET_FILE}")"
    fi

    if [ -z "${CSRF_SECRET}" ]; then
        echo "No persisted CSRF secret found. Generating a new secret..."
        CSRF_SECRET="$(openssl rand -base64 32)"
        umask 077
        printf "%s" "${CSRF_SECRET}" > "${CSRF_SECRET_FILE}"
    fi
else
    umask 077
    printf "%s" "${CSRF_SECRET}" > "${CSRF_SECRET_FILE}"
fi

export CSRF_SECRET

# 1. Hydrate volume if empty (Running as root)
if [ ! -f "/app/prisma/schema.prisma" ]; then
    echo "Mount is empty. Hydrating /app/prisma..."
    cp -R /app/prisma_template/. /app/prisma/
else
    # Volume exists but may be missing new migrations from an upgrade
    # Always sync schema and migrations from template to ensure upgrades work
    echo "Syncing schema and migrations from template..."
    cp /app/prisma_template/schema.prisma /app/prisma/schema.prisma
    cp -R /app/prisma_template/migrations/. /app/prisma/migrations/
fi

# 2. Fix permissions unconditionally (Running as root)
echo "Fixing filesystem permissions..."
chown -R nodejs:nodejs /app/uploads
chown -R nodejs:nodejs /app/prisma
chmod 755 /app/uploads
chmod 600 "${JWT_SECRET_FILE}"
chmod 600 "${CSRF_SECRET_FILE}"

# Ensure database file has proper permissions
if [ -f "/app/prisma/dev.db" ]; then
    echo "Database file found, ensuring write permissions..."
    chmod 600 /app/prisma/dev.db
fi

# 3. Run Migrations (Drop privileges to nodejs)
echo "Running database migrations..."
su-exec nodejs npx prisma migrate deploy

# 4. Start Application (Drop privileges to nodejs)
echo "Starting application as nodejs..."
exec su-exec nodejs node dist/index.js
