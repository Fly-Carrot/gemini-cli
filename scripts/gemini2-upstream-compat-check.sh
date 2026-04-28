#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/google-gemini/gemini-cli.git}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
GIT_IDENTITY_NAME="${GIT_IDENTITY_NAME:-github-actions[bot]}"
GIT_IDENTITY_EMAIL="${GIT_IDENTITY_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

CHECK_BRANCH="gemini2-upstream-check-$(date +%Y%m%d%H%M%S)"
WORKTREE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gemini2-upstream-check.XXXXXX")"

cleanup() {
  set +e
  if [[ -d "$WORKTREE_DIR" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
    rm -rf "$WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
  git -C "$REPO_ROOT" branch -D "$CHECK_BRANCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! git -C "$REPO_ROOT" remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git -C "$REPO_ROOT" remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

git -C "$REPO_ROOT" fetch "$UPSTREAM_REMOTE" "$TARGET_BRANCH"

UPSTREAM_REF="$UPSTREAM_REMOTE/$TARGET_BRANCH"
HEAD_REF="$(git -C "$REPO_ROOT" rev-parse HEAD)"

echo "Repository root: $REPO_ROOT"
echo "Current HEAD: $HEAD_REF"
echo "Upstream ref: $UPSTREAM_REF"

if git -C "$REPO_ROOT" merge-base --is-ancestor "$UPSTREAM_REF" HEAD; then
  echo "Current branch already contains $UPSTREAM_REF. Running verification against current HEAD."
fi

git -C "$REPO_ROOT" worktree add -b "$CHECK_BRANCH" "$WORKTREE_DIR" HEAD >/dev/null

pushd "$WORKTREE_DIR" >/dev/null

git config user.name "$GIT_IDENTITY_NAME"
git config user.email "$GIT_IDENTITY_EMAIL"

if [[ ! -e "$WORKTREE_DIR/node_modules" && -d "$REPO_ROOT/node_modules" ]]; then
  ln -s "$REPO_ROOT/node_modules" "$WORKTREE_DIR/node_modules"
fi

git rebase "$UPSTREAM_REF"

needs_fresh_install=0
required_paths=(
  "node_modules/@a2a-js/sdk/package.json"
  "node_modules/fdir/package.json"
  "node_modules/chokidar/package.json"
  "node_modules/ajv/dist/2020.js"
)

for required_path in "${required_paths[@]}"; do
  if [[ ! -e "$WORKTREE_DIR/$required_path" ]]; then
    needs_fresh_install=1
    break
  fi
done

if [[ "$needs_fresh_install" -eq 1 ]]; then
  echo "Dependency snapshot is missing upstream requirements. Running fresh npm ci..."
  if [[ -L "$WORKTREE_DIR/node_modules" ]]; then
    rm "$WORKTREE_DIR/node_modules"
  fi
  npm ci --ignore-scripts
fi

echo "Running Gemini-2 compatibility checks..."
npm run generate
npm run build --workspace @google/gemini-cli-devtools
npm run build --workspace @google/gemini-cli-core
npx tsc -p packages/cli/tsconfig.json --noEmit
npx vitest run \
  packages/cli/src/core/sessionOrchestrator.test.ts \
  packages/cli/src/services/sharedFabricAutoRouter.test.ts \
  packages/cli/src/ui/commands/fabricCommand.test.ts \
  packages/cli/src/ui/commands/runtimeCommand.test.ts \
  packages/cli/src/ui/commands/skillsCommand.test.ts \
  packages/cli/src/ui/commands/agentsCommand.test.ts \
  packages/cli/src/ui/commands/memoryCommand.test.ts
npm run build --workspace @google/gemini-cli-core
npm run build --workspace @google/gemini-cli

NEW_HEAD="$(git rev-parse HEAD)"
echo "Gemini-2 upstream compatibility check succeeded."
echo "Rebased compatibility HEAD: $NEW_HEAD"

popd >/dev/null
