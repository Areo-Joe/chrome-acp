# Default recipe
default:
    @just --list

# Build the Chrome extension
build:
    pnpm run build:extension

# Build proxy server
build-proxy:
    pnpm run build:proxy

# Build web client (PWA)
build-web:
    pnpm run build:web

# Build all
build-all:
    pnpm run build

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

    # Cross-platform sed in-place function
    sed_inplace() {
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "$@"
        else
            sed -i "$@"
        fi
    }

    # Update manifest.json
    echo "📝 Updating packages/chrome-extension/manifest.json..."
    sed_inplace 's/"version": "[^"]*"/"version": "'"$VERSION"'"/' packages/chrome-extension/manifest.json

    # Update proxy-server/package.json
    echo "📝 Updating packages/proxy-server/package.json..."
    sed_inplace 's/"version": "[^"]*"/"version": "'"$VERSION"'"/' packages/proxy-server/package.json

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

# Release a beta version
# Usage: just release-beta 1.2.3-beta.1
release-beta version:
    #!/usr/bin/env bash
    set -euo pipefail

    VERSION="{{version}}"

    # Validate version format (must contain hyphen for prerelease)
    if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[a-zA-Z0-9.]+$ ]]; then
        echo "❌ Invalid beta version format. Use: X.Y.Z-tag (e.g., 1.2.3-beta.1)"
        exit 1
    fi

    echo "🧪 Releasing beta version $VERSION"

    # Cross-platform sed in-place function
    sed_inplace() {
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "$@"
        else
            sed -i "$@"
        fi
    }

    # Update proxy-server/package.json only (no extension update for beta)
    echo "📝 Updating packages/proxy-server/package.json..."
    sed_inplace 's/"version": "[^"]*"/"version": "'"$VERSION"'"/' packages/proxy-server/package.json

    # Commit changes
    echo "📦 Committing version bump..."
    git add packages/proxy-server/package.json
    git commit -m "chore: bump version to $VERSION"

    # Create and push tag
    echo "🏷️  Creating tag v$VERSION..."
    git tag "v$VERSION"

    echo "⬆️  Pushing to GitHub..."
    git push
    git push --tags

    echo "✅ Done! GitHub Actions will handle the rest."
    echo "   Install with: npm install -g @chrome-acp/proxy-server@$VERSION"
    echo "   Watch: https://github.com/Areo-Joe/chrome-acp/actions"

