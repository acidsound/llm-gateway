# llm-gateway

복수 개의 **OpenAI 호환 API 엔드포인트**(Cerebras, Groq, Together 등)를 하나의 단일 엔드포인트로 통합하고, rate limit 을 피해 가용한 키로 라우팅하는 프록시입니다.

백엔드는 프록시를 **하나의 OpenAI 호환 엔드포인트**로 보면 됩니다. 프록시가 내부적으로 ① 호출자의 모델명에 따라 provider 를 선택하고, ② 해당 provider 의 가용 키를 골라 rate limit 을 관리합니다.

```
┌──────────┐  base_url=http://localhost:8787/v1   ┌────────────────────────┐   ┌──────────────────────┐
│  백엔드    │ ──────────────────────────────────▶ │  llm-gateway (8787)     │──▶│ Cerebras (키 1..N)    │
│ (OpenAI   │   model: "chat-fast"                │  - 모델명 → provider 라우팅│  ├──────────────────────┤
│  SDK)     │ ◀────────────────────────────────── │  - 키 로테이션            │──▶│ Groq (키 1..N)        │
└──────────┘    단일 OpenAI 호환 응답              │  - rate limit 관리        │  ├──────────────────────┤
                                                 │  - provider fallback     │──▶│ ... 다른 provider     │
                                                 └────────────────────────┘   └──────────────────────┘
```

## 주요 기능

- **단일 OpenAI 호환 엔드포인트** — `/v1/*` 경로 그대로 프록시. `chat/completions`, `completions`, `embeddings` 지원. 백엔드는 `base_url` 만 바꾸면 됩니다.
- **모델명 기반 라우팅** — 호출자의 `model` 필드가 어떤 provider 의 어떤 모델로 갈지 `routes` 로 정의. provider 마다 모델명이 달라도 **호출자 모델명을 provider 실제 모델명으로 재작성**해서 전달.
- **`/v1/models` 카탈로그 합성** — 라우트 가능한 모델명만 반환. 호출자는 프록시가 제공하는 모델명만 쓰면 됩니다.
- **키 로테이션** — provider 내에서 **가장 여유 있는 키**(RPM/TPM 사용률 기준) 선택, 실패 시 다음 키로 자동 재시도.
- **Rate limit 관리 (모델별)**
  - 60초 슬라이딩 윈도우로 **(키, 모델)별** 요청 수(RPM)와 대략적 토큰 수(TPM) 추적 — rate limit 은 provider·모델마다 다름
  - 429 응답 시 `retry-after` 존중 cooldown, 없으면 지수 백오프. **429 는 해당 (키, 모델)만** cooldown
  - 5xx/네트워크 오류는 모델과 무관한 장애이므로 **키 전체** cooldown
  - 응답의 `x-ratelimit-remaining-*` 헤더 관찰로 남은 할당량 0이면 미리 cooldown
  - 모든 키가 소진되면 클라이언트에 429 + `Retry-After` 반환
- **Provider fallback** — primary provider 의 키가 전부 소진/장애면 라우트에 정의된 fallback provider 로 전환.
- **장애 처리** — 429/5xx/네트워크 오류는 다른 키로 재시도, **401(무효 키)은 영구 제외**(재시작 시 복구), 4xx(클라이언트 오류)는 키를 소모하지 않고 그대로 전달.
- **스트리밍(SSE) 지원** — `stream: true` 응답을 그대로 파이프. 클라이언트 연결이 끊기면 업스트림도 중단.
- **운영용 엔드포인트** — `/health`(probe 용), `/stats`(provider·키·모델별 상세, ADMIN_TOKEN 보호).
- **제로 의존성** — Node.js 내장 모듈만. `npm install` 불필요.

## 요구사항

- Node.js 18.17 이상 (20+ 권장)

## 빠른 시작

### 1. 설정 (config.json)

`config.json`(프로젝트 루트, `.gitignore` 포함)을 만듭니다. `.gitignore` 에 포함되므로 실제 키가 커밋되지 않습니다.

```json
{
  "port": 8787,
  "requestTimeoutMs": 300000,
  "adminToken": "your-ops-token",
  "upstreams": [
    {
      "name": "cerebras",
      "baseUrl": "https://api.cerebras.ai/v1",
      "models": ["gemma-4-31b", "gpt-oss-120b", "zai-glm-4.7"],
      "keys": [
        { "name": "primary", "apiKey": "csk-XXX", "rpm": 5, "tpm": 30000 },
        { "name": "backup-1", "apiKey": "csk-YYY", "rpm": 5, "tpm": 30000 }
      ]
    },
    {
      "name": "groq",
      "baseUrl": "https://api.groq.com/openai/v1",
      "models": ["llama-3.3-70b-versatile"],
      "keys": [
        { "name": "groq-1", "apiKey": "gsk-ZZZ", "rpm": 30, "tpm": 20000 }
      ]
    }
  ],
  "routes": {
    "chat-fast": { "upstream": "cerebras", "model": "gemma-4-31b" },
    "llama-70b": {
      "upstream": "groq",
      "model": "llama-3.3-70b-versatile",
      "fallback": { "upstream": "cerebras", "model": "gpt-oss-120b" }
    }
  }
}
```

