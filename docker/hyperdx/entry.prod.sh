#!/bin/bash

export FRONTEND_URL="${FRONTEND_URL:-${HYPERDX_APP_URL:-http://localhost}:${HYPERDX_APP_PORT:-8080}}"
export OPAMP_PORT=${HYPERDX_OPAMP_PORT:-4320}

# Set to "REQUIRED_AUTH" to enforce API authentication.
# ⚠️ Do not change this value !!!!
export IS_LOCAL_APP_MODE="REQUIRED_AUTH"

echo ""
echo "Visit the HyperDX UI at $FRONTEND_URL"
echo ""

# HYPERDX_SERVICES 可以包含: api,app,check-alerts (逗号分隔)
HYPERDX_SERVICES=${HYPERDX_SERVICES:-"api,app,check-alerts"}

# 使用字符串代替数组，更兼容
commands=""
names=""

# 检查是否启用 API
if [[ "$HYPERDX_SERVICES" == *"api"* ]]; then
  commands="${commands} \"PORT=${HYPERDX_API_PORT:-8000} HYPERDX_APP_PORT=${HYPERDX_APP_PORT:-8080} node -r ./packages/api/tracing ./packages/api/index\""
  names="${names}API"
fi

# 检查是否启用 APP
if [[ "$HYPERDX_SERVICES" == *"app"* ]]; then
  commands="${commands} \"cd ./packages/app/packages/app && HOSTNAME='0.0.0.0' HYPERDX_API_PORT=${HYPERDX_API_PORT:-8000} PORT=${HYPERDX_APP_PORT:-8080} node server.js\""
  # 添加分隔符
  if [ -n "$names" ]; then
    names="${names},"
  fi
  names="${names}APP"
fi

# 检查是否启用 check-alerts
if [[ "$HYPERDX_SERVICES" == *"check-alerts"* ]]; then
  commands="${commands} \"node -r ./packages/api/tracing ./packages/api/tasks/index check-alerts\""
  # 添加分隔符
  if [ -n "$names" ]; then
    names="${names},"
  fi
  names="${names}ALERT-TASK"
fi

if [ -z "$commands" ]; then
  echo "No services specified in HYPERDX_SERVICES. Available: api,app,check-alerts"
  exit 1
fi

echo "Starting services: $names"
echo "Commands: $commands"

# 构建完整命令并使用 exec 替换进程
# 如果使用 eval 启动，则 shell 不会将信号传递给子进程
# 不要使用 nx 启动, nx 收到 control-c 后会立即关闭。
if [ "$names" = "ALERT-TASK" ]; then
  echo "Running single alert-task directly"
  exec node ./packages/api/tasks/index check-alerts
else
  # 多服务时使用 concurrently
  cmd="npx concurrently --kill-others --names=\"$names\"$commands"
  echo "Executing with concurrently: $cmd"
  exec sh -c "$cmd"
fi