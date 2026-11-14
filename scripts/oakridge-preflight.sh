# Shared, read-only launcher/doctor checks. Caller supplies OAKRIDGE_ROOT.
oakridge_check() {
  local kind="$1" id="$2" required="$3" detail="$4" fix="${5:-}"
  if [ "${OAKRIDGE_CHECK_FORMAT:-}" = json ]; then
    local label="$id" value
    for value in kind id label detail fix; do
      local escaped="${!value}"
      escaped="${escaped//\\/\\\\}"; escaped="${escaped//\"/\\\"}"; escaped="${escaped//$'\n'/\\n}"; escaped="${escaped//$'\r'/\\r}"; escaped="${escaped//$'\t'/\\t}"
      printf -v "$value" '%s' "$escaped"
    done
    printf '{"kind":"%s","id":"%s","label":"%s","required":%s,"detail":"%s"' "$kind" "$id" "$label" "$required" "$detail"
    if [ "$kind" != ok ]; then printf ',"fix":"%s"' "$fix"; fi
    printf '}\n'
  else
    local prefix="oakridge:"
    if [ "$kind" = unavailable_optional ] && [[ "$id" == *-acp ]]; then prefix="oakridge: warning:"; fi
    echo "$prefix $detail${fix:+; $fix}"
  fi
  [ "$kind" != failed ] || [ "$required" != true ]
}
oakridge_check_command() {
  if command -v "$1" >/dev/null 2>&1; then oakridge_check ok "$1" true "$1 is installed";
  else oakridge_check failed "$1" true "$1 is missing" "$2"; fi
}
oakridge_check_bash() {
  if ((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3))); then
    oakridge_check ok bash true "Bash $BASH_VERSION is supported"
  else oakridge_check failed bash true "Bash 4.3 or newer is required" "Install Bash 4.3+"; fi
}
oakridge_check_wasm() {
  if [ -n "${OAKRIDGE_CORE_WASM:-}" ]; then
    if [ -f "$OAKRIDGE_CORE_WASM" ]; then oakridge_check ok wasm true "Using supplied workflow WASM";
    else oakridge_check failed wasm true "workflow WASM is missing" "Build OAKRIDGE_CORE_WASM from this tree"; fi
    return
  fi
  local toolchain
  toolchain="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$OAKRIDGE_ROOT/workflow-core/rust-toolchain.toml")"
  oakridge_check_command cargo "Install the pinned toolchain: rustup toolchain install $toolchain" || return 1
  oakridge_check_command rustup "Install rustup from https://rustup.rs" || return 1
  if rustup target list --installed --toolchain "$toolchain" | grep -qx wasm32-unknown-unknown; then
    oakridge_check ok wasm_target true "wasm32-unknown-unknown is installed for $toolchain"
  else oakridge_check failed wasm_target true "wasm32-unknown-unknown is missing" "rustup target add wasm32-unknown-unknown --toolchain $toolchain"; fi
}
oakridge_check_database() {
  if [ -n "${DBOS_SYSTEM_DATABASE_URL:-}" ]; then oakridge_check ok postgres true "External PostgreSQL is configured"; return; fi
  if ! command -v docker >/dev/null 2>&1; then oakridge_check failed postgres true "Docker is required when DBOS_SYSTEM_DATABASE_URL is not set" "Start Docker or export DBOS_SYSTEM_DATABASE_URL"; return 1; fi
  if docker info >/dev/null 2>&1; then oakridge_check ok postgres true "Docker daemon is available";
  else oakridge_check failed postgres true "Docker daemon is not running" "Start Docker or export DBOS_SYSTEM_DATABASE_URL"; fi
}
oakridge_check_agents() {
  local adapter runnable=0 vendor executable
  for adapter in claude-agent-acp codex-acp; do
    if [ -x "$OAKRIDGE_ROOT/kbbl/node_modules/.bin/$adapter" ]; then
      runnable=$((runnable + 1)); oakridge_check ok "$adapter" false "$adapter is installed"
    else oakridge_check unavailable_optional "$adapter" false "$adapter is missing" "run bun install --frozen-lockfile"; fi
  done
  for vendor in claude codex; do
    if [ "$vendor" = claude ]; then executable="${CLAUDE_CODE_EXECUTABLE:-claude}"; else executable="${CODEX_PATH:-codex}"; fi
    if command -v "$executable" >/dev/null 2>&1; then oakridge_check ok "$vendor" false "$vendor CLI is installed";
    else oakridge_check unavailable_optional "$vendor" false "$vendor CLI is missing" "Install the Claude Code CLI (claude) or the Codex CLI (codex)"; fi
  done
  if [ "$runnable" -gt 0 ]; then oakridge_check ok acp true "An ACP adapter is installed";
  else oakridge_check failed acp true "No ACP adapter is installed" "run bun install --frozen-lockfile"; fi
}
oakridge_check_access() {
  local host="$1" token="${OAKRIDGE_CONTROL_TOKEN:-}"
  token="${token//[[:space:]]/}"
  case "$host" in
    127.0.0.1|::1|localhost|'[::1]') oakridge_check ok access true "access mode: local (kbbl bound to $host; no control token required)" ;;
    *) if [ -n "$token" ]; then oakridge_check ok access true "access mode: authenticated network (kbbl bound to $host; OAKRIDGE_CONTROL_TOKEN is set)";
      elif [ "${ALLOW_INSECURE_NON_LOOPBACK_CONTROL:-}" = 1 ]; then oakridge_check ok access true "access mode: insecure network (kbbl bound to $host with no control token; ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1)";
      else oakridge_check failed access true "refusing to bind kbbl to $host without OAKRIDGE_CONTROL_TOKEN" "set OAKRIDGE_CONTROL_TOKEN to any nonempty value, bind to 127.0.0.1, or set ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 to accept an unauthenticated network listener"; fi ;;
  esac
}
read_gated_review_url() {
  bun -e '
    const file = Bun.file(process.argv[1]);
    if (!(await file.exists())) process.exit(0);
    const server = (await file.json()).mcpServers?.["gated-review"];
    if (server === undefined) process.exit(0);
    if (server?.type !== "http" || typeof server.url !== "string" || server.url.trim() === "") process.exit(1);
    console.log(server.url.trim());' "$OAKRIDGE_ROOT/.mcp.json" 2>/dev/null
}
oakridge_check_mcp() {
  if [ ! -f "$OAKRIDGE_ROOT/.mcp.json" ]; then
    oakridge_check unavailable_optional gated_review false "gated-review is not configured (no .mcp.json)" "Copy .mcp.example.json to .mcp.json to enable it"
  elif ! read_gated_review_url >/dev/null; then
    oakridge_check failed gated_review false ".mcp.json is malformed" "Configure gated-review as an http server with a nonempty url"
  elif [ -z "$(read_gated_review_url)" ]; then
    oakridge_check unavailable_optional gated_review false "No gated-review server configured" "Add an http gated-review server with a nonempty url to .mcp.json"
  else oakridge_check ok gated_review false "gated-review server is configured"; fi
}
