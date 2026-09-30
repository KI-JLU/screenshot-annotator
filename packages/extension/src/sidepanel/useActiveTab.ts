import { useEffect, useState } from "preact/hooks";

export interface ActiveTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
}

/** Follows the active tab of the window hosting this side panel. */
export function useActiveTab(): ActiveTab | null {
  const [tab, setTab] = useState<ActiveTab | null>(null);

  useEffect(() => {
    let windowId: number | undefined;
    let disposed = false;

    const refresh = async () => {
      if (windowId === undefined) return;
      const [t] = await chrome.tabs.query({ active: true, windowId });
      if (disposed) return;
      if (!t?.id) {
        setTab(null);
        return;
      }
      const next: ActiveTab = { id: t.id, windowId: t.windowId, url: t.url ?? t.pendingUrl ?? "", title: t.title ?? "" };
      setTab((prev) =>
        prev && prev.id === next.id && prev.url === next.url && prev.title === next.title ? prev : next,
      );
    };

    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (info.windowId === windowId) void refresh();
    };
    const onUpdated = (_id: number, change: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) => {
      if (t.active && t.windowId === windowId && (change.url || change.title || change.status === "complete")) {
        void refresh();
      }
    };
    const onRemoved = () => void refresh();

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    void chrome.windows.getCurrent().then((w) => {
      windowId = w.id;
      void refresh();
    });
    return () => {
      disposed = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
  }, []);

  return tab;
}
