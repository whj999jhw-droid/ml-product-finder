import { DialogPlugin } from 'tdesign-react';

// tdesign-react v1.18 的 DialogPlugin.confirm 返回的是「对话框节点对象」，
// 并不是一个 Promise（见 node_modules/tdesign-react/es/dialog/plugin.js）。
// 因此 `await DialogPlugin.confirm(...)` 会直接拿到一个 truthy 对象、永不进入
// `if (!confirmed) return`，导致删除等操作不等人确认就执行；而 `.then()` 更会因
// `undefined` 直接抛错。这里用回调包一层，提供一个真正可用的 Promise 版本。
export function confirmDialog(options: {
  header: string;
  body: string;
  confirmText?: string;
  cancelText?: string;
  theme?: 'default' | 'info' | 'warning' | 'danger';
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    DialogPlugin.confirm({
      header: options.header,
      body: options.body,
      theme: options.theme ?? 'warning',
      confirmBtn: { content: options.confirmText ?? '确定', theme: 'danger' },
      cancelBtn: { content: options.cancelText ?? '取消' },
      // 点确认 -> true；取消 / 点 X / 按 ESC 关闭 -> false。
      // Promise 只会 resolve 一次，确认后即便又触发 onClose 也不会覆盖。
      onConfirm: () => resolve(true),
      onClose: () => resolve(false),
      onCancel: () => resolve(false),
    });
  });
}