**라우팅 규칙:**
- `upstreams[].models` 에 나열된 모델은 **자동으로 동일 이름 라우트**가 생성됩니다(호출자 모델명 = provider 모델명). 예: `"gemma-4-31b"` → cerebras 의 `gemma-4-31b`.
- `routes` 에 명시한 항목이 우선입니다. 자동 라우트를 덮어쓰거나 **별칭**(`chat-fast` → cerebras/`gemma-4-31b`)을 추가할 수 있습니다.
- `routes` 값 형식: `"provider/model"` 문자열 또는 `{ "upstream", "model", "fallback"? }`.
- 라우트에 없는 모델명으로 요청이 오면 `400` 과 함께 사용 가능한 모델 목록을 반환합니다.

**레거시 형식**(단일 provider, `upstreamBaseUrl` + `keys`)도 그대로 동작합니다. `config.example.legacy.json` 참고.

### 2. 실행

```bash
node server.js
```

### 3. 백엔드 연동

백엔드는 OpenAI SDK 의 `base_url` 만 바꾸면 됩니다. `api_key` 는 아무 값이나 가능합니다(프록시가 자체 키를 사용). 호출 모델명은 `/v1/models` 로 확인할 수 있습니다.

**Python**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key="anything",
)

resp = client.chat.completions.create(
    model="chat-fast",           # 프록시 라우트의 모델명
    messages=[{"role": "user", "content": "안녕"}],
    stream=True,                  # 스트리밍 그대로 동작
)
```

**Node.js**

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8787/v1',
  apiKey: 'anything',
});
```

## 설정

### upstreams

| 필드 | 설명 |
|---|---|
| `name` | provider 식별자 (라우트/로그/헤더에 사용) |
| `baseUrl` | OpenAI 호환 베이스 URL (예: `https://api.cerebras.ai/v1`) |
| `models` | 이 provider 가 제공하는 모델 목록. 여기서 자동 라우트가 생성됨 |
| `keys[]` | 키 목록. 각 키: `name`, `apiKey`, `rpm`, `tpm`, `limits`(모델별 오버라이드) |

### routes

| 형식 | 의미 |
|---|---|
| `"cerebras/gemma-4-31b"` | `upstream` + `/` + `model` |
| `{ "upstream": "cerebras", "model": "gemma-4-31b" }` | 위와 동일 |
| `{ ..., "fallback": { "upstream": "groq", "model": "llama-..." } }` | primary provider 소진 시 fallback |

### 모델별 rate limit (키의 `limits`)

rate limit 이 모델마다 다르면 키별로 지정할 수 있습니다. 미지정 모델은 키의 `rpm`/`tpm` 사용.

```json
{
  "name": "primary",
  "apiKey": "csk-XXX",
  "rpm": 30,
  "tpm": 30000,
  "limits": {
    "gemma-4-31b": { "rpm": 30, "tpm": 30000 },
    "gpt-oss-120b": { "rpm": 15, "tpm": 20000 }
  }
}
```

> 실제 한도는 응답의 `x-ratelimit-limit-*` 헤더로 확인할 수 있습니다(프록시가 그대로 전달). 부정확해도 동작에는 문제없고(429가 나면 자동 cooldown), 정확할수록 부하 분산이 좋아집니다.

### 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8787` | 리슨 포트 |
| `REQUEST_TIMEOUT_MS` | `300000` | 비스트리밍 요청 타임아웃 (스트리밍 무제한) |
| `ADMIN_TOKEN` | 없음 | `/stats` 보호 (`Authorization: Bearer <token>` 또는 `?token=`) |
| `CONFIG_PATH` | `./config.json` | 설정 파일 경로 |
| `ROUTES_FILE` | `./routes.json` | 런타임 라우트 영속화 파일 (관리 API 변경분) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `UPSTREAM_KEYS` / `UPSTREAM_BASE_URL` | — | **레거시 형식**에서만 사용 (쉼표 구분 키 목록 / 베이스 URL) |

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` | OpenAI 호환 요청 (모델명 → provider 라우팅, 키 로테이션) |
| `GET` | `/v1/models` | 라우트 가능한 모델 카탈로그 (프록시가 합성, 실시간 반영) |
| `GET` | `/health` | provider·키 상태 요약. 가용 키 0개면 503 |
| `GET` | `/stats` | provider별 키·모델 상세 상태 + 현재 라우트 (ADMIN_TOKEN 필요 시) |

응답에 `x-proxy-key: <provider>/<key>` 헤더로 **어느 provider 의 어느 키가 응답했는지** 표시됩니다.

## 라우트 관리 API (동적)

라우트는 `config.json` 대신 **관리 API로 런타임에 추가/수정/삭제**할 수 있습니다. 변경 사항은 `routes.json`(`ROUTES_FILE`)에 영속화되어 **재시작 후에도 유지**됩니다. 재시작 시 라우트 로드 순서: `config.json`의 라우트/모델 자동 라우트를 기본으로, `routes.json`의 항목이 동일 이름을 덮어씁니다.

> `ADMIN_TOKEN`이 설정된 경우 모든 요청에 `Authorization: Bearer <token>` 헤더(또는 `?token=`)가 필요합니다. 토큰 미설정 시 경고 로그와 함께 인증 없이 열립니다 — 운영에서는 반드시 설정하세요.

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/admin/routes` | 현재 라우트 + 사용 가능한 모델 목록 |
| `PUT` | `/admin/routes/:model` | 라우트 추가/수정 (body: `"provider/model"` 또는 `{ upstream, model, fallback? }`) |
| `DELETE` | `/admin/routes/:model` | 라우트 제거 |

