# Default recipe
default:
    @just --list

# Build the Chrome extension
build:
    bun run build

# Build proxy server
build-proxy:
    cd proxy-server && bun run build

# Build all
build-all: build build-proxy

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
    
    # Update manifest.json
    echo "📝 Updating manifest.json..."
    sed -i '' 's/"version": "[^"]*"/"version": "'"$VERSION"'"/' manifest.json
    
    # Update proxy-server/package.json
    echo "📝 Updating proxy-server/package.json..."
    cd proxy-server && npm version "$VERSION" --no-git-tag-version && cd ..
    
    # Commit changes
    echo "📦 Committing version bump..."
    git add manifest.json proxy-server/package.json
    git commit -m "chore: bump version to $VERSION"
    
    # Create and push tag
    echo "🏷️  Creating tag v$VERSION..."
    git tag "v$VERSION"
    
    echo "⬆️  Pushing to GitHub..."
    git push
    git push --tags
    
    echo "✅ Done! GitHub Actions will handle the rest."
    echo "   Watch: https://github.com/Areo-Joe/chrome-acp/actions"

