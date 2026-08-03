#!/usr/bin/env node
// テスト用の偽claude CLI: 双方向stream-jsonプロトコルを最小限模倣する
// 1通目のuserメッセージ → init + control_request(can_use_tool)
// control_response → result "done-1"
// 2通目のuserメッセージ → result "done-2"

let userCount = 0;
let buf = '';

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

process.stdin.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);

    if (msg.type === 'user') {
      userCount++;
      if (userCount === 1) {
        emit({ type: 'system', subtype: 'init', session_id: 'claude-fake-session' });
        emit({
          type: 'control_request',
          request_id: 'req-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Write',
            input: { file_path: '/tmp/x.txt' },
            permission_suggestions: [{ type: 'addRules' }],
          },
        });
      } else {
        emit({ type: 'result', result: 'done-2', is_error: false });
      }
    }

    if (msg.type === 'control_response') {
      emit({ type: 'result', result: 'done-1', is_error: false });
    }
  }
});

// stdinが閉じたら終了
process.stdin.on('end', () => process.exit(0));
