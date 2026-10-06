#!/usr/bin/env bash
# Prova que o backend funciona com um Redis com TLS (rediss://) e senha — o que
# um Redis gerenciado de produção exige — e que erros de TLS/senha/política de
# memória aparecem de forma clara.
#
# Requer: Docker, openssl, o backend compilado (cd backend && npm run build) e
# o backend/.env com Supabase/JWT/OpenRouter (usa o Supabase real só para o boot).
#   bash backend/scripts/test-redis-tls.sh
#
# Cria 2 containers temporários (Redis com TLS+senha na 6380, Redis com política
# allkeys-lru na 6381) e certificados descartáveis; remove tudo no final.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND="$ROOT/backend"
TMP="$(mktemp -d)"
APP_PORT=3070
TLS_PORT=6380
LRU_PORT=6381
PASS_TLS="senha-de-teste"
PASSED=0
FAILED=0
BACKEND_PID=""

ok() { echo "✅ $1"; PASSED=$((PASSED + 1)); }
ko() { echo "❌ $1"; FAILED=$((FAILED + 1)); }
check() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }

stop_backend() {
  if [ -n "$BACKEND_PID" ]; then kill "$BACKEND_PID" 2>/dev/null; wait "$BACKEND_PID" 2>/dev/null; BACKEND_PID=""; fi
}
cleanup() {
  stop_backend
  docker rm -f redis-tls-test redis-lru-test >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

# start_backend <log> VAR=valor ...   (espera o "Backend rodando" por até 25 s)
start_backend() {
  local log="$1"; shift
  stop_backend
  # `exec` faz o PID guardado ser o do próprio node (sem ele, o kill só alcançava a subshell)
  (cd "$BACKEND" && exec env PORT="$APP_PORT" ENABLE_DEBUG_ENDPOINT=true "$@" node dist/main >"$log" 2>&1) &
  BACKEND_PID=$!
  for _ in $(seq 1 25); do
    grep -q "Backend rodando" "$log" 2>/dev/null && return 0
    kill -0 "$BACKEND_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

redis_tls_cli() {
  docker exec redis-tls-test redis-cli -p "$TLS_PORT" --tls --cacert /tls/ca.crt -a "$PASS_TLS" --no-auth-warning "$@"
}

command -v openssl >/dev/null || { echo "openssl não encontrado"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker não está rodando"; exit 1; }
if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "A porta $APP_PORT já está em uso; libere-a e rode de novo."; exit 1; fi
[ -f "$BACKEND/dist/main.js" ] || { echo "Compile antes: cd backend && npm run build"; exit 1; }

# ---- certificados descartáveis (CA própria + certificado do servidor) --------
(
  cd "$TMP" || exit 1
  mkdir tls && cd tls || exit 1
  openssl genrsa -out ca.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key ca.key -sha256 -days 2 -subj "/CN=Test CA" -out ca.crt 2>/dev/null
  openssl genrsa -out server.key 2048 2>/dev/null
  openssl req -new -key server.key -subj "/CN=localhost" -out server.csr 2>/dev/null
  echo "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1" > ext.cnf
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -sha256 -extfile ext.cnf 2>/dev/null
  chmod 644 ./*
) || { echo "falha ao gerar os certificados"; exit 1; }

# ---- Redis com TLS + senha + noeviction; Redis com política errada ------------
docker rm -f redis-tls-test redis-lru-test >/dev/null 2>&1
docker run -d --name redis-tls-test -p "$TLS_PORT:$TLS_PORT" -v "$TMP/tls:/tls:ro" redis:7-alpine \
  redis-server --port 0 --tls-port "$TLS_PORT" --tls-cert-file /tls/server.crt --tls-key-file /tls/server.key \
  --tls-ca-cert-file /tls/ca.crt --tls-auth-clients no --requirepass "$PASS_TLS" --maxmemory-policy noeviction >/dev/null
docker run -d --name redis-lru-test -p "$LRU_PORT:6379" redis:7-alpine \
  redis-server --maxmemory 50mb --maxmemory-policy allkeys-lru >/dev/null
sleep 2
check "o Redis de teste exige TLS e senha (PING com TLS+senha responde PONG)" '[ "$(redis_tls_cli ping 2>/dev/null)" = "PONG" ]'

CA="$TMP/tls/ca.crt"
URL_OK="rediss://default:${PASS_TLS}@localhost:${TLS_PORT}"

# ---- 1. caminho feliz: rediss:// + senha + CA confiável ------------------------
if start_backend "$TMP/ok.log" REDIS_URL="$URL_OK" NODE_EXTRA_CA_CERTS="$CA"; then
  ok "backend sobe com REDIS_URL=rediss://...@localhost:$TLS_PORT"
else
  ko "backend sobe com REDIS_URL=rediss://... (ver log abaixo)"; tail -5 "$TMP/ok.log"
fi
check "cliente Redis compartilhado conectou por TLS" 'grep -q "Conectado ao Redis" "$TMP/ok.log"'
check "nenhum erro de Redis no log" '! grep -q "Erro no Redis" "$TMP/ok.log"'

H1=$(curl -s -m 5 "localhost:$APP_PORT/api/debug/instance" | sed -n 's/.*"hits":\([0-9]*\).*/\1/p')
H2=$(curl -s -m 5 "localhost:$APP_PORT/api/debug/instance" | sed -n 's/.*"hits":\([0-9]*\).*/\1/p')
check "contador no Redis (INCR) funciona por TLS (hits $H1 → $H2)" '[ -n "$H1" ] && [ "$H2" = "$((H1 + 1))" ]'

CODES=""
for _ in 1 2 3 4 5 6 7; do
  CODES="$CODES $(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "localhost:$APP_PORT/api/auth/login" -H 'content-type: application/json' -d '{"email":"a@a.com","password":"x"}')"
done
check "rate limit no Redis por TLS (7 logins:$CODES)" 'echo "$CODES" | grep -q 429'
check "contadores do rate limit gravados no Redis TLS" 'redis_tls_cli --scan | grep -q "hits"'
check "BullMQ registrou os schedulers (retenção e varredura) no Redis TLS" 'redis_tls_cli --scan | grep -q "bull:retencao:repeat" && redis_tls_cli --scan | grep -q "bull:analises:repeat"'

# um job consumido por um worker do BullMQ sobre TLS
JOB_ID="$(node -e "console.log(require('crypto').randomUUID())")"
(cd "$BACKEND" && NODE_EXTRA_CA_CERTS="$CA" node -e "
const { Queue } = require('bullmq');
const q = new Queue('analises', { connection: { url: '$URL_OK' } });
q.add('analisar', { documentId: '$JOB_ID' }, { jobId: '$JOB_ID', removeOnComplete: true, removeOnFail: true })
  .then(() => q.close());
")
for _ in $(seq 1 15); do grep -q "$JOB_ID" "$TMP/ok.log" && break; sleep 1; done
check "worker do BullMQ consumiu um job enfileirado por TLS" 'grep -q "Documento $JOB_ID não encontrado" "$TMP/ok.log"'
stop_backend

# ---- 1b. endpoint de diagnóstico desligado (o padrão) responde 404 ------------------
start_backend "$TMP/nodebug.log" REDIS_URL="$URL_OK" NODE_EXTRA_CA_CERTS="$CA" ENABLE_DEBUG_ENDPOINT=false >/dev/null
check "ENABLE_DEBUG_ENDPOINT=false: /api/debug/instance responde 404" '[ "$(curl -s -m 5 -o /dev/null -w "%{http_code}" "localhost:$APP_PORT/api/debug/instance")" = "404" ]'
check "com o debug desligado o resto da API segue de pé (/api/health = 200)" '[ "$(curl -s -m 5 -o /dev/null -w "%{http_code}" "localhost:$APP_PORT/api/health")" = "200" ]'
stop_backend

# ---- 2. sem confiar na CA: erro de certificado claro ---------------------------
start_backend "$TMP/nocert.log" REDIS_URL="$URL_OK" >/dev/null
sleep 6; stop_backend
check "sem a CA no Node: erro de certificado visível no log" 'grep -qiE "self.signed|unable to verify|certificate" "$TMP/nocert.log"'

# ---- 3. senha errada: erro de autenticação claro --------------------------------
start_backend "$TMP/badpass.log" REDIS_URL="rediss://default:errada@localhost:${TLS_PORT}" NODE_EXTRA_CA_CERTS="$CA" >/dev/null
sleep 6; stop_backend
check "senha errada: erro de autenticação visível no log" 'grep -qiE "WRONGPASS|invalid username-password|NOAUTH" "$TMP/badpass.log"'

# ---- 4. política de memória errada: o BullMQ avisa ------------------------------
start_backend "$TMP/lru.log" REDIS_URL="redis://localhost:${LRU_PORT}" >/dev/null
sleep 6; stop_backend
check "Redis com allkeys-lru: aviso 'Eviction policy ... should be noeviction'" 'grep -q "Eviction policy is allkeys-lru" "$TMP/lru.log"'

echo
if [ "$FAILED" -eq 0 ]; then echo "✅ $PASSED de $PASSED verificações passaram."; else echo "❌ $FAILED falharam, $PASSED passaram."; fi
[ "$FAILED" -eq 0 ]