```bash
# 라우트 추가: 별칭 chat-fast -> cerebras의 gemma-4-31b (fallback 포함)
curl -X PUT http://localhost:8787/admin/routes/chat-fast \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <ADMIN_TOKEN>' \
  -d '{"upstream": "cerebras", "model": "gemma-4-31b", "fallback": "groq/llama-3.3-70b-versatile"}'

# 라우트 목록 확인 (GET) / 제거 (DELETE)
curl http://localhost:8787/admin/routes
curl -X DELETE http://localhost:8787/admin/routes/chat-fast
```

- 추가/수정/삭제 즉시 `/v1/models` 와 라우팅에 반영됩니다.
- `routes.json` 에는 config 기준선(baseline)과 **다른 변경분만** 저장됩니다. 변경 없이 config 와 동일한 라우트는 저장되지 않으므로, config 의 `models` 목록을 바꾸면 stale 라우트가 남지 않습니다.
- **삭제도 영속화됩니다.** config 의 자동 라우트를 API 로 삭제하면 tombstone 으로 저장되어 재시작 후에도 삭제 상태가 유지됩니다. 되살리려면 같은 이름으로 PUT 하거나 `routes.json` 에서 해당 항목을 지우세요.
- 존재하지 않는 provider 를 참조하는 라우트는 400 으로 거부됩니다.

## 동작 방식

1. 요청의 `model` 필드로 라우트를 결정합니다. 라우트에 없으면 400.
2. 라우트의 provider 를 찾아, body 의 model 을 provider 실제 모델명으로 재작성합니다.
3. provider 의 키 풀에서 60초 윈도우 기준 **사용률이 가장 낮은** ready 키 선택 (동률이면 라운드로빈).
4. 429/5xx/네트워크 오류면 해당 키 cooldown 후 **다음 키로 재시도** (키당 요청당 1회).
5. 401 이면 키 영구 제외. 4xx(400 등)는 재시도 없이 그대로 전달.
6. provider 의 키가 전부 소진되면 **fallback provider 로 전환**.
7. 모든 provider 실패 시 `429`(+`Retry-After`) 또는 `503` 을 OpenAI 오류 형식으로 반환.
8. 스트리밍은 시작 전에만 재시도 판단, 시작 후엔 그대로 파이프.

## 운영

### Docker

```bash
docker build -t llm-gateway .
docker run -d --name llm-gateway -p 8787:8787 -v "$PWD/config.json:/app/config.json:ro" llm-gateway
```

### 모니터링

- `/health` 를 주기적으로 probe 하여 provider·키 가용성을 추적하세요.
- `/stats` 로 provider별 키의 `state`, 모델별 `utilization`, `total429s`, `total5xx` 를 확인하세요.
- `/admin/routes` 로 현재 라우팅 구성을 확인하고, 운영 중 라우트를 조정하세요.
- 로그의 `rate limited (429) on model "..."` / `permanently disabled: invalid API key (401)` / `provider "..." exhausted; trying fallback` 메시지로 이상 징후를 감지하세요.

### 주의사항

- `config.json` 에 실제 키가 있으면 `.gitignore` / `.dockerignore` 로 반드시 제외하세요(기본 포함).
- `ADMIN_TOKEN` 을 반드시 설정하세요. 미설정 시 `/admin/*` 과 `/stats` 가 인증 없이 노출됩니다(시작 시 경고 로그).
- 401 키는 프로세스 재시작 전까지 제외 상태로 남습니다. 키 교체 후 재시작하세요.
- fallback 은 primary provider 가 **완전히 소진**됐을 때만 동작합니다(부분 실패는 키 로테이션으로 처리).

## 테스트

가짜 업스트림 서버로 로테이션·스트리밍·모델별 rate limit·다중 provider 라우팅·별칭 재작성·fallback·무효 키 케이스를 검증합니다.

```bash
npm test
```

실서버 스모크 테스트: `node scripts/verify-live.js [baseUrl]`
