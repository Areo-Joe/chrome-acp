# Default recipe
default:
    @just --list

# Build the Chrome extension
build:
    bun run build:extension

# Build proxy server
build-proxy:
    bun run build:proxy

# Build web client (PWA)
build-web:
    bun run build:web

# Build all
build-all:
    bun run build

# Release a new version
# Usage: just release 1.2.3
release version:
    #!/usr/bin/env bash
    set -euo pipefail

    VERSION="{{version}}"

    # Validate version format
    if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "❌ Invalid version format. Use: X.Y.Z (e.g., 1.2.3)"
        exit 1
    fi

    echo "🚀 Releasing version $VERSION"

    # Detect OS for sed compatibility
    if [[ "$OSTYPE" == "darwin"* ]]; then
        SED_INPLACE="sed -i ''"
    else
        SED_INPLACE="sed -i"
    fi

    # Update manifest.json
    echo "📝 Updating packages/chrome-extension/manifest.json..."
    $SED_INPLACE 's/"version": "[^"]*"/"version": "'"$VERSION"'"/' packages/chrome-extension/manifest.json

    # Update proxy-server/package.json
    echo "📝 Updating packages/proxy-server/package.json..."
    $SED_INPLACE 's/"version": "[^"]*"/"version": "'"$VERSION"'"/' packages/proxy-server/package.json

    # Commit changes
    echo "📦 Committing version bump..."
    git add packages/chrome-extension/manifest.json packages/proxy-server/package.json
    git commit -m "chore: bump version to $VERSION"

    # Create and push tag
    echo "🏷️  Creating tag v$VERSION..."
    git tag "v$VERSION"

    echo "⬆️  Pushing to GitHub..."
    git push
    git push --tags

    echo "✅ Done! GitHub Actions will handle the rest."
    echo "   Watch: https://github.com/Areo-Joe/chrome-acp/actions"

