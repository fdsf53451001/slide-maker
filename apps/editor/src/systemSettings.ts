import { useCallback, useSyncExternalStore } from "react";

/*
 * 「這台瀏覽器的偏好」存放處。
 *
 * **這個模組目前沒有任何生產消費者**：`providerId` 與 `textEngine` 都已被專案綁定的模型組合
 * 取代，`webSearchMode` 則搬進了專案 brief（設計理由見 Editor.tsx 的 `useWebSearchToggle`，
 * 那份 JSDoc 是唯一真相）。現在只剩測試在呼叫 `resetSystemSettings()`。要不要整個刪掉留待
 * 決定——別把這段註解當成「還有人在用」的證據。
 *
 * localStorage 裡殘留的舊 `webSearchMode` 不做 migration：讀取時當成未知欄位略過，而下一次
 * `write()` 會以不含它的物件整份覆寫，那個欄位就此消失，不會留著日後被誤讀。
 */
export interface SystemSettings {
  providerId: string;
  textEngine: string;
}

const STORAGE_KEY = "slide-maker:system-settings";
const DEFAULTS: SystemSettings = {
  providerId: "mock-image",
  textEngine: "",
};

type Listener = () => void;
const listeners = new Set<Listener>();

function readStorage(): SystemSettings {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SystemSettings>;
    return {
      providerId:
        typeof parsed.providerId === "string" && parsed.providerId.trim()
          ? parsed.providerId
          : DEFAULTS.providerId,
      textEngine: typeof parsed.textEngine === "string" ? parsed.textEngine : DEFAULTS.textEngine,
    };
  } catch {
    return DEFAULTS;
  }
}

let cache: SystemSettings = readStorage();

function write(next: SystemSettings): void {
  cache = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 忽略 quota / 隱私模式寫入失敗；下次讀取會回到 DEFAULTS。
    }
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  cache = readStorage();
  listeners.forEach((listener) => listener());
}

function getSnapshot(): SystemSettings {
  return cache;
}

export function useSystemSettings(): {
  providerId: string;
  textEngine: string;
  setProviderId: (value: string) => void;
  setTextEngine: (value: string) => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setProviderId = useCallback((value: string) => {
    write({ ...cache, providerId: value });
  }, []);
  const setTextEngine = useCallback((value: string) => {
    write({ ...cache, textEngine: value });
  }, []);
  return {
    providerId: snapshot.providerId,
    textEngine: snapshot.textEngine,
    setProviderId,
    setTextEngine,
  };
}

export function resetSystemSettings(): void {
  write(DEFAULTS);
}
