#!/usr/bin/env bash
# Isolated Linux containers only. Never mounts a user's home or brain.
set -euo pipefail
image="${GBRAIN_RUNTIME_TEST_IMAGE:-gbrain-runtime:task}"
fixture=$(mktemp -d /tmp/gbrain-runtime-fixture.XXXXXX)
name="gbrain-runtime-smoke-$$"
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    for log in "$fixture"/*.log; do [ ! -f "$log" ] || tail -15 "$log"; done
    docker exec "$name" cat /fixture/runtime.log 2>/dev/null || true
  fi
  docker rm -f "$name" "$name-model" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT
chmod 0777 "$fixture"
mkdir -p "$fixture/gbrain-runtime/.gbrain" "$fixture/gbrain-runtime/home" \
  "$fixture/gbrain-sources/bender-authored/.git" "$fixture/gbrain-sources/bender-communications/.git"
chmod -R a+rwX "$fixture"
touch "$fixture/writer.lock"
chmod 0666 "$fixture/writer.lock"
cat > "$fixture/fixture.ts" <<'JS'
import { PGLiteEngine } from '/app/src/core/pglite-engine.ts';
import { writeFileSync, readFileSync } from 'node:fs';
import { GBrainOAuthProvider } from '/app/src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '/app/src/core/sql-query.ts';
const path = '/fixture/gbrain-runtime/brain.pglite';
const engine = new PGLiteEngine();
await engine.connect({ database_path: path });
const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), tokenTtl: 3600, refreshTtl: 7200 });
if (Bun.argv.includes('verify')) {
  const page = await engine.getPage('fixture/preserved');
  if (page?.compiled_truth !== 'Preserved fixture text') throw new Error('Lost fixture page');
  if (await engine.getConfig('search.mode') !== 'conservative') throw new Error('Changed search mode');
  const rows = await engine.executeRaw('SELECT embedding::text AS value FROM content_chunks');
  if (rows[0]?.value !== `[${Array(1024).fill(0.25).join(',')}]`) throw new Error('Changed stored embedding');
  const saved = JSON.parse(readFileSync('/fixture/gbrain-runtime/fixture-oauth.json','utf8'));
  const auth = await provider.verifyAccessToken(saved.access_token);
  if (!auth.scopes.includes('read')) throw new Error('Lost OAuth grant');
} else {
  await engine.initSchema();
  await engine.putPage('fixture/preserved', { title: 'Fixture', type: 'note', compiled_truth: 'Preserved fixture text' });
  await engine.setConfig('search.mode', 'conservative');
  await engine.executeRaw('ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(1024)');
  await engine.upsertChunks('fixture/preserved', [{chunk_index:0,chunk_source:'compiled_truth',chunk_text:'Preserved fixture text',embedding:new Float32Array(1024).fill(0.25)}]);
  const client = await provider.registerClientManual('fixture-client', ['client_credentials'], 'read');
  const tokens = await provider.exchangeClientCredentials(client.clientId,client.clientSecret,'read');
  writeFileSync('/fixture/gbrain-runtime/fixture-oauth.json',JSON.stringify(tokens),{mode:0o600});
  writeFileSync('/fixture/gbrain-runtime/.gbrain/config.json', JSON.stringify({ engine:'pglite', database_path: path, embedding_disabled: true, embedding_model: 'ollama:snowflake-arctic-embed2', embedding_dimensions:1024 }));
}
await engine.disconnect();
JS
# Fixture storage is tmpfs so local host disk pressure cannot weaken production's
# 5 GiB free-space guard. The shared writer lock remains a real bind mount.
docker run -d --name "$name" --tmpfs /fixture:rw,size=8g,mode=0777 \
  -v "$fixture:/locks" --entrypoint /usr/bin/tini "$image" -s -- sleep infinity >/dev/null
docker exec "$name" mkdir -p /fixture/gbrain-runtime/.gbrain /fixture/gbrain-runtime/home \
  /fixture/gbrain-sources/bender-authored/.git /fixture/gbrain-sources/bender-communications/.git
chmod 0644 "$fixture/fixture.ts"
docker exec -i "$name" sh -c 'cat > /fixture/fixture.ts' < "$fixture/fixture.ts"
docker exec "$name" bun /fixture/fixture.ts > "$fixture/init.log" 2>&1
before=$(docker exec "$name" sha256sum /fixture/gbrain-runtime/.gbrain/config.json | cut -d' ' -f1)
# The fake service exposes inventory only. No inference endpoint exists.
docker exec -d "$name" bun -e \
  'Bun.serve({hostname:"127.0.0.1",port:11434,fetch:r=>new URL(r.url).pathname === "/api/tags" ? Response.json({models:[{name:"snowflake-arctic-embed2:latest"}]}) : new Response(null,{status:500})})'
docker exec -d -e GBRAIN_DATA_ROOT=/fixture -e GBRAIN_WRITER_LOCK=/locks/writer.lock \
  -e GBRAIN_PUBLIC_URL=https://brain.example.test \
  -e GBRAIN_ADMIN_BOOTSTRAP_TOKEN=fixture-only-admin-token-000000000000 \
  -e OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 -e OLLAMA_MODEL=snowflake-arctic-embed2 \
  "$name" bash -c 'echo $$ > /fixture/runtime.pid; exec /app/deploy/runtime/entrypoint.sh > /fixture/runtime.log 2>&1'
healthy=false
for _ in $(seq 1 120); do
  if docker exec "$name" bun -e 'process.exit((await fetch("http://127.0.0.1:3132/health")).ok ? 0 : 1)' >/dev/null 2>&1; then healthy=true; break; fi
  if ! docker exec "$name" bash -c 'kill -0 "$(cat /fixture/runtime.pid)"' >/dev/null 2>&1; then break; fi
  sleep 1
done
if [ "$healthy" != true ]; then docker exec "$name" cat /fixture/runtime.log; exit 1; fi
# An unrelated container must be fenced by the external supervisor lock.
if docker run --rm -v "$fixture:/locks" --entrypoint flock "$image" -n /locks/writer.lock true; then
  echo 'FAIL: competing container acquired the writer lock' >&2; exit 1
fi
docker exec "$name" bun -e 'const r=await fetch("http://127.0.0.1:3131/mcp",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}); if(r.status!==401) throw new Error("MCP authorization did not reject anonymous access")'
docker exec "$name" bash -c 'kill -TERM "$(cat /fixture/runtime.pid)"'
for _ in $(seq 1 90); do
  if ! docker exec "$name" bash -c 'kill -0 "$(cat /fixture/runtime.pid)"' >/dev/null 2>&1; then break; fi
  sleep 1
done
# Lock release and clean engine shutdown must both be observable.
docker run --rm -v "$fixture:/locks" --entrypoint flock "$image" -n /locks/writer.lock true
docker exec "$name" bun /fixture/fixture.ts verify > "$fixture/verify.log" 2>&1
after=$(docker exec "$name" sha256sum /fixture/gbrain-runtime/.gbrain/config.json | cut -d' ' -f1)
[ "$before" = "$after" ]
# A cold copy must reopen in a fresh container with a different PID namespace.
docker exec "$name" tar -C /fixture -cf - gbrain-runtime | tar -C "$fixture" -xf -
chmod -R a+rwX "$fixture/gbrain-runtime"
docker run --rm --user 1001:1001 -v "$fixture:/fixture" --entrypoint bun "$image" /fixture/fixture.ts verify > "$fixture/cold-verify.log" 2>&1
echo 'PASS: HTTP health, anonymous MCP denial, independent lock contention, graceful stop, unchanged config and cold-copy PGlite page/search mode/embedding/OAuth token'
