#!/bin/bash
# .env変更時に~/.config/ai-steward/envに同期+systemd再起動

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# .envファイルの場合のみ処理
if [[ "$FILE_PATH" == *".env" ]] && [[ "$FILE_PATH" != *".env.example" ]]; then
  cp "$FILE_PATH" ~/.config/ai-steward/env
  sudo systemctl restart ai-steward
  echo "ai-steward: envファイル同期+サービス再起動完了" >&2
fi

exit 0
