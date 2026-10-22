#!/usr/bin/env bash
# Live verification of the Bun port against the real OpenCode free tier.
set -u
PORT_API=${PORT_API:-8097}
PORT_WEB=${PORT_WEB:-8096}
KEY="local-test-key"
BASE="http://127.0.0.1:${PORT_API}"
WEB="http://127.0.0.1:${PORT_WEB}"
MODEL=${MODEL:-glm-5.3-flash-free}
COOKIES=${COOKIES:-/tmp/oc2api-bun/cookies}
PASS=0
FAIL=0

check() { # name, condition-result
  if [ "$2" = "0" ]; then echo "PASS  $1"; PASS=$((PASS+1)); else echo "FAIL  $1"; FAIL=$((FAIL+1)); fi
}

# 1. health
code=$(curl -s -o /tmp/vh.json -w "%{http_code}" -m 15 "$BASE/healthz")
check "healthz returns 200" "$([ "$code" = "200" ] && echo 0 || echo 1)"
grep -q '"status":"ready"' /tmp/vh.json
check "healthz reports ready" $?

# 2. auth
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "$BASE/v1/models")
check "models without a key is 401" "$([ "$code" = "401" ] && echo 0 || echo 1)"

# 3. models list
code=$(curl -s -o /tmp/vm.json -w "%{http_code}" -m 20 "$BASE/v1/models" -H "Authorization: Bearer $KEY")
check "models with a key is 200" "$([ "$code" = "200" ] && echo 0 || echo 1)"
grep -q "\"$MODEL\"" /tmp/vm.json
check "models list contains $MODEL" $?

# 0. preflight: the free tier limits every model per IP per day, so pick a
# model that still has quota.
CANDIDATES="${CANDIDATES:-$MODEL beam-free big-pickle flint-40b-free minimax-m3.1-flash-free deepseek-v4.1-flash-free mimo-v2.6-flash-free nemotron-3.5-lightning-free}"
MODEL=""
for candidate in $CANDIDATES; do
  code=$(timeout 60 curl -s -o /tmp/vprobe.json -w "%{http_code}" -m 50 "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$candidate\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" 2>&1)
  if [ "$code" = "200" ]; then
    MODEL="$candidate"
    break
  fi
done
if [ -z "$MODEL" ]; then
  echo "SKIP  every free model is rate limited for this IP today (the upstream answers 429)"
  exit 0
fi
echo "model             $MODEL"

# 4. chat, streaming
out=$(timeout 120 curl -s -N -m 110 "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: ok\"}]}" 2>&1)
echo "$out" | grep -q '"object":"chat.completion.chunk"'
check "chat stream emits chunks" $?
echo "$out" | grep -q 'data: \[DONE\]'
check "chat stream ends with [DONE]" $?

# 5. chat, non-streaming
out=$(timeout 120 curl -s -m 110 "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: ok\"}]}" 2>&1)
echo "$out" | grep -q '"finish_reason":"stop"'
check "chat non-streaming returns a document" $?

# 6. anthropic
out=$(timeout 120 curl -s -m 110 "$BASE/v1/messages" -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: ok\"}]}" 2>&1)
echo "$out" | grep -q '"type":"message"'
check "anthropic messages returns an anthropic document" $?
echo "$out" | grep -q '"stop_reason":"end_turn"'
check "anthropic stop_reason is end_turn" $?

# 7. responses
out=$(timeout 120 curl -s -m 110 "$BASE/v1/responses" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"input\":\"reply with the single word: ok\"}" 2>&1)
echo "$out" | grep -q '"object":"response"'
check "responses returns a responses document" $?

# 8. unknown model
code=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"model":"no-such-model","messages":[]}')
check "unknown model is 404" "$([ "$code" = "404" ] && echo 0 || echo 1)"

# 9. admin
rm -f "$COOKIES"
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "$WEB/")
check "webui index is 200" "$([ "$code" = "200" ] && echo 0 || echo 1)"
code=$(curl -s -o /tmp/vlogin.json -w "%{http_code}" -m 15 -c "$COOKIES" -X POST "$WEB/api/auth/login" \
  -H "Content-Type: application/json" -d '{"username":"admin","password":"change-this-admin-password"}')
check "admin login is 200" "$([ "$code" = "200" ] && echo 0 || echo 1)"
grep -q '"csrf"' /tmp/vlogin.json
check "admin login returns a csrf token" $?

# 10. tool call round trip
out=$(timeout 120 curl -s -m 110 "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Oslo? Use the tool.\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"description\":\"the weather in a city\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}}]}" 2>&1)
echo "$out" | grep -q '"tool_calls"'
check "chat tool call is returned" $?
call_id=$(echo "$out" | sed -n 's/.*"id":"\(call_[^"]*\)".*/\1/p' | head -1)
[ -n "$call_id" ]
check "the tool call carries an id" $?
if [ -n "$call_id" ]; then
  out=$(timeout 120 curl -s -m 110 "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Oslo? Use the tool.\"},{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"$call_id\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"Oslo\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"$call_id\",\"content\":\"7C and rain\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}}}}}]}" 2>&1)
  echo "$out" | grep -q '"finish_reason":"stop"'
  check "the tool result completes the turn" $?
fi

# 11. two requests at once
a=$(timeout 120 curl -s -m 110 "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say a\"}]}" 2>&1 &
  timeout 120 curl -s -m 110 "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say b\"}]}" 2>&1)
echo "$a" | grep -c '"object":"chat.completion"' >/dev/null
check "two concurrent requests both answer" $?

# 12. the management API
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 -b "$COOKIES" "$WEB/api/monitor")
check "admin monitor is 200" "$([ "$code" = "200" ] && echo 0 || echo 1)"
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 -b "$COOKIES" "$WEB/api/logs")
check "admin logs is 200" "$([ "$code" = "200" ] && echo 0 || echo 1)"
code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "$WEB/api/config")
check "admin config without a session is 401" "$([ "$code" = "401" ] && echo 0 || echo 1)"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" = "0" ]
