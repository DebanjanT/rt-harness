#!/bin/bash
# Managed MLX server wrapper: restarts automatically if the generation thread dies
# (GPU OOM on 8GB Macs — mlx never recovers on its own).
# Usage: scripts/mlx-managed.sh [model] [port]
MODEL="${1:-${MLX_MODEL:-prism-ml/Ternary-Bonsai-4B-mlx-2bit}}"
PORT="${2:-${MLX_PORT:-8080}}"
LOG="${MLX_LOG:-/tmp/mlx-server.log}"

while true; do
  echo "[mlx-managed] starting $MODEL on :$PORT"
  mlx_lm.server --model "$MODEL" --port "$PORT" \
    --prompt-cache-size 2 --max-tokens "${MLX_MAX_TOKENS:-4096}" --prefill-step-size 1024 \
    >> "$LOG" 2>&1
  CODE=$?
  # A clean kill (our own stop) exits with 0/143/130 — don't loop on those.
  if [ $CODE -eq 0 ] || [ $CODE -eq 143 ] || [ $CODE -eq 130 ]; then
    echo "[mlx-managed] exited cleanly ($CODE)"
    exit $CODE
  fi
  echo "[mlx-managed] crashed (exit $CODE) — restarting in 3s"
  sleep 3
done
