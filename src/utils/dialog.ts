import { DialogPlugin } from 'tdesign-react';

// tdesign-react v1.18 的 DialogPlugin.confirm 返回的是「对话框节点对象」，
// 并不是一个 Promise（见 node_modules/tdesign-react/es/dialog/plugin.js）。
// 因此 `await DialogPlugin.confirm(...)` 会直接拿到一个 truthy 对象、永不进入
// `if (!confirmed) return`，导致删除等操作不等人确认就执行；而 `.then()` 更会因
// `undefined` 直接抛错。
//
// 另一个坑：plugin 模式的 Dialog 处于 isPlugin 状态，确认/取消/点 X 只触发回调，
// 不会自动销毁自己（见 Dialog.js 中 `if (isPlugin) return`）。所以必须手动调用
// 返回节点的 `.destroy()` 才能真正关掉弹窗，否则会「关不掉」。
export function confirmDialog(options: {
  header: string;
  body: string;
  confirmText?: string;
  cancelText?: string;
  theme?: 'default' | 'info' | 'warning' | 'danger';
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let node: { destroy: () => void };
    node = DialogPlugin.confirm({
      header: options.header,
      body: options.body,
      theme: options.theme ?? 'warning',
      confirmBtn: { content: options.confirmText ?? '确定', theme: 'danger' },
      cancelBtn: { content: options.cancelText ?? '取消' },
      // 点确认 -> true；取消 / 点 X / 按 ESC 关闭 -> false。
      // 每次回调都显式 destroy，确保弹窗真正关闭。
      onConfirm: () => {
        node.destroy();
        resolve(true);
      },
      onClose: () => {
        node.destroy();
        resolve(false);
      },
      onCancel: () => {
        node.destroy();
        resolve(false);
      },
    });
  });
}
