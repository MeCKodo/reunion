import * as React from "react";

// macOS 下 Electron 把窗口标题栏隐藏后（titleBarStyle: "hiddenInset"），
// 默认整个 webview 区域都不再是窗口拖拽区。需要在前端给"看起来像标题栏"
// 的容器显式声明 -webkit-app-region: drag，并把内部的按钮 / 输入控件标
// 记为 no-drag，避免吃掉点击事件。
//
// 这里抽出统一的 hook 让 Sidebar / SessionView 等组件复用：
// - `enabled`：当前是否在 macOS 的 Electron 中（非 Electron / 非 Mac 时，
//   返回的 style 都是 undefined，避免给浏览器渲染上无意义的属性）。
// - `dragStyle` / `noDragStyle`：直接挂到 React `style` 属性上。
// - `topInset`：左上角红绿灯按钮需要的安全区高度，避免内容跟交通灯重叠。
// - `leftInset`：sidebar 顶部需要给红绿灯让出来的水平空间。

const DRAG_STYLE: React.CSSProperties = {
  WebkitAppRegion: "drag",
} as React.CSSProperties;

const NO_DRAG_STYLE: React.CSSProperties = {
  WebkitAppRegion: "no-drag",
} as React.CSSProperties;

export interface ElectronDragHandles {
  enabled: boolean;
  dragStyle: React.CSSProperties | undefined;
  noDragStyle: React.CSSProperties | undefined;
}

export function useElectronDrag(): ElectronDragHandles {
  const [enabled, setEnabled] = React.useState(false);
  React.useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator.userAgent;
    setEnabled(/Macintosh/i.test(ua) && /Electron/i.test(ua));
  }, []);

  return {
    enabled,
    dragStyle: enabled ? DRAG_STYLE : undefined,
    noDragStyle: enabled ? NO_DRAG_STYLE : undefined,
  };
}
